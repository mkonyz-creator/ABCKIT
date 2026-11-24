/** OAuth 2.0 for Gmail (Google) and Outlook / Microsoft 365 (Microsoft identity platform, common tenant). */
import type { ProviderCreds } from '../lib/params.js'
import { fetchJson, bearer, HttpError, ProviderAuthError, type FetchLike } from './http.js'

export type OAuthProvider = 'gmail' | 'microsoft'

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
export const MS_SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Mail.Read', 'Mail.Send']

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke'
const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

export const STATE_TTL_MS = 10 * 60 * 1000

export function buildAuthUrl(provider: OAuthProvider, creds: ProviderCreds, redirectUri: string, state: string): string {
  if (provider === 'gmail') {
    const q = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    })
    return `${GOOGLE_AUTH}?${q}`
  }
  const q = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: MS_SCOPES.join(' '),
    prompt: 'select_account',
    state,
  })
  return `${MS_AUTH}?${q}`
}

/**
 * The return URL must be on an allowed origin (APP_ORIGINS). Returns the URL without query/hash (the app is a hash
 * router, the callback appends `#/ai?...`), or null when not allowed.
 */
export function validateReturnUrl(raw: unknown, allowedOrigins: string[]): string | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  const origin = u.origin.toLowerCase()
  if (!allowedOrigins.map((o) => o.toLowerCase()).includes(origin)) return null
  return `${u.origin}${u.pathname}`
}

export function appRedirect(returnUrl: string, params: Record<string, string>): string {
  return `${returnUrl}#/ai?${new URLSearchParams({ tab: 'settings', ...params })}`
}

export interface StateDoc {
  uid: string
  provider: OAuthProvider
  return_url: string
  redirect_uri: string
  created_at: string
  expires_at: string
}

/** Checks a consumed state document. Returns an error message or null when valid. */
export function checkState(doc: Partial<StateDoc> | undefined, now = Date.now()): string | null {
  if (!doc || !doc.uid || !doc.provider || !doc.return_url || !doc.expires_at) return 'This sign-in link is invalid or was already used. Please start again.'
  if (Date.parse(doc.expires_at) < now) return 'The sign-in took too long (more than 10 minutes). Please start again.'
  return null
}

export interface TokenSet {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
}

async function tokenRequest(f: FetchLike, provider: OAuthProvider, body: Record<string, string>, what: string): Promise<TokenSet> {
  try {
    return await fetchJson<TokenSet>(f, provider === 'gmail' ? GOOGLE_TOKEN : MS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      what,
    })
  } catch (e) {
    // invalid_grant = refresh token revoked/expired → the user must reconnect
    if (e instanceof HttpError && e.status >= 400 && e.status < 500 && /invalid_grant|interaction_required|consent_required/.test(e.body))
      throw new ProviderAuthError(`${what}: the mailbox authorisation was revoked or expired — reconnect the account`)
    throw e
  }
}

export async function exchangeCode(f: FetchLike, provider: OAuthProvider, creds: ProviderCreds, code: string, redirectUri: string): Promise<TokenSet> {
  const body: Record<string, string> = {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }
  if (provider === 'microsoft') body.scope = MS_SCOPES.join(' ')
  const t = await tokenRequest(f, provider, body, 'Token exchange')
  if (!t.access_token) throw new Error('Token exchange returned no access token')
  return t
}

export async function refreshAccessToken(f: FetchLike, provider: OAuthProvider, creds: ProviderCreds, refreshToken: string): Promise<TokenSet> {
  const body: Record<string, string> = {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }
  if (provider === 'microsoft') body.scope = MS_SCOPES.join(' ')
  return tokenRequest(f, provider, body, 'Token refresh')
}

export async function fetchIdentity(f: FetchLike, provider: OAuthProvider, accessToken: string): Promise<{ address: string; display_name: string | null }> {
  if (provider === 'gmail') {
    const p = await fetchJson<{ emailAddress?: string }>(f, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: bearer(accessToken), what: 'Gmail profile' })
    if (!p.emailAddress) throw new Error('Gmail did not return the mailbox address')
    return { address: p.emailAddress.toLowerCase(), display_name: null }
  }
  const me = await fetchJson<{ mail?: string | null; userPrincipalName?: string; displayName?: string | null }>(
    f,
    'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName',
    { headers: bearer(accessToken), what: 'Microsoft profile' },
  )
  const address = (me.mail || me.userPrincipalName || '').toLowerCase()
  if (!address.includes('@')) throw new Error('Microsoft did not return the mailbox address')
  return { address, display_name: me.displayName ?? null }
}

/** Best-effort token revocation (Google only; Microsoft has no per-token revocation endpoint for this flow). */
export async function revokeGoogleToken(f: FetchLike, token: string): Promise<void> {
  try {
    await f(`${GOOGLE_REVOKE}?${new URLSearchParams({ token })}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
  } catch {
    /* best effort */
  }
}
