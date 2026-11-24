import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HttpsError } from 'firebase-functions/v2/https'
import { requireCaller } from '../lib/auth.js'
import { decrypt, parseKey } from '../lib/crypto.js'
import type { RuntimeConfig } from '../lib/params.js'
import { FakeDb, seedUser } from '../test/fakeFirestore.js'
import { accountId, connectImap, disconnectAccount, handleOAuthCallback, openSession, startConnect, type MailDeps } from './accounts.js'
import { appRedirect, buildAuthUrl, checkState, validateReturnUrl } from './oauth.js'

const ORIGINS = ['https://abckt-6b791.web.app', 'http://localhost:5173']
const KEY = randomBytes(32).toString('base64')

function config(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    anthropicKey: null,
    tokenKey: KEY,
    google: { clientId: 'gid', clientSecret: 'gsecret' },
    microsoft: { clientId: 'mid', clientSecret: 'msecret' },
    appOrigins: ORIGINS,
    redirectUri: 'https://us-central1-abckt-6b791.cloudfunctions.net/emailOAuthCallback',
    ...over,
  }
}

/** fake fetch that records calls and answers token / profile endpoints */
function fakeFetch(handlers: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const key = Object.keys(handlers).find((k) => url.startsWith(k))
    if (!key) return new Response('not found', { status: 404 })
    const r = handlers[key](init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { f, calls }
}

describe('return URL validation', () => {
  it('accepts allowed origins and strips query and hash', () => {
    expect(validateReturnUrl('https://abckt-6b791.web.app/#/ai?tab=settings', ORIGINS)).toBe('https://abckt-6b791.web.app/')
    expect(validateReturnUrl('http://localhost:5173/app/?x=1', ORIGINS)).toBe('http://localhost:5173/app/')
  })
  it('rejects other origins, schemes, credentials and junk', () => {
    for (const bad of [
      'https://evil.example.com/',
      'https://abckt-6b791.web.app.evil.com/',
      'http://abckt-6b791.web.app/', // wrong scheme for this origin
      'javascript:alert(1)',
      'https://user:pw@abckt-6b791.web.app/',
      'not a url',
      42,
      null,
    ])
      expect(validateReturnUrl(bad, ORIGINS)).toBeNull()
  })
  it('builds the app redirect with the hash route', () => {
    expect(appRedirect('https://abckt-6b791.web.app/', { connected: 'gmail' })).toBe('https://abckt-6b791.web.app/#/ai?tab=settings&connected=gmail')
  })
})

describe('OAuth state', () => {
  it('requires all fields and rejects expired states', () => {
    const now = Date.parse('2026-11-14T10:00:00Z')
    expect(checkState(undefined, now)).toMatch(/invalid/)
    expect(checkState({ uid: 'u', provider: 'gmail', return_url: 'x', expires_at: '2026-11-14T09:59:00Z' }, now)).toMatch(/too long/)
    expect(checkState({ uid: 'u', provider: 'gmail', return_url: 'x', expires_at: '2026-11-14T10:05:00Z' }, now)).toBeNull()
  })

  it('builds provider URLs with the required scopes and offline access', () => {
    const g = new URL(buildAuthUrl('gmail', { clientId: 'gid', clientSecret: 's' }, 'https://cb', 'st'))
    expect(g.origin).toBe('https://accounts.google.com')
    expect(g.searchParams.get('access_type')).toBe('offline')
    expect(g.searchParams.get('prompt')).toBe('consent')
    expect(g.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send')
    const m = new URL(buildAuthUrl('microsoft', { clientId: 'mid', clientSecret: 's' }, 'https://cb', 'st'))
    expect(m.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(m.searchParams.get('scope')).toBe('offline_access openid email User.Read Mail.Read Mail.Send')
    expect(m.searchParams.get('state')).toBe('st')
  })
})

describe('connect flow (fake Firestore + fake fetch)', () => {
  async function start(db: FakeDb, deps: MailDeps, provider: 'gmail' | 'microsoft' = 'gmail') {
    const caller = await requireCaller(db.asDb(), 'admin', ['ai.manage'])
    const { auth_url } = await startConnect(deps, caller, { provider, return_url: 'https://abckt-6b791.web.app/#/ai' })
    return new URL(auth_url).searchParams.get('state')!
  }

  it('stores the account + encrypted refresh token, consumes the state once and redirects back', async () => {
    const db = new FakeDb()
    seedUser(db, 'admin', ['ai.manage'])
    const { f, calls } = fakeFetch({
      'https://oauth2.googleapis.com/token': () => ({ body: { access_token: 'at', refresh_token: 'rt-123', scope: 'openid email', expires_in: 3600 } }),
      'https://gmail.googleapis.com/gmail/v1/users/me/profile': () => ({ body: { emailAddress: 'Office@Aricom.co.tz' } }),
    })
    const deps: MailDeps = { db: db.asDb(), fetch: f, config: config() }
    const state = await start(db, deps)
    expect(db.get('email_oauth_states', state)!.return_url).toBe('https://abckt-6b791.web.app/')

    const res = await handleOAuthCallback(deps, { state, code: 'the-code' })
    expect(res).toEqual({ redirect: 'https://abckt-6b791.web.app/#/ai?tab=settings&connected=gmail' })
    const tokenBody = new URLSearchParams(String(calls[0].init!.body))
    expect(tokenBody.get('code')).toBe('the-code')
    expect(tokenBody.get('redirect_uri')).toBe(config().redirectUri)

    const id = accountId('gmail', 'office@aricom.co.tz')
    const acc = db.get('email_accounts', id)!
    expect(acc).toMatchObject({ provider: 'gmail', address: 'office@aricom.co.tz', status: 'connected', sync_enabled: true, connected_by: 'admin', is_demo: false })
    expect(JSON.stringify(acc)).not.toContain('rt-123')
    const secret = db.get('email_account_secrets', id)!
    expect(secret.refresh_token).not.toBe('rt-123')
    expect(decrypt({ ciphertext: secret.refresh_token, iv: secret.iv, tag: secret.tag }, parseKey(KEY), id)).toBe('rt-123')
    expect(db.all('audit_logs')).toHaveLength(1)
    expect(db.all('audit_logs')[0]).toMatchObject({ table_name: 'email_accounts', record_id: id, action: 'INSERT', changed_by: 'admin' })
    expect(db.all('ai_activity').some((a) => a.action === 'account_connected' && a.ok)).toBe(true)

    // replaying the same state fails (single use)
    const again = await handleOAuthCallback(deps, { state, code: 'the-code' })
    expect(again).toMatchObject({ status: 400 })
  })

  it('rejects an expired state, a missing state and a provider error', async () => {
    const db = new FakeDb()
    seedUser(db, 'admin', ['ai.manage'])
    const deps: MailDeps = { db: db.asDb(), fetch: fakeFetch({}).f, config: config() }
    expect(await handleOAuthCallback(deps, {})).toMatchObject({ status: 400 })
    const state = await start(db, deps)
    db.raw('email_oauth_states').get(state)!.expires_at = '2000-01-01T00:00:00Z'
    expect(await handleOAuthCallback(deps, { state, code: 'c' })).toMatchObject({ status: 400 })
    const state2 = await start(db, deps)
    const r = await handleOAuthCallback(deps, { state: state2, error: 'access_denied' })
    expect('redirect' in r && r.redirect).toContain('error=Access+was+not+granted')
  })

  it('refuses when the user lost ai.manage between start and callback', async () => {
    const db = new FakeDb()
    seedUser(db, 'admin', ['ai.manage'])
    const deps: MailDeps = { db: db.asDb(), fetch: fakeFetch({}).f, config: config() }
    const state = await start(db, deps)
    db.raw('profiles').get('admin')!.is_active = false
    const r = await handleOAuthCallback(deps, { state, code: 'c' })
    expect('redirect' in r && r.redirect).toContain('error=')
    expect(db.all('email_accounts')).toHaveLength(0)
  })

  it('validates the return URL and provider configuration at start', async () => {
    const db = new FakeDb()
    seedUser(db, 'admin', ['ai.manage'])
    const caller = await requireCaller(db.asDb(), 'admin', ['ai.manage'])
    const deps: MailDeps = { db: db.asDb(), fetch: fakeFetch({}).f, config: config({ microsoft: null }) }
    await expect(startConnect(deps, caller, { provider: 'gmail', return_url: 'https://evil.com/' })).rejects.toThrow(/allowed/)
    await expect(startConnect(deps, caller, { provider: 'microsoft', return_url: 'https://abckt-6b791.web.app/' })).rejects.toThrow(/not configured/)
    await expect(startConnect({ ...deps, config: config({ tokenKey: null }) }, caller, { provider: 'gmail', return_url: 'https://abckt-6b791.web.app/' })).rejects.toThrow(/EMAIL_TOKEN_KEY/)
  })

  it('connects Microsoft and disconnects (secret deleted, account marked, Google revoke only for Gmail)', async () => {
    const db = new FakeDb()
    seedUser(db, 'admin', ['ai.manage'])
    const { f, calls } = fakeFetch({
      'https://login.microsoftonline.com/common/oauth2/v2.0/token': () => ({ body: { access_token: 'at', refresh_token: 'mrt' } }),
      'https://graph.microsoft.com/v1.0/me': () => ({ body: { mail: null, userPrincipalName: 'pm@aricom.onmicrosoft.com', displayName: 'Project Manager' } }),
    })
    const deps: MailDeps = { db: db.asDb(), fetch: f, config: config() }
    const state = await start(db, deps, 'microsoft')
    expect(await handleOAuthCallback(deps, { state, code: 'c' })).toEqual({ redirect: 'https://abckt-6b791.web.app/#/ai?tab=settings&connected=microsoft' })
    const id = accountId('microsoft', 'pm@aricom.onmicrosoft.com')
    expect(db.get('email_accounts', id)!.display_name).toBe('Project Manager')
    expect(new URLSearchParams(String(calls[0].init!.body)).get('scope')).toContain('Mail.Send')

    const caller = await requireCaller(db.asDb(), 'admin', ['ai.manage'])
    await disconnectAccount(deps, caller, { account_id: id })
    expect(db.get('email_account_secrets', id)).toBeUndefined()
    expect(db.get('email_accounts', id)).toMatchObject({ status: 'disconnected', sync_enabled: false })
    expect(calls.some((c) => c.url.includes('oauth2.googleapis.com/revoke'))).toBe(false)
    expect(db.all('audit_logs').map((a) => a.action)).toEqual(['INSERT', 'UPDATE'])
  })
})

describe('caller authorisation', () => {
  it('requires a signed-in, active user holding the permission (super_admin holds all)', async () => {
    const db = new FakeDb()
    seedUser(db, 'viewer', ['ai.view'])
    seedUser(db, 'boss', [], { roleKey: 'super_admin' })
    seedUser(db, 'gone', ['ai.manage'], { active: false })
    await expect(requireCaller(db.asDb(), undefined, ['ai.view'])).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(requireCaller(db.asDb(), 'viewer', ['ai.manage'])).rejects.toBeInstanceOf(HttpsError)
    await expect(requireCaller(db.asDb(), 'gone', ['ai.manage'])).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await requireCaller(db.asDb(), 'viewer', ['ai.manage', 'ai.view'])).uid).toBe('viewer')
    const boss = await requireCaller(db.asDb(), 'boss', ['ai.email_send'])
    expect(boss.isSuper && boss.can('anything')).toBe(true)
  })
})

describe('IMAP connect', () => {
  const body = {
    address: 'Info@Aricom.co.tz',
    display_name: 'Info',
    imap: { host: 'mail.aricom.co.tz', port: 993, secure: true, user: 'info@aricom.co.tz', password: 'app-pass-1' },
    smtp: { host: 'mail.aricom.co.tz', port: 465, secure: true, user: 'info@aricom.co.tz', password: 'app-pass-2' },
  }

  it('verifies the login before saving and stores only encrypted passwords', async () => {
    const db = new FakeDb()
    seedUser(db, 'admin', ['ai.manage'])
    const caller = await requireCaller(db.asDb(), 'admin', ['ai.manage'])
    const failing: MailDeps = { db: db.asDb(), fetch: fakeFetch({}).f, config: config(), imapVerify: async () => Promise.reject(new Error('IMAP login failed: check the username and app password.')) }
    await expect(connectImap(failing, caller, body)).rejects.toThrow(/login failed/)
    expect(db.all('email_accounts')).toHaveLength(0)

    let verified: any
    const ok: MailDeps = { ...failing, imapVerify: async (cfg) => void (verified = cfg) }
    const { account_id } = await connectImap(ok, caller, body)
    expect(verified.imap.password).toBe('app-pass-1')
    expect(db.get('email_accounts', account_id)).toMatchObject({ provider: 'imap', address: 'info@aricom.co.tz', status: 'connected' })
    const secret = db.get('email_account_secrets', account_id)!
    expect(JSON.stringify(secret)).not.toContain('app-pass')
    expect(secret.imap).toEqual({ host: 'mail.aricom.co.tz', port: 993, secure: true, user: 'info@aricom.co.tz' })

    // a session gets the decrypted passwords
    let cfgSeen: any
    await openSession({ ...ok, imapSession: (cfg) => ((cfgSeen = cfg), {} as never) }, db.get('email_accounts', account_id) as never)
    expect(cfgSeen.imap.password).toBe('app-pass-1')
    expect(cfgSeen.smtp.password).toBe('app-pass-2')
  })

  it('validates host, port and credentials', async () => {
    const db = new FakeDb()
    seedUser(db, 'admin', ['ai.manage'])
    const caller = await requireCaller(db.asDb(), 'admin', ['ai.manage'])
    const deps: MailDeps = { db: db.asDb(), fetch: fakeFetch({}).f, config: config(), imapVerify: async () => {} }
    await expect(connectImap(deps, caller, { ...body, imap: { ...body.imap, host: 'bad host!' } })).rejects.toThrow(/host/)
    await expect(connectImap(deps, caller, { ...body, smtp: { ...body.smtp, port: 70000 } })).rejects.toThrow(/port/)
    await expect(connectImap(deps, caller, { ...body, imap: { ...body.imap, password: '' } })).rejects.toThrow(/password/)
    await expect(connectImap(deps, caller, { ...body, address: 'nope' })).rejects.toThrow(/email/)
  })
})
