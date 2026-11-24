import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearFailures,
  INVALID_CREDENTIALS,
  lockoutRemaining,
  readSessionMeta,
  recordFailure,
  SESSION_POLICY,
  sessionExpiry,
  setFlash,
  takeFlash,
  validateSignIn,
} from './authTypes'
import { createDemoDb } from './demo'
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from './mode'
import { createTestDb, ok } from './testing'

// minimal Web Storage for the node test environment
class MemStorage {
  m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v))
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  clear() {
    this.m.clear()
  }
}
const g = globalThis as any
beforeEach(() => {
  g.window = g
  g.localStorage = new MemStorage()
  g.sessionStorage = new MemStorage()
})

describe('sign-in input validation', () => {
  it('accepts emails and usernames, rejects malformed input', () => {
    expect(validateSignIn('pm@company.co.tz', 'x')).toBeNull()
    expect(validateSignIn('demo.pm', 'x')).toBeNull()
    expect(validateSignIn('', 'x')).toMatch(/email address or username/)
    expect(validateSignIn('not an email@', 'x')).toMatch(/valid email/)
    expect(validateSignIn('a', 'x')).toMatch(/Usernames are 3–30/)
    expect(validateSignIn('<script>', 'x')).toMatch(/Usernames/)
    expect(validateSignIn('pm@company.co.tz', '')).toMatch(/Enter your password/)
    expect(validateSignIn('pm@company.co.tz', 'x'.repeat(300))).toMatch(/too long/)
  })
})

describe('sign-in throttling', () => {
  it('locks an identifier after repeated failures, with growing waits, and clears on success', () => {
    const now = 1_000_000
    for (let i = 1; i < SESSION_POLICY.maxFailures; i++) expect(recordFailure('PM@x.com', now).lockedForMs).toBe(0)
    expect(recordFailure('pm@x.com', now).lockedForMs).toBe(SESSION_POLICY.lockoutMs)
    expect(lockoutRemaining('pm@x.com', now + 1000)).toBe(SESSION_POLICY.lockoutMs - 1000)
    expect(recordFailure('pm@x.com', now).lockedForMs).toBe(SESSION_POLICY.lockoutMs * 2)
    expect(lockoutRemaining('other@x.com', now)).toBe(0)
    clearFailures('pm@x.com')
    expect(lockoutRemaining('pm@x.com', now)).toBe(0)
  })
})

describe('session expiry policy', () => {
  const now = Date.UTC(2026, 10, 14)
  it('expires any session 30 days after sign-in', () => {
    expect(sessionExpiry(now - SESSION_POLICY.maxAgeMs - 1, { remember: true, lastActive: now }, now)).toBe('expired')
    expect(sessionExpiry(now - SESSION_POLICY.maxAgeMs + 60_000, { remember: true, lastActive: now - 10 * 3600_000 }, now)).toBeNull()
  })
  it('signs out after 30 minutes of inactivity only when "Remember me" was off', () => {
    expect(sessionExpiry(now - 3600_000, { remember: false, lastActive: now - 31 * 60_000 }, now)).toBe('idle')
    expect(sessionExpiry(now - 3600_000, { remember: false, lastActive: now - 5 * 60_000 }, now)).toBeNull()
    expect(sessionExpiry(now - 3600_000, { remember: true, lastActive: now - 5 * 3600_000 }, now)).toBeNull()
  })
  it('carries a one-shot sign-out message across the reload', () => {
    setFlash('user')
    expect(takeFlash()).toBe('user')
    expect(takeFlash()).toBeNull()
  })
})

describe('demo mode authentication (browser-only, separate from production)', () => {
  it('signs in with a demo username or email + the demo password', async () => {
    const db = createDemoDb()
    expect(db.auth.isDemo).toBe(true)
    const pm = DEMO_ACCOUNTS.find((a) => a.role === 'project_manager')!
    const r = await db.auth.signInWithPassword({ email: pm.username, password: DEMO_PASSWORD, remember: false })
    expect(r.error).toBeNull()
    const me = await db.me()
    expect(me?.roleKey).toBe('project_manager')
    expect(me?.active).toBe(true)
    expect(readSessionMeta()?.remember).toBe(false)
    const r2 = await db.auth.signInWithPassword({ email: pm.email.toUpperCase(), password: DEMO_PASSWORD })
    expect(r2.error).toBeNull()
  }, 60_000)

  it('rejects a wrong password and an unknown user with the same message', async () => {
    const db = createDemoDb()
    const wrong = await db.auth.signInWithPassword({ email: 'demo.pm', password: 'nope' })
    const unknown = await db.auth.signInWithPassword({ email: 'nobody@demo.abckit', password: DEMO_PASSWORD })
    expect(wrong.error?.message).toBe(INVALID_CREDENTIALS)
    expect(unknown.error?.message).toBe(INVALID_CREDENTIALS)
    expect(wrong.error?.code).toBe(unknown.error?.code)
    expect((await db.auth.getSession()).data.session).toBeNull()
  }, 60_000)

  it('keeps the session across a page refresh (new client instance)', async () => {
    const a = createDemoDb()
    await a.auth.signInWithPassword({ email: 'demo.accountant', password: DEMO_PASSWORD })
    const b = createDemoDb()
    const s = (await b.auth.getSession()).data.session
    expect(s?.user.id).toBe('demo-accountant')
  }, 60_000)

  it('loads the [DEMO] sample data and applies role-based access', async () => {
    const db = createDemoDb()
    await db.auth.signInWithPassword({ email: 'demo.admin', password: DEMO_PASSWORD })
    const projects = ok(await db.from('projects').select('id,name,is_demo'))
    expect(projects.length).toBe(3)
    expect(projects.every((p) => p.is_demo && p.name.startsWith('[DEMO]'))).toBe(true)

    const eng = createDemoDb()
    await eng.auth.signInWithPassword({ email: 'demo.engineer', password: DEMO_PASSWORD })
    const visible = ok(await eng.from('projects').select('name'))
    expect(visible.length).toBe(2) // member of two projects only
    const perms = ok(await eng.rpc('my_permissions')) as string[]
    expect(perms).not.toContain('users.manage')
    const esc = await eng.from('profiles').update({ role_id: 'super_admin' }).eq('id', 'demo-site_engineer')
    expect(esc.error?.code).toBe('42501')
  }, 60_000)

  it('Email access: an administrator grants one user mailbox access on top of their role (and can take it back)', async () => {
    const db = createDemoDb()
    await db.auth.signInWithPassword({ email: 'demo.admin', password: DEMO_PASSWORD })
    const invoke = (body: Record<string, unknown>) => db.functions.invoke('admin-users', { body })
    // (signing in as another demo account switches the user; signOut would reload the page)
    // only grantable AI keys, never yourself, never a Super Administrator
    expect((await invoke({ action: 'set_access', user_id: 'demo-site_engineer', perms: ['users.manage'] })).error).toBeTruthy()
    expect((await invoke({ action: 'set_access', user_id: 'demo-super_admin', perms: ['ai.email'] })).error).toBeTruthy()
    const granted = await invoke({ action: 'set_access', user_id: 'demo-site_engineer', perms: ['ai.email_send'] })
    expect(granted.error).toBeNull()
    expect(granted.data.perms).toEqual(['ai.email', 'ai.email_send', 'ai.view'])
    const audit = ok(await db.from('audit_logs').select('table_name,record_id,action').eq('table_name', 'user_access'))
    expect(audit).toContainEqual({ table_name: 'user_access', record_id: 'demo-site_engineer', action: 'INSERT' })
    // the app cannot write grants directly
    expect((await db.from('user_access').insert({ id: 'x', user_id: 'x', perms: ['ai.email'] })).error?.code).toBe('42501')

    await db.auth.signInWithPassword({ email: 'demo.engineer', password: DEMO_PASSWORD })
    const perms = ok(await db.rpc('my_permissions')) as string[]
    expect(perms).toEqual(expect.arrayContaining(['ai.view', 'ai.email', 'ai.email_send']))
    expect(perms).not.toContain('ai.manage')
    // the engineer cannot grant access to anyone (no users.manage)
    expect((await db.functions.invoke('admin-users', { body: { action: 'set_access', user_id: 'demo-accountant', perms: ['ai.email'] } })).error).toBeTruthy()

    await db.auth.signInWithPassword({ email: 'demo.admin', password: DEMO_PASSWORD })
    expect((await invoke({ action: 'set_access', user_id: 'demo-site_engineer', perms: [] })).error).toBeNull()
    await db.auth.signInWithPassword({ email: 'demo.engineer', password: DEMO_PASSWORD })
    expect(ok(await db.rpc('my_permissions'))).not.toContain('ai.email')
  }, 60_000)

  it('demo password changes and reset emails are disabled', async () => {
    const db = createDemoDb()
    expect((await db.auth.updateUser({ password: 'x' })).error?.code).toBe('demo/disabled')
    expect((await db.auth.resetPasswordForEmail('a@b.c')).error?.code).toBe('demo/disabled')
  })
})

describe('usernames and server-side session revocation (engine level)', () => {
  it('keeps usernames unique and maps them to the account email', async () => {
    const t = createTestDb()
    const a = t.addUser('employee', { email: 'a@x.co' })
    const b = t.addUser('employee', { email: 'b@x.co' })
    let db = t.as(a)
    ok(await db.from('profiles').update({ username: 'Juma.H' }).eq('id', a))
    expect(t.raw.get('usernames', 'juma.h')).toMatchObject({ user_id: a, email: 'a@x.co' })
    db = t.as(b)
    const taken = await db.from('profiles').update({ username: 'juma.h' }).eq('id', b)
    expect(taken.error?.code).toBe('23505')
    const bad = await db.from('profiles').update({ username: 'x@y' }).eq('id', b)
    expect(bad.error?.code).toBe('23514')
    db = t.as(a)
    ok(await db.from('profiles').update({ username: 'juma' }).eq('id', a))
    expect(t.raw.get('usernames', 'juma.h')).toBeUndefined()
    expect(t.raw.get('usernames', 'juma')).toBeTruthy()
  })

  it('"sign out of all devices" stamps session_revocations with the server time', async () => {
    const t = createTestDb()
    const u = t.addUser('accountant')
    const db = t.as(u)
    const before = Date.now()
    ok(await db.rpc('revoke_sessions'))
    const at = Date.parse(t.raw.get('session_revocations', u)!.at)
    expect(at).toBeGreaterThanOrEqual(before - 1000)
    // someone else's sessions: only users.manage
    const other = t.addUser('employee')
    const denied = await db.rpc('revoke_sessions', { user_id: other })
    expect(denied.error?.code).toBe('42501')
  })
})

describe('administrator sets another user\'s password', () => {
  it('enforces the new-password policy', async () => {
    const { newPasswordProblem } = await import('./authTypes')
    expect(newPasswordProblem('1234')).toMatch(/10 characters/)
    expect(newPasswordProblem('abcdefghijk')).toMatch(/letters and numbers/)
    expect(newPasswordProblem('1234567890')).toMatch(/letters and numbers/)
    expect(newPasswordProblem('x'.repeat(120) + '12345678x')).toMatch(/too long/)
    expect(newPasswordProblem('Abc4QkB5gcuU7k')).toBeNull()
  })

  it('generates strong passwords', async () => {
    const { generatePassword, newPasswordProblem } = await import('./authTypes')
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const p = generatePassword()
      expect(p).toHaveLength(14)
      expect(newPasswordProblem(p)).toBeNull()
      seen.add(p)
    }
    expect(seen.size).toBe(50)
  })

  it('demo: same checks as the real function, nothing actually changed', async () => {
    const db = createDemoDb()
    await db.auth.signInWithPassword({ email: 'demo.sysadmin', password: DEMO_PASSWORD })
    const call = (body: Record<string, unknown>) => db.functions.invoke('admin-users', { body: { action: 'set_password', ...body } })

    const okRes = await call({ user_id: 'demo-accountant', password: 'NewPass2026x' })
    expect(okRes.error).toBeNull()
    expect(okRes.data).toMatchObject({ ok: true, demo: true, sessions_ended: true })
    expect((await call({ user_id: 'demo-accountant', password: '1234' })).error?.message).toMatch(/10 characters/)
    expect((await call({ user_id: 'demo-administrator', password: 'NewPass2026x' })).error?.message).toMatch(/Profile page/)
    // an Administrator (users.manage, not Super Admin) cannot touch a Super Administrator's password
    expect((await call({ user_id: 'demo-super_admin', password: 'NewPass2026x' })).error?.message).toMatch(/Only a Super Administrator/)
    expect((await call({ user_id: 'nobody', password: 'NewPass2026x' })).error?.message).toMatch(/not found/)

    // without users.manage: refused
    const eng = createDemoDb()
    await eng.auth.signInWithPassword({ email: 'demo.engineer', password: DEMO_PASSWORD })
    const denied = await eng.functions.invoke('admin-users', { body: { action: 'set_password', user_id: 'demo-accountant', password: 'NewPass2026x' } })
    expect(denied.error?.message).toMatch(/permission/)

    // the demo password still works for the "changed" account
    const acc = createDemoDb()
    expect((await acc.auth.signInWithPassword({ email: 'demo.accountant', password: DEMO_PASSWORD })).error).toBeNull()
  }, 60_000)
})
