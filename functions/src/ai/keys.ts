/**
 * AI provider API keys entered by an administrator in the AI Control Center (callable aiManageKeys, ai.manage).
 *
 *  - A key is checked with the provider first (a read-only "list models" request), then encrypted with
 *    AES-256-GCM (EMAIL_TOKEN_KEY; the provider id is bound as AAD) and stored in the server-only collection
 *    ai_provider_keys — firestore.rules deny every client read and write there.
 *  - A key saved here takes precedence over the deployed Secret Manager secret (no redeploy needed);
 *    removing it falls back to that secret.
 *  - The plaintext key is never returned, logged or written to the audit trail. The app only sees
 *    ai_status.ai_keys: source, last 4 characters, who changed it and when, and the last test result.
 */
import { logger } from 'firebase-functions/v2'
import { HttpsError } from 'firebase-functions/v2/https'
import { AI_COLLECTIONS, CHAT_PROVIDER_LABEL, CHAT_PROVIDERS, type AiKeyInfo, type AiStatus, type CallableContracts, type ChatProviderId } from '../shared/ai/contract.js'
import type { Db } from '../lib/admin.js'
import type { AiCaller } from '../lib/auth.js'
import { nowIso, patchStatus, writeActivity } from '../lib/audit.js'
import { CryptoConfigError, decrypt, encrypt, parseKey, type Encrypted } from '../lib/crypto.js'
import type { RuntimeConfig } from '../lib/params.js'

type Req = CallableContracts['aiManageKeys']['req']
type Res = CallableContracts['aiManageKeys']['res']
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>

export interface StoredKey {
  provider: ChatProviderId
  enc: Encrypted
  last4: string
  updated_at: string
  updated_by: string
  updated_by_name: string
}

/** config field holding each provider's key */
const CFG_FIELD = { openai: 'openaiKey', gemini: 'geminiKey', claude: 'anthropicKey' } as const satisfies Record<ChatProviderId, keyof RuntimeConfig>

/** expected key shapes (prefix + URL-safe characters); kept loose so new key formats keep working */
export const KEY_FORMAT: Record<ChatProviderId, { re: RegExp; hint: string }> = {
  openai: { re: /^sk-[A-Za-z0-9_-]{20,400}$/, hint: 'OpenAI keys start with "sk-" (for example sk-proj-…).' },
  // classic keys start with AIza; newer Google AI Studio keys look like AQ.<letters, digits, _ and ->
  gemini: { re: /^(AIza[A-Za-z0-9_-]{20,100}|AQ\.[A-Za-z0-9_-]{30,200})$/, hint: 'Google Gemini keys start with "AIza" or "AQ.".' },
  claude: { re: /^sk-ant-[A-Za-z0-9_-]{20,400}$/, hint: 'Anthropic keys start with "sk-ant-".' },
}

const aad = (p: ChatProviderId) => `ai_provider_key:${p}`
const last4 = (key: string) => key.slice(-4)
const bad = (msg: string) => new HttpsError('invalid-argument', msg)

function isProvider(v: unknown): v is ChatProviderId {
  return typeof v === 'string' && (CHAT_PROVIDERS as string[]).includes(v)
}

export function validateKeysRequest(data: unknown): Req {
  const d = (data ?? {}) as Record<string, unknown>
  if (!['set', 'remove', 'test'].includes(String(d.action))) throw bad('action must be set, remove or test')
  if (!isProvider(d.provider)) throw bad(`provider must be one of ${CHAT_PROVIDERS.join(', ')}`)
  const req: Req = { action: d.action as Req['action'], provider: d.provider }
  if (req.action === 'set') {
    const key = typeof d.key === 'string' ? d.key.trim() : ''
    if (!key) throw bad('Paste the API key.')
    if (!KEY_FORMAT[req.provider].re.test(key)) throw bad(`This does not look like a ${CHAT_PROVIDER_LABEL[req.provider]} API key. ${KEY_FORMAT[req.provider].hint}`)
    req.key = key
    req.skip_test = d.skip_test === true
  }
  return req
}

// ----------------------------------------------------------------------------- provider check

export interface KeyTest {
  ok: boolean
  /** false only when the provider says the key itself is wrong (not for network / quota problems) */
  invalid: boolean
  message: string
}

/** a read-only request that every valid key may make (lists models; costs nothing) */
export async function testKey(provider: ChatProviderId, key: string, fetchFn: Fetch): Promise<KeyTest> {
  const req: { url: string; headers: Record<string, string> } =
    provider === 'openai'
      ? { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } }
      : provider === 'gemini'
        ? { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': key } }
        : { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }
  const name = CHAT_PROVIDER_LABEL[provider]
  let status: number
  let body = ''
  try {
    const res = await fetchFn(req.url, { method: 'GET', headers: req.headers, signal: AbortSignal.timeout(15_000) })
    status = res.status
    body = (await res.text().catch(() => '')).slice(0, 2000)
  } catch (e) {
    return { ok: false, invalid: false, message: `${name} could not be reached (${String((e as Error)?.message ?? e).slice(0, 120)}). Try again, or save without testing.` }
  }
  if (status >= 200 && status < 300) return { ok: true, invalid: false, message: `${name} accepted the key.` }
  // Gemini answers 400 API_KEY_INVALID for a wrong key
  if (status === 401 || status === 403 || (provider === 'gemini' && status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)))
    return { ok: false, invalid: true, message: `${name} rejected the key (${status}). Check that it was copied completely and is still active.` }
  if (status === 429) return { ok: true, invalid: false, message: `${name} accepted the key, but the account is rate-limited or out of credit (429). Check billing.` }
  return { ok: false, invalid: false, message: `${name} answered ${status}. Try again later, or save without testing.` }
}

// ----------------------------------------------------------------------------- reading the keys in use

const CACHE_MS = 30_000
let cache: { at: number; rows: Map<ChatProviderId, StoredKey> } | null = null
export function clearKeyCache() {
  cache = null
}

async function storedKeys(db: Db): Promise<Map<ChatProviderId, StoredKey>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows
  const snaps = await db.getAll(...CHAT_PROVIDERS.map((p) => db.doc(`${AI_COLLECTIONS.providerKeys}/${p}`)))
  const rows = new Map<ChatProviderId, StoredKey>()
  for (const s of snaps) if (s.exists) rows.set(s.id as ChatProviderId, s.data() as StoredKey)
  cache = { at: Date.now(), rows }
  return rows
}

export interface KeyedConfig extends RuntimeConfig {
  /** where each key in this config came from */
  keySource: Record<ChatProviderId, 'admin' | 'server' | 'none'>
}

/**
 * The config with keys saved in the AI Control Center applied over the deployed secrets.
 * Without EMAIL_TOKEN_KEY (or if a stored key cannot be decrypted) the deployed secret is used.
 */
export async function withStoredKeys(db: Db, cfg: RuntimeConfig): Promise<KeyedConfig> {
  const keySource = Object.fromEntries(CHAT_PROVIDERS.map((p) => [p, cfg[CFG_FIELD[p]] ? 'server' : 'none'])) as KeyedConfig['keySource']
  const out: KeyedConfig = { ...cfg, keySource }
  let tokenKey: Buffer
  try {
    tokenKey = parseKey(cfg.tokenKey)
  } catch {
    return out
  }
  let rows: Map<ChatProviderId, StoredKey>
  try {
    rows = await storedKeys(db)
  } catch (e) {
    logger.warn('AI provider keys could not be read; using the deployed secrets', String((e as Error)?.message ?? e))
    return out
  }
  for (const [p, row] of rows) {
    try {
      out[CFG_FIELD[p]] = decrypt(row.enc, tokenKey, aad(p))
      keySource[p] = 'admin'
    } catch {
      logger.error(`The saved ${CHAT_PROVIDER_LABEL[p]} key cannot be decrypted (EMAIL_TOKEN_KEY changed?). Save it again in the AI Control Center.`)
    }
  }
  return out
}

/** the key info the app may see, for every provider */
export async function keyInfo(db: Db, cfg: KeyedConfig): Promise<Record<ChatProviderId, AiKeyInfo>> {
  const rows = await storedKeys(db).catch(() => new Map<ChatProviderId, StoredKey>())
  const prev = ((await db.doc(`${AI_COLLECTIONS.status}/status`).get()).data() as AiStatus | undefined)?.ai_keys
  return Object.fromEntries(
    CHAT_PROVIDERS.map((p) => {
      const key = cfg[CFG_FIELD[p]]
      const src = cfg.keySource[p]
      const row = src === 'admin' ? rows.get(p) : undefined
      const info: AiKeyInfo = {
        source: src,
        last4: key ? last4(key) : null,
        updated_at: row?.updated_at ?? null,
        updated_by_name: row?.updated_by_name ?? null,
        last_test: prev?.[p]?.source === src && prev?.[p]?.last4 === (key ? last4(key) : null) ? (prev?.[p]?.last_test ?? null) : null,
      }
      return [p, info]
    }),
  ) as Record<ChatProviderId, AiKeyInfo>
}

/** writes ai_status (configured providers + key info) from an effective config */
export async function publishKeyStatus(db: Db, cfg: KeyedConfig, override?: Partial<Record<ChatProviderId, Partial<AiKeyInfo>>>) {
  const info = await keyInfo(db, cfg)
  for (const [p, o] of Object.entries(override ?? {})) Object.assign(info[p as ChatProviderId], o)
  await patchStatus(db, {
    ai_configured: !!(cfg.anthropicKey || cfg.openaiKey || cfg.geminiKey),
    ai_providers: { openai: !!cfg.openaiKey, gemini: !!cfg.geminiKey, claude: !!cfg.anthropicKey },
    ai_keys: info,
  })
  return info
}

// ----------------------------------------------------------------------------- the callable

export interface KeysDeps {
  db: Db
  /** the deployed config (secrets) — stored keys are applied on top */
  config: RuntimeConfig
  fetch: Fetch
}

export async function runManageKeys(deps: KeysDeps, caller: AiCaller, data: unknown): Promise<Res> {
  const req = validateKeysRequest(data)
  const { db } = deps
  const name = CHAT_PROVIDER_LABEL[req.provider]
  const ref = db.doc(`${AI_COLLECTIONS.providerKeys}/${req.provider}`)

  if (req.action === 'set') {
    let tokenKey: Buffer
    try {
      tokenKey = parseKey(deps.config.tokenKey)
    } catch (e) {
      throw new HttpsError(
        'failed-precondition',
        e instanceof CryptoConfigError
          ? 'Keys cannot be stored safely yet: EMAIL_TOKEN_KEY (32 random bytes, base64) must be set on the server first. See functions/AI_SETUP.md §1.2.'
          : 'EMAIL_TOKEN_KEY is not valid.',
      )
    }
    const key = req.key!
    let test: KeyTest | null = null
    if (!req.skip_test) {
      test = await testKey(req.provider, key, deps.fetch)
      if (!test.ok) {
        await writeActivity(db, caller.uid, 'settings_changed', `${name} API key NOT saved: ${test.message}`, null, false)
        throw new HttpsError(test.invalid ? 'invalid-argument' : 'unavailable', test.message)
      }
    }
    const row: StoredKey = { provider: req.provider, enc: encrypt(key, tokenKey, aad(req.provider)), last4: last4(key), updated_at: nowIso(), updated_by: caller.uid, updated_by_name: caller.name }
    await ref.set(row)
    clearKeyCache()
    await writeActivity(db, caller.uid, 'settings_changed', `${name} API key saved (…${row.last4})${test ? ' — tested OK' : ' — saved without testing'}`)
    const cfg = await withStoredKeys(db, deps.config)
    const info = await publishKeyStatus(db, cfg, test ? { [req.provider]: { last_test: { at: nowIso(), ok: true, message: test.message } } } : undefined)
    return { ok: true, provider: req.provider, info: info[req.provider] }
  }

  if (req.action === 'remove') {
    await ref.delete()
    clearKeyCache()
    const cfg = await withStoredKeys(db, deps.config)
    await writeActivity(db, caller.uid, 'settings_changed', `${name} API key removed from the AI Control Center${cfg.keySource[req.provider] === 'server' ? ' — the deployed server secret is used again' : ' — the provider has no key now'}`)
    const info = await publishKeyStatus(db, cfg)
    return { ok: true, provider: req.provider, info: info[req.provider] }
  }

  // test the key in use
  const cfg = await withStoredKeys(db, deps.config)
  const key = cfg[CFG_FIELD[req.provider]]
  const test: KeyTest = key ? await testKey(req.provider, key, deps.fetch) : { ok: false, invalid: false, message: `No ${name} key is set.` }
  await writeActivity(db, caller.uid, 'settings_changed', `${name} API key tested: ${test.message}`, null, test.ok)
  const info = await publishKeyStatus(db, cfg, { [req.provider]: { last_test: { at: nowIso(), ok: test.ok, message: test.message } } })
  return { ok: true, provider: req.provider, info: info[req.provider] }
}
