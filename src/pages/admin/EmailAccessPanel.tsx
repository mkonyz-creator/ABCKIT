/**
 * User Management → Email access: give ONE user access to the company mailbox (info@aricom.tz) features on top of
 * their role — read & draft (ai.email), approve & send (ai.email_send), manage the mailbox connection (ai.manage).
 * Saved by the adminUsers function (action 'set_access') into user_access/{uid}, audited; enforced by
 * firestore.rules (aiPerm) and every AI Cloud Function (requireCaller). Role-based access stays in Roles & permissions.
 */
import { Mail, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Avatar, Badge, Card, Spinner } from '@/components/ui/misc'
import { db } from '@/lib/backend'
import { useInvalidate, useList } from '@/lib/hooks'
import type { Profile, Role } from '@/lib/types'
import { errorMessage } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AI_COLLECTIONS as C, AI_PERMS, grantedPerms, normalizeUserGrant, type UserAccess } from '@/shared/ai/contract'

const COLUMNS = [
  { perm: AI_PERMS.email, label: 'Read & draft replies', hint: 'Read company email, AI summaries, prepare English / Kiswahili reply drafts' },
  { perm: AI_PERMS.send, label: 'Approve & send', hint: 'Approve AI reply drafts and send them from the company mailbox' },
  { perm: AI_PERMS.manage, label: 'Manage mailbox', hint: 'Connect / disconnect the mailbox, sync settings, AI Control Center' },
] as const

export function EmailAccessPanel({ users, roles }: { users: Profile[] | undefined; roles: Role[] }) {
  const { profile: me, refresh } = useAuth()
  const invalidate = useInvalidate()
  const grants = useList<UserAccess>(C.userAccess)
  const perms = useList<{ id: string; key: string }>('permissions')
  const rp = useList<{ role_id: string; permission_id: string }>('role_permissions')
  const [saving, setSaving] = useState<string | null>(null)

  const rolePerms = useMemo(() => {
    const keyOf = new Map((perms.data ?? []).map((p) => [p.id, p.key]))
    const m = new Map<string, Set<string>>()
    for (const x of rp.data ?? []) {
      // permission documents are keyed by the permission key; the lookup only guards against other ids
      const key = keyOf.get(x.permission_id) ?? x.permission_id
      m.set(x.role_id, (m.get(x.role_id) ?? new Set()).add(key))
    }
    return m
  }, [perms.data, rp.data])
  const grantOf = useMemo(() => new Map((grants.data ?? []).map((g) => [g.id, new Set<string>(grantedPerms(g))])), [grants.data])
  const roleName = useMemo(() => new Map(roles.map((r) => [r.id, r.name])), [roles])
  const active = (users ?? []).filter((u) => u.is_active)

  const toggle = async (u: Profile, perm: string, on: boolean) => {
    const current = grantOf.get(u.id) ?? new Set<string>()
    const next = new Set([...current].filter((p) => p !== AI_PERMS.view))
    if (on) next.add(perm)
    else {
      next.delete(perm)
      // sending requires email access
      if (perm === AI_PERMS.email) next.delete(AI_PERMS.send)
    }
    setSaving(`${u.id}:${perm}`)
    try {
      const { data, error } = await db.functions.invoke('admin-users', { body: { action: 'set_access', user_id: u.id, perms: normalizeUserGrant([...next]) } })
      if (error || data?.error) throw error ?? new Error(data.error)
      toast.success(`Email access updated for ${u.full_name}`)
      await invalidate(C.userAccess)
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(null)
    }
  }

  if (grants.isLoading || perms.isLoading || rp.isLoading || !users) return <Spinner />
  return (
    <Card className="overflow-hidden">
      <div className="space-y-1 border-b border-border px-4 py-3 text-sm text-muted">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          <Mail className="size-4" /> Company mailbox access (info@aricom.tz)
        </p>
        <p>
          Give individual users access to email intelligence on top of their role. Every change takes effect immediately on the server, is recorded in the audit log, and includes access to the AI page. Access a
          role already gives is shown as <Badge>role</Badge> — change it in <em>Roles &amp; permissions</em>. No reply is ever sent without someone holding <strong>Approve &amp; send</strong> pressing <em>Approve &amp; Send</em>.
        </p>
      </div>
      {grants.error ? (
        <p className="px-4 py-6 text-sm text-danger">{errorMessage(grants.error)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-4 py-2 font-semibold">User</th>
                {COLUMNS.map((c) => (
                  <th key={c.perm} className="px-2 py-2 text-center font-semibold" title={c.hint}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {active.map((u) => {
                const isSuper = u.role_id === 'super_admin'
                const fromRole = rolePerms.get(u.role_id) ?? new Set<string>()
                const own = grantOf.get(u.id) ?? new Set<string>()
                const self = u.id === me?.id
                return (
                  <tr key={u.id} className="hover:bg-surface-2/50">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={u.full_name} src={u.avatar_url} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {u.full_name} {self && <Badge>you</Badge>}
                          </p>
                          <p className="truncate text-xs text-muted">{roleName.get(u.role_id) ?? u.role_id}</p>
                        </div>
                      </div>
                    </td>
                    {COLUMNS.map((c) => {
                      const viaRole = isSuper || fromRole.has(c.perm)
                      const checked = viaRole || own.has(c.perm)
                      const busy = saving === `${u.id}:${c.perm}`
                      return (
                        <td key={c.perm} className="px-2 py-2 text-center">
                          {viaRole ? (
                            <span className="inline-flex items-center gap-1 text-xs text-muted" title="Given by the user's role">
                              <ShieldCheck className="size-4 text-success" /> role
                            </span>
                          ) : busy ? (
                            <Spinner />
                          ) : (
                            <input
                              type="checkbox"
                              className="size-4 accent-[var(--accent)]"
                              checked={checked}
                              disabled={self || saving !== null}
                              title={self ? 'You cannot change your own access' : c.hint}
                              onChange={(e) => toggle(u, c.perm, e.target.checked)}
                              aria-label={`${u.full_name}: ${c.label}`}
                            />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-border px-4 py-2.5 text-xs text-muted">Only active users are listed. Deactivating a user removes all access immediately, including access given here.</p>
    </Card>
  )
}
