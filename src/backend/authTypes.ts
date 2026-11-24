/**
 * Auth contract shared by the production (Firebase Auth) and demo (in-browser) backends,
 * plus the client-side session bookkeeping (remember-me, idle timeout, sign-in throttling).
 *
 * Passwords are never handled or stored by ABCkit: production credentials are verified by Firebase Auth
 * (server-side, hashed with Firebase's scrypt variant); demo accounts use one published demo password.
 */
export interface SessionUser {
  id: string
  email: string | null
  user_metadata: { full_name?: string | null }
  app_metadata: Record<string, unknown>
  last_sign_in_at?: string
  created_at?: string
}
export interface Session {
  user: SessionUser
  access_token: string
}
export type AuthEvent = 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT' | 'PASSWORD_RECOVERY' | 'USER_UPDATED'

export interface AuthErrorShape {
  message: string
  code: string
  status: number
  name: string
}

export interface SignInArgs {
  /** email address or username */
  email: string
  password: string
  /** keep the session after the browser is closed (default true) */
  remember?: boolean
}

export interface AuthApi {
  getSession(): Promise<{ data: { session: Session | null }; error: null }>
  getUser(): Promise<{ data: { user: SessionUser | null }; error: null }>
  onAuthStateChange(cb: (event: AuthEvent, session: Session | null) => void): { data: { subscription: { unsubscribe(): void } } }
  signInWithPassword(args: SignInArgs): Promise<{ data: { user: SessionUser | null; session: Session | null }; error: AuthErrorShape | null }>
  /** scope 'global' also revokes every other session of this account on the server */
  signOut(opts?: { scope?: 'local' | 'global'; reason?: SignOutReason }): Promise<{ error: AuthErrorShape | null }>
  updateUser(args: { password?: string }): Promise<{ data: { user: SessionUser | null }; error: AuthErrorShape | null }>
  resetPasswordForEmail(email: string, opts?: { redirectTo?: string }): Promise<{ data: unknown; error: AuthErrorShape | null }>
  /** epoch ms when the current session's credentials were verified (token auth_time), null if signed out */
  getSignedInAt(): Promise<number | null>
  /** true when this backend is the browser-only demo */
  readonly isDemo: boolean
}

export type SignOutReason = 'user' | 'idle' | 'expired' | 'revoked' | 'deactivated'

export const authError = (message: string, code = 'auth/error'): AuthErrorShape => ({ message, code, status: 400, name: 'AuthError' })

/** The same message for unknown accounts and wrong passwords, so the form cannot be used to discover accounts. */
export const INVALID_CREDENTIALS = 'Invalid email/username or password'

// ----------------------------------------------------------------------------- session policy

export const SESSION_POLICY = {
  /** absolute lifetime of any session (also enforced in firestore.rules via token auth_time) */
  maxAgeMs: 30 * 24 * 3600_000,
  /** "Remember me" off: sign out after this much inactivity (and when the browser closes) */
  idleTimeoutMs: 30 * 60_000,
  /** client-side throttle: after this many failures for an identifier, wait lockoutMs */
  maxFailures: 5,
  lockoutMs: 60_000,
}

const META_KEY = 'abckit-session'
const FLASH_KEY = 'abckit-flash'
const FAIL_KEY = 'abckit-signin-failures'

export interface SessionMeta {
  remember: boolean
  lastActive: number
}

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

export function readSessionMeta(): SessionMeta | null {
  try {
    const raw = safeStorage('local')?.getItem(META_KEY)
    return raw ? (JSON.parse(raw) as SessionMeta) : null
  } catch {
    return null
  }
}
export function writeSessionMeta(meta: SessionMeta | null) {
  try {
    if (meta) safeStorage('local')?.setItem(META_KEY, JSON.stringify(meta))
    else safeStorage('local')?.removeItem(META_KEY)
  } catch {
    /* storage unavailable */
  }
}
export function touchSession() {
  const m = readSessionMeta()
  if (m) writeSessionMeta({ ...m, lastActive: Date.now() })
}

/** One-shot message shown on the login page after a reload (e.g. "You have been signed out"). */
export function setFlash(reason: SignOutReason) {
  try {
    safeStorage('session')?.setItem(FLASH_KEY, reason)
  } catch {
    /* ignore */
  }
}
export function takeFlash(): SignOutReason | null {
  try {
    const v = safeStorage('session')?.getItem(FLASH_KEY) as SignOutReason | null
    safeStorage('session')?.removeItem(FLASH_KEY)
    return v
  } catch {
    return null
  }
}

export const FLASH_MESSAGES: Record<SignOutReason, { kind: 'success' | 'info' | 'warning'; text: string }> = {
  user: { kind: 'success', text: 'You have been signed out.' },
  idle: { kind: 'info', text: 'You were signed out after 30 minutes of inactivity.' },
  expired: { kind: 'info', text: 'Your session has expired. Please sign in again.' },
  revoked: { kind: 'warning', text: 'Your sessions were ended (signed out on all devices). Please sign in again.' },
  deactivated: { kind: 'warning', text: 'Your account has been deactivated. Contact your administrator.' },
}

/** Has the stored session outlived the policy? (checked at start-up and periodically) */
export function sessionExpiry(signedInAt: number | null, meta: SessionMeta | null, now = Date.now()): SignOutReason | null {
  if (signedInAt && now - signedInAt > SESSION_POLICY.maxAgeMs) return 'expired'
  if (meta && !meta.remember && now - meta.lastActive > SESSION_POLICY.idleTimeoutMs) return 'idle'
  return null
}

// ----------------------------------------------------------------------------- sign-in throttling (UX layer;
// the real brute-force protection is Firebase Auth's server-side throttling, which returns auth/too-many-requests)

interface FailureState {
  count: number
  until: number
  /** time of the last failure; the count resets after 15 quiet minutes */
  last: number
}
function readFailures(): Record<string, FailureState> {
  try {
    return JSON.parse(safeStorage('local')?.getItem(FAIL_KEY) ?? '{}')
  } catch {
    return {}
  }
}
function writeFailures(v: Record<string, FailureState>) {
  try {
    safeStorage('local')?.setItem(FAIL_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}
const idKey = (identifier: string) => identifier.trim().toLowerCase()

/** ms until this identifier may try again (0 = allowed) */
export function lockoutRemaining(identifier: string, now = Date.now()) {
  const f = readFailures()[idKey(identifier)]
  return f && f.until > now ? f.until - now : 0
}
export function recordFailure(identifier: string, now = Date.now()) {
  const all = readFailures()
  const k = idKey(identifier)
  const cur = all[k] && now - (all[k].last ?? 0) < 15 * 60_000 ? all[k] : { count: 0, until: 0, last: 0 }
  const count = cur.count + 1
  // 5 failures → 1 min, every further failure doubles the wait (max 15 min)
  const until = count >= SESSION_POLICY.maxFailures ? now + Math.min(SESSION_POLICY.lockoutMs * 2 ** (count - SESSION_POLICY.maxFailures), 15 * 60_000) : 0
  all[k] = { count, until, last: now }
  writeFailures(all)
  return { count, lockedForMs: until ? until - now : 0 }
}
export function clearFailures(identifier: string) {
  const all = readFailures()
  delete all[idKey(identifier)]
  writeFailures(all)
}

/** Password policy for new passwords (own change, reset link, admin-set). Mirrors functions/src/index.ts. */
export function newPasswordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.'
  if (pw.length > 128) return 'Password is too long (max 128 characters).'
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Include both letters and numbers.'
  return null
}

/** 14 random characters from an unambiguous alphabet, always containing letters and digits. */
export function generatePassword(length = 14): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const all = letters + digits
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint32Array(length))
    const pw = Array.from(bytes, (b) => all[b % all.length]).join('')
    if (!newPasswordProblem(pw)) return pw
  }
}

export function validateSignIn(identifier: string, password: string): string | null {
  const id = identifier.trim()
  if (!id) return 'Enter your email address or username.'
  if (id.length > 254) return 'That email or username is too long.'
  if (id.includes('@')) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) return 'Enter a valid email address.'
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/.test(id)) return 'Usernames are 3–30 letters, digits, dots, dashes or underscores.'
  if (!password) return 'Enter your password.'
  if (password.length > 256) return 'Password is too long.'
  return null
}
