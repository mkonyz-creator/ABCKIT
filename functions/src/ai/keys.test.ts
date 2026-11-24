/**
 * AI provider API keys from the AI Control Center: validated, tested with the provider, stored encrypted,
 * never returned, applied over the deployed secrets, removable, audited.
 */
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { requireCaller } from '../lib/auth.js'
import type { RuntimeConfig } from '../lib/params.js'
import { FakeDb, seedUser } from '../test/fakeFirestore.js'
import { clearKeyCache, runManageKeys, testKey, validateKeysRequest, withStoredKeys } from './keys.js'

const OPENAI_KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
const GEMINI_KEY = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p'
const CLAUDE_KEY = 'sk-ant-api03-' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4'

const baseCfg = (over: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  anthropicKey: null,
  openaiKey: null,
  geminiKey: null,
  models: { openaiChat: 'gpt-5.5', openaiRealtime: 'gpt-realtime', openaiVoice: 'marin', gemini: 'gemini-flash-latest', geminiLive: 'gemini-3.8-live', geminiVoice: 'Kore' },
  tokenKey: randomBytes(32).toString('base64'),
  google: null,
  microsoft: null,
  appOrigins: [],
  redirectUri: '',
  ...over,
})

/** fake provider: answers `status` and records what was asked */
function fakeFetch(status = 200, body = '{}') {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fn = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers })
    return { status, text: async () => body }
  }
  return Object.assign(fn, { calls })
}

let db: FakeDb
let cfg: RuntimeConfig
beforeEach(() => {
  clearKeyCache()
  db = new FakeDb()
  seedUser(db, 'admin', ['ai.manage', 'ai.view'], { name: 'Asha Admin' })
  seedUser(db, 'viewer', ['ai.view'])
  cfg = baseCfg()
})
const caller = (uid = 'admin') => requireCaller(db.asDb(), uid, ['ai.manage'])
const manage = async (data: unknown, fetch = fakeFetch(), config = cfg) => runManageKeys({ db: db.asDb(), config, fetch }, await caller(), data)

describe('validation', () => {
  it('accepts well-formed keys and rejects anything else', () => {
    expect(validateKeysRequest({ action: 'set', provider: 'openai', key: ` ${OPENAI_KEY} ` }).key).toBe(OPENAI_KEY)
    expect(validateKeysRequest({ action: 'set', provider: 'gemini', key: GEMINI_KEY }).key).toBe(GEMINI_KEY)
    const newStyle = 'AQ.' + 'Ab8Test_key-0000000000000000000000000000000'
    expect(validateKeysRequest({ action: 'set', provider: 'gemini', key: newStyle }).key).toBe(newStyle)
    expect(() => validateKeysRequest({ action: 'set', provider: 'gemini', key: 'AQ.short' })).toThrow(/"AQ\."/)
    expect(() => validateKeysRequest({ action: 'set', provider: 'gemini', key: 'AQx' + 'Ab8Test_key-0000000000000000000000000000000' })).toThrow()
    expect(validateKeysRequest({ action: 'set', provider: 'claude', key: CLAUDE_KEY }).key).toBe(CLAUDE_KEY)
    expect(() => validateKeysRequest({ action: 'set', provider: 'openai', key: GEMINI_KEY })).toThrow(/start with "sk-"/)
    expect(() => validateKeysRequest({ action: 'set', provider: 'claude', key: OPENAI_KEY })).toThrow(/sk-ant-/)
    expect(() => validateKeysRequest({ action: 'set', provider: 'openai', key: 'sk-short' })).toThrow()
    expect(() => validateKeysRequest({ action: 'set', provider: 'openai', key: `${OPENAI_KEY} rm -rf` })).toThrow()
    expect(() => validateKeysRequest({ action: 'set', provider: 'openai' })).toThrow(/Paste/)
    expect(() => validateKeysRequest({ action: 'set', provider: 'mistral', key: OPENAI_KEY })).toThrow(/provider/)
    expect(() => validateKeysRequest({ action: 'read', provider: 'openai' })).toThrow(/action/)
  })

  it('only ai.manage may call it', async () => {
    await expect(requireCaller(db.asDb(), 'viewer', ['ai.manage'])).rejects.toThrow()
  })
})

describe('saving a key', () => {
  it('tests it, stores it encrypted, never returns it, and uses it over the deployed secret', async () => {
    const fetch = fakeFetch(200)
    const res = await manage({ action: 'set', provider: 'openai', key: OPENAI_KEY }, fetch, baseCfg({ tokenKey: cfg.tokenKey, openaiKey: 'sk-old-deployed-secret-0000000000000' }))
    // tested with a read-only request, key in the header only
    expect(fetch.calls).toEqual([{ url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${OPENAI_KEY}` } }])
    // the response carries only the last 4 characters
    expect(JSON.stringify(res)).not.toContain(OPENAI_KEY)
    expect(res.info).toMatchObject({ source: 'admin', last4: OPENAI_KEY.slice(-4), updated_by_name: 'Asha Admin', last_test: { ok: true } })
    // stored encrypted
    const row = db.get('ai_provider_keys', 'openai')!
    expect(JSON.stringify(row)).not.toContain(OPENAI_KEY)
    expect(row.enc).toMatchObject({ ciphertext: expect.any(String), iv: expect.any(String), tag: expect.any(String) })
    // status for the app: key info, never the key
    const status = db.get('ai_status', 'status')!
    expect(JSON.stringify(status)).not.toContain(OPENAI_KEY)
    expect(status.ai_providers.openai).toBe(true)
    expect(status.ai_keys.openai).toMatchObject({ source: 'admin', last4: OPENAI_KEY.slice(-4) })
    // audit trail mentions the change, not the key
    const audit = db.all('ai_activity')
    expect(audit.map((a) => a.detail).join('\n')).toMatch(/OpenAI API key saved \(…/)
    expect(JSON.stringify(audit)).not.toContain(OPENAI_KEY)
    // the saved key wins over the deployed secret
    clearKeyCache()
    const eff = await withStoredKeys(db.asDb(), baseCfg({ tokenKey: cfg.tokenKey, openaiKey: 'sk-old-deployed-secret-0000000000000' }))
    expect(eff.openaiKey).toBe(OPENAI_KEY)
    expect(eff.keySource.openai).toBe('admin')
  })

  it('a key the provider rejects is not saved', async () => {
    await expect(manage({ action: 'set', provider: 'claude', key: CLAUDE_KEY }, fakeFetch(401))).rejects.toThrow(/rejected the key/)
    expect(db.get('ai_provider_keys', 'claude')).toBeUndefined()
    expect(db.all('ai_activity').some((a) => a.ok === false && /NOT saved/.test(a.detail))).toBe(true)
  })

  it('reads Gemini "API key not valid" (400) as a rejected key; quota (429) still counts as a working key', async () => {
    expect((await testKey('gemini', GEMINI_KEY, fakeFetch(400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'))).invalid).toBe(true)
    expect((await testKey('gemini', GEMINI_KEY, fakeFetch(429))).ok).toBe(true)
    const f = fakeFetch(200)
    await testKey('claude', CLAUDE_KEY, f)
    expect(f.calls[0].headers).toEqual({ 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' })
  })

  it('can be saved without testing (provider unreachable), and refuses without EMAIL_TOKEN_KEY', async () => {
    const down = Object.assign(async () => {
      throw new Error('ENOTFOUND')
    }, { calls: [] })
    await expect(manage({ action: 'set', provider: 'gemini', key: GEMINI_KEY }, down)).rejects.toThrow(/could not be reached/)
    const res = await manage({ action: 'set', provider: 'gemini', key: GEMINI_KEY, skip_test: true }, down)
    expect(res.info.source).toBe('admin')
    await expect(manage({ action: 'set', provider: 'openai', key: OPENAI_KEY }, fakeFetch(), baseCfg({ tokenKey: null }))).rejects.toThrow(/EMAIL_TOKEN_KEY/)
  })
})

describe('removing and testing', () => {
  it('remove falls back to the deployed secret; test checks the key in use', async () => {
    const deployed = baseCfg({ tokenKey: cfg.tokenKey, anthropicKey: 'sk-ant-deployed-0000000000000000000000' })
    await manage({ action: 'set', provider: 'claude', key: CLAUDE_KEY }, fakeFetch(), deployed)
    const removed = await manage({ action: 'remove', provider: 'claude' }, fakeFetch(), deployed)
    expect(removed.info).toMatchObject({ source: 'server', last4: '0000' })
    expect(db.get('ai_provider_keys', 'claude')).toBeUndefined()
    clearKeyCache()
    expect((await withStoredKeys(db.asDb(), deployed)).anthropicKey).toBe('sk-ant-deployed-0000000000000000000000')

    const tested = await manage({ action: 'test', provider: 'claude' }, fakeFetch(401), deployed)
    expect(tested.info.last_test).toMatchObject({ ok: false, message: expect.stringMatching(/rejected/) })
    const none = await manage({ action: 'test', provider: 'gemini' }, fakeFetch(), deployed)
    expect(none.info).toMatchObject({ source: 'none', last_test: { ok: false, message: 'No Google Gemini key is set.' } })
  })

  it('a key encrypted with another EMAIL_TOKEN_KEY is ignored (the deployed secret is used)', async () => {
    await manage({ action: 'set', provider: 'openai', key: OPENAI_KEY })
    clearKeyCache()
    const other = await withStoredKeys(db.asDb(), baseCfg({ openaiKey: null }))
    expect(other.openaiKey).toBeNull()
    expect(other.keySource.openai).toBe('none')
  })
})
