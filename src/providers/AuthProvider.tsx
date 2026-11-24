import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { readSessionMeta, sessionExpiry, touchSession, type SignOutReason } from '@/backend/authTypes'
import { db, unwrap, type Session } from '@/lib/backend'
import type { CompanySettings, Profile } from '@/lib/types'
import { setDefaultCurrency } from '@/lib/utils'

interface AuthContextValue {
  session: Session | null
  loading: boolean
  profile: Profile | null
  permissions: Set<string>
  settings: CompanySettings | null
  can: (perm: string) => boolean
  canAny: (...perms: string[]) => boolean
  isSuperAdmin: boolean
  /** true in the browser-only Demo Mode */
  isDemo: boolean
  /** sign out on this device (clears tokens + offline cache, back to the login page) */
  signOut: (reason?: SignOutReason) => Promise<void>
  /** revoke every session of this account on the server, then sign out here */
  signOutEverywhere: () => Promise<string | null>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)

  useEffect(() => {
    db.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionLoading(false)
    })
    const { data: sub } = db.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'SIGNED_OUT') qc.clear()
    })
    return () => sub.subscription.unsubscribe()
  }, [qc])

  const userId = session?.user.id

  const profileQ = useQuery({
    queryKey: ['me', userId],
    enabled: !!userId,
    staleTime: 60_000,
    // re-check periodically so deactivation / "sign out of all devices" reaches open sessions
    refetchInterval: 2 * 60_000,
    queryFn: async () => {
      const profile = unwrap(
        await db.from('profiles').select('*, role:roles(id,key,name)').eq('id', userId!).maybeSingle(),
      ) as Profile | null
      const perms = profile?.is_active ? (unwrap(await db.rpc('my_permissions')) as string[]) : []
      return { profile, perms }
    },
  })

  const settingsQ = useQuery({
    queryKey: ['company_settings'],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await db.from('company_settings').select('*').eq('id', 1).single()) as CompanySettings,
  })

  useEffect(() => {
    if (settingsQ.data) setDefaultCurrency(settingsQ.data.default_currency)
  }, [settingsQ.data])

  // presence heartbeat for session management (last seen)
  useEffect(() => {
    if (!userId || !profileQ.data?.profile?.is_active) return
    const beat = () => db.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', userId)
    void beat()
    const t = setInterval(beat, 5 * 60_000)
    return () => clearInterval(t)
  }, [userId, profileQ.data?.profile?.is_active])

  // Once a day per device, generate overdue-task reminders (idempotent server-side; pg_cron can do this instead)
  useEffect(() => {
    if (!userId || !profileQ.data?.profile?.is_active) return
    const key = 'abckit-overdue-check'
    const day = new Date().toISOString().slice(0, 10)
    try {
      if (localStorage.getItem(key) === day) return
      localStorage.setItem(key, day)
    } catch {
      /* storage unavailable: still run */
    }
    void db.rpc('notify_overdue_tasks')
  }, [userId, profileQ.data?.profile?.is_active])

  const permissions = useMemo(() => new Set(profileQ.data?.perms ?? []), [profileQ.data])
  const profile = profileQ.data?.profile ?? null
  const isSuperAdmin = profile?.role?.key === 'super_admin' && profile.is_active
  const can = useCallback((perm: string) => isSuperAdmin || permissions.has(perm), [permissions, isSuperAdmin])
  const canAny = useCallback((...perms: string[]) => perms.some((p) => can(p)), [can])

  const signOut = useCallback(
    async (reason: SignOutReason = 'user') => {
      qc.clear()
      await db.auth.signOut({ reason })
    },
    [qc],
  )

  const signOutEverywhere = useCallback(async () => {
    qc.clear()
    const { error } = await db.auth.signOut({ scope: 'global' })
    return error?.message ?? null
  }, [qc])

  // ---- session expiry: absolute lifetime (30 days) + inactivity timeout when "Remember me" was off
  useEffect(() => {
    if (!userId) return
    let stopped = false
    const check = async () => {
      const reason = sessionExpiry(await db.auth.getSignedInAt(), readSessionMeta())
      if (reason && !stopped) {
        stopped = true
        void signOut(reason)
      }
    }
    void check()
    const t = setInterval(() => void check(), 30_000)
    let last = 0
    const activity = () => {
      const now = Date.now()
      if (now - last < 15_000) return
      last = now
      touchSession()
    }
    const onVisible = () => document.visibilityState === 'visible' && void check()
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, activity, { passive: true }))
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearInterval(t)
      events.forEach((e) => window.removeEventListener(e, activity))
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [userId, signOut])

  // ---- server-side revocation ("sign out of all devices" / admin force sign-out) reaching this device
  const revocationQ = useQuery({
    queryKey: ['session_revocations', userId],
    enabled: !!userId && !!profileQ.data?.profile?.is_active,
    refetchInterval: 2 * 60_000,
    queryFn: async () => unwrap(await db.from('session_revocations').select('at').eq('user_id', userId!).maybeSingle()) as { at: string } | null,
  })
  const revokedAt = revocationQ.data?.at
  useEffect(() => {
    if (!userId || !revokedAt) return
    void db.auth.getSignedInAt().then((at) => {
      const revoked = Date.parse(revokedAt)
      if (at && Number.isFinite(revoked) && at < revoked) void signOut('revoked')
    })
  }, [userId, revokedAt, signOut])

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] })
    await qc.invalidateQueries({ queryKey: ['company_settings'] })
  }, [qc])

  const value: AuthContextValue = {
    session,
    loading: sessionLoading || (!!userId && profileQ.isLoading),
    profile,
    permissions,
    settings: settingsQ.data ?? null,
    can,
    canAny,
    isSuperAdmin,
    isDemo: db.auth.isDemo,
    signOut,
    signOutEverywhere,
    refresh,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
