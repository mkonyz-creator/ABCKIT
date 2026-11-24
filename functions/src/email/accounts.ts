/**
 * Mailbox accounts: OAuth connect (Gmail / Microsoft), IMAP connect, disconnect, sync toggle, and opening a
 * provider session with decrypted credentials. Secrets live only in email_account_secrets/{id} (encrypted).
 */
import { HttpsError } from 'firebase-functions/v2/https'
import type { CallableContracts, EmailAccount, EmailProvider } from '../shared/ai/contract.js'
import { AI_COLLECTIONS, AI_PERMS } from '../shared/ai/contract.js'
import type { Db, Row } from '../lib/admin.js'
import { requireCaller, type AiCaller } from '../lib/auth.js'
import { nowIso, writeActivity, writeAuditLog } from '../lib/audit.js'
import { decrypt, encrypt, parseKey, randomToken, shortHash, type Encrypted } from '../lib/crypto.js'
import type { RuntimeConfig } from '../lib/params.js'
import { GmailSession } from './gmail.js'
import { GraphSession } from './graph.js'
import type { FetchLike } from './http.js'
import { ImapSession, verifyImapAccount, type ImapAccountConfig, type ServerConfig } from './imap.js'
import {
  appRedirect,
  buildAuthUrl,
  checkState,
  exchangeCode,
  fetchIdentity,
  GOOGLE_SCOPES,
  MS_SCOPES,
  refreshAccessToken,
  revokeGoogleToken,
  STATE_TTL_MS,
  validateReturnUrl,
  type OAuthProvider,
  type StateDoc,
} from './oauth.js'
import type { MailSession } from './provider.js'

export interface MailDeps {
  db: Db
  fetch: FetchLike
  config: RuntimeConfig
  /** test hook: replaces real IMAP/SMTP */
  imapVerify?: (cfg: ImapAccountConfig) => Promise<void>
  imapSession?: (cfg: ImapAccountConfig) => MailSession
}

/** email_account_secrets/{id} (server-only) */
export interface SecretDoc {
  id: string
  provider: EmailProvider
  scopes: string[]
  /** OAuth: encrypted refresh token (base64 ciphertext); IMAP: encrypted JSON {imap, smtp} passwords */
  refresh_token?: string
  password?: string
  iv: string
  tag: string
  imap?: ServerConfig
  smtp?: ServerConfig
  sync_lock_until?: string | null
  updated_at: string
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const HOST_RE = /^[a-z0-9.-]{1,253}$/i

export const accountId = (provider: EmailProvider, address: string) => `${provider}-${shortHash(address.trim().toLowerCase())}`

function providerCreds(cfg: RuntimeConfig, provider: OAuthProvider) {
  const creds = provider === 'gmail' ? cfg.google : cfg.microsoft
  if (!creds)
    throw new HttpsError(
      'failed-precondition',
      provider === 'gmail'
        ? 'Gmail is not configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). See functions/AI_SETUP.md.'
        : 'Outlook / Microsoft 365 is not configured on the server (MS_CLIENT_ID / MS_CLIENT_SECRET). See functions/AI_SETUP.md.',
    )
  return creds
}

function tokenKey(cfg: RuntimeConfig): Buffer {
  try {
    return parseKey(cfg.tokenKey)
  } catch (e) {
    throw new HttpsError('failed-precondition', `${(e as Error).message}. See functions/AI_SETUP.md.`)
  }
}

/** Public account fields only (what audit_logs and email_accounts get). */
function publicAccount(a: EmailAccount): EmailAccount {
  return {
    id: a.id,
    provider: a.provider,
    address: a.address,
    display_name: a.display_name,
    status: a.status,
    sync_enabled: a.sync_enabled,
    connected_by: a.connected_by,
    connected_at: a.connected_at,
    last_sync_at: a.last_sync_at,
    last_sync_error: a.last_sync_error,
    cursor: a.cursor,
    messages_synced: a.messages_synced,
    is_demo: a.is_demo,
  }
}

async function saveAccount(db: Db, actor: string, provider: EmailProvider, address: string, displayName: string | null, secret: Omit<SecretDoc, 'id' | 'updated_at'>) {
  const id = accountId(provider, address)
  const ref = db.doc(`${AI_COLLECTIONS.accounts}/${id}`)
  const snap = await ref.get()
  const old = snap.exists ? (snap.data() as EmailAccount) : null
  const now = nowIso()
  const account: EmailAccount = publicAccount({
    id,
    provider,
    address,
    display_name: displayName ?? old?.display_name ?? null,
    status: 'connected',
    sync_enabled: true,
    connected_by: actor,
    connected_at: now,
    last_sync_at: old?.last_sync_at ?? null,
    last_sync_error: null,
    // reconnecting the same mailbox keeps its sync position
    cursor: old?.cursor ?? null,
    messages_synced: old?.messages_synced ?? 0,
    is_demo: false,
  })
  await db.doc(`${AI_COLLECTIONS.accountSecrets}/${id}`).set({ id, ...secret, sync_lock_until: null, updated_at: now })
  await ref.set(account)
  await writeAuditLog(db, actor, AI_COLLECTIONS.accounts, id, old ? 'UPDATE' : 'INSERT', old ? publicAccount(old) : null, account)
  await writeActivity(db, actor, 'account_connected', `Connected ${provider} mailbox ${address}`, { table: AI_COLLECTIONS.accounts, id })
  return account
}

// ----------------------------------------------------------------------------- OAuth

export async function startConnect(deps: MailDeps, caller: AiCaller, data: unknown): Promise<CallableContracts['emailConnectStart']['res']> {
  const body = (data ?? {}) as Row
  const provider = body.provider
  if (provider !== 'gmail' && provider !== 'microsoft') throw new HttpsError('invalid-argument', 'provider must be "gmail" or "microsoft"')
  const creds = providerCreds(deps.config, provider)
  tokenKey(deps.config) // fail early if the encryption key is missing
  const returnUrl = validateReturnUrl(body.return_url, deps.config.appOrigins)
  if (!returnUrl) throw new HttpsError('invalid-argument', 'return_url is not an allowed ABCkit address (APP_ORIGINS)')
  const nonce = randomToken(32)
  const now = Date.now()
  const state: StateDoc = {
    uid: caller.uid,
    provider,
    return_url: returnUrl,
    redirect_uri: deps.config.redirectUri,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + STATE_TTL_MS).toISOString(),
  }
  await deps.db.doc(`${AI_COLLECTIONS.oauthStates}/${nonce}`).set(state)
  return { auth_url: buildAuthUrl(provider, creds, deps.config.redirectUri, nonce) }
}

export type CallbackResult = { redirect: string } | { status: number; message: string }

/** Validates + consumes the state, exchanges the code, stores the account. Never throws. */
export async function handleOAuthCallback(deps: MailDeps, query: Record<string, unknown>): Promise<CallbackResult> {
  const nonce = typeof query.state === 'string' ? query.state : ''
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(nonce)) return { status: 400, message: 'Invalid sign-in request (missing state). Please start again from ABCkit.' }
  const ref = deps.db.doc(`${AI_COLLECTIONS.oauthStates}/${nonce}`)
  let state: StateDoc | undefined
  try {
    state = await deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists) tx.delete(ref) // single use
      return snap.exists ? (snap.data() as StateDoc) : undefined
    })
  } catch {
    return { status: 500, message: 'Could not verify the sign-in request. Please try again.' }
  }
  const stateError = checkState(state)
  if (stateError || !state) return { status: 400, message: stateError ?? 'Invalid state' }
  const back = (params: Record<string, string>) => ({ redirect: appRedirect(state!.return_url, params) })
  const provider = state.provider

  if (typeof query.error === 'string') {
    const desc = typeof query.error_description === 'string' ? query.error_description : query.error
    return back({ error: query.error === 'access_denied' ? 'Access was not granted.' : desc.slice(0, 200) })
  }
  const code = typeof query.code === 'string' ? query.code : ''
  if (!code) return back({ error: 'The provider did not return an authorisation code.' })

  try {
    // the person who started the flow must still be allowed to manage AI
    const caller = await requireCaller(deps.db, state.uid, [AI_PERMS.manage])
    const creds = providerCreds(deps.config, provider)
    const key = tokenKey(deps.config)
    const tokens = await exchangeCode(deps.fetch, provider, creds, code, state.redirect_uri || deps.config.redirectUri)
    if (!tokens.refresh_token) return back({ error: 'The provider did not grant offline access. Remove ABCkit from the account’s connected apps and try again.' })
    const identity = await fetchIdentity(deps.fetch, provider, tokens.access_token)
    const id = accountId(provider, identity.address)
    const enc = encrypt(tokens.refresh_token, key, id)
    await saveAccount(deps.db, caller.uid, provider, identity.address, identity.display_name, {
      provider,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : provider === 'gmail' ? GOOGLE_SCOPES : MS_SCOPES,
      refresh_token: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
    })
    return back({ connected: provider })
  } catch (e) {
    const msg = e instanceof HttpsError ? e.message : (e as Error)?.message ?? 'Connection failed'
    await writeActivity(deps.db, state.uid, 'account_connected', `Connecting ${provider} failed: ${msg}`, null, false)
    return back({ error: msg.slice(0, 200) })
  }
}

// ----------------------------------------------------------------------------- IMAP

function serverCfg(v: unknown, label: string): ServerConfig & { password: string } {
  const o = (v ?? {}) as Row
  const host = String(o.host ?? '').trim()
  const port = Number(o.port)
  const user = String(o.user ?? '').trim()
  const password = String(o.password ?? '')
  if (!HOST_RE.test(host)) throw new HttpsError('invalid-argument', `${label} host is invalid`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpsError('invalid-argument', `${label} port is invalid`)
  if (!user || user.length > 320) throw new HttpsError('invalid-argument', `${label} username is required`)
  if (!password || password.length > 500) throw new HttpsError('invalid-argument', `${label} password is required`)
  return { host, port, secure: o.secure === true, user, password }
}

export async function connectImap(deps: MailDeps, caller: AiCaller, data: unknown): Promise<CallableContracts['emailConnectImap']['res']> {
  const body = (data ?? {}) as Row
  const address = String(body.address ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(address)) throw new HttpsError('invalid-argument', 'A valid email address is required')
  const displayName = typeof body.display_name === 'string' && body.display_name.trim() ? body.display_name.trim().slice(0, 120) : null
  const imap = serverCfg(body.imap, 'IMAP')
  const smtp = serverCfg(body.smtp, 'SMTP')
  const key = tokenKey(deps.config)
  const cfg: ImapAccountConfig = { address, display_name: displayName, imap, smtp }
  try {
    await (deps.imapVerify ?? verifyImapAccount)(cfg)
  } catch (e) {
    await writeActivity(deps.db, caller.uid, 'account_connected', `IMAP connection test for ${address} failed: ${(e as Error).message}`, null, false)
    throw new HttpsError('failed-precondition', (e as Error).message)
  }
  const id = accountId('imap', address)
  const enc = encrypt(JSON.stringify({ imap: imap.password, smtp: smtp.password }), key, id)
  const strip = ({ password: _p, ...rest }: ServerConfig & { password: string }): ServerConfig => (void _p, rest)
  await saveAccount(deps.db, caller.uid, 'imap', address, displayName, {
    provider: 'imap',
    scopes: [],
    password: enc.ciphertext,
    iv: enc.iv,
    tag: enc.tag,
    imap: strip(imap),
    smtp: strip(smtp),
  })
  return { account_id: id }
}

// ----------------------------------------------------------------------------- disconnect / sync toggle

function accountIdArg(data: unknown): string {
  const id = String(((data ?? {}) as Row).account_id ?? '')
  if (!/^[a-z]+-[0-9a-f]{16}$/.test(id)) throw new HttpsError('invalid-argument', 'account_id is invalid')
  return id
}

export async function disconnectAccount(deps: MailDeps, caller: AiCaller, data: unknown): Promise<{ ok: true }> {
  const id = accountIdArg(data)
  const ref = deps.db.doc(`${AI_COLLECTIONS.accounts}/${id}`)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Email account not found')
  const old = snap.data() as EmailAccount
  const secretRef = deps.db.doc(`${AI_COLLECTIONS.accountSecrets}/${id}`)
  const secret = (await secretRef.get()).data() as SecretDoc | undefined
  if (secret?.provider === 'gmail' && secret.refresh_token) {
    try {
      const token = decrypt({ ciphertext: secret.refresh_token, iv: secret.iv, tag: secret.tag }, parseKey(deps.config.tokenKey), id)
      await revokeGoogleToken(deps.fetch, token)
    } catch {
      /* best effort */
    }
  }
  await secretRef.delete()
  const next: EmailAccount = publicAccount({ ...old, status: 'disconnected', sync_enabled: false })
  await ref.set(next)
  await writeAuditLog(deps.db, caller.uid, AI_COLLECTIONS.accounts, id, 'UPDATE', publicAccount(old), next)
  await writeActivity(deps.db, caller.uid, 'account_disconnected', `Disconnected ${old.provider} mailbox ${old.address}`, { table: AI_COLLECTIONS.accounts, id })
  return { ok: true }
}

export async function setSync(deps: Pick<MailDeps, 'db'>, caller: AiCaller, data: unknown): Promise<{ ok: true }> {
  const id = accountIdArg(data)
  const enabled = ((data ?? {}) as Row).enabled
  if (typeof enabled !== 'boolean') throw new HttpsError('invalid-argument', 'enabled must be true or false')
  const ref = deps.db.doc(`${AI_COLLECTIONS.accounts}/${id}`)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Email account not found')
  const acc = snap.data() as EmailAccount
  if (enabled && acc.status === 'disconnected') throw new HttpsError('failed-precondition', 'Reconnect the account before enabling sync')
  await ref.update({ sync_enabled: enabled })
  await writeActivity(deps.db, caller.uid, 'settings_changed', `${enabled ? 'Enabled' : 'Paused'} sync for ${acc.address}`, { table: AI_COLLECTIONS.accounts, id })
  return { ok: true }
}

// ----------------------------------------------------------------------------- sessions

/** Opens a provider session for an account (refreshing the OAuth access token; persisting rotated refresh tokens). */
export async function openSession(deps: MailDeps, account: EmailAccount): Promise<MailSession> {
  if (account.is_demo) throw new Error('Demo accounts have no mailbox')
  const secretRef = deps.db.doc(`${AI_COLLECTIONS.accountSecrets}/${account.id}`)
  const secret = (await secretRef.get()).data() as SecretDoc | undefined
  if (!secret) throw new Error('This mailbox has no stored credentials — reconnect it.')
  const key = parseKey(deps.config.tokenKey)
  if (account.provider === 'imap') {
    if (!secret.password || !secret.imap || !secret.smtp) throw new Error('IMAP settings are incomplete — reconnect the account.')
    const pw = JSON.parse(decrypt({ ciphertext: secret.password, iv: secret.iv, tag: secret.tag }, key, account.id)) as { imap: string; smtp: string }
    const cfg: ImapAccountConfig = {
      address: account.address,
      display_name: account.display_name,
      imap: { ...secret.imap, password: pw.imap },
      smtp: { ...secret.smtp, password: pw.smtp },
    }
    return deps.imapSession ? deps.imapSession(cfg) : new ImapSession(cfg)
  }
  const provider = account.provider
  const creds = provider === 'gmail' ? deps.config.google : deps.config.microsoft
  if (!creds) throw new Error(`${provider === 'gmail' ? 'Gmail' : 'Microsoft'} is not configured on the server.`)
  if (!secret.refresh_token) throw new Error('No refresh token stored — reconnect the account.')
  const refresh = decrypt({ ciphertext: secret.refresh_token, iv: secret.iv, tag: secret.tag }, key, account.id)
  const tokens = await refreshAccessToken(deps.fetch, provider, creds, refresh)
  if (tokens.refresh_token && tokens.refresh_token !== refresh) {
    const enc: Encrypted = encrypt(tokens.refresh_token, key, account.id)
    await secretRef.update({ refresh_token: enc.ciphertext, iv: enc.iv, tag: enc.tag, updated_at: nowIso() })
  }
  return provider === 'gmail' ? new GmailSession(deps.fetch, tokens.access_token) : new GraphSession(deps.fetch, tokens.access_token)
}
