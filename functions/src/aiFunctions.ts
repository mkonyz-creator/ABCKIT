/**
 * ABCkit AI Intelligence — Cloud Functions (callables, OAuth callback, schedules).
 *
 * Callable            Permission (super_admin has all)
 * aiComplete          ai.view   (chat: OpenAI → Gemini → Claude per AI settings; reports: Claude)
 * voiceSession        ai.view   (short-lived OpenAI Realtime key for a live voice conversation)
 * aiRunMonitor        ai.view
 * aiManageKeys        ai.manage (save / test / remove AI provider API keys — stored encrypted, never returned)
 * emailConnectStart   ai.manage
 * emailConnectImap    ai.manage
 * emailDisconnect     ai.manage
 * emailSetSync        ai.manage
 * emailSyncNow        ai.manage or ai.email
 * emailAnalyze        ai.email
 * emailGenerateReply  ai.email
 * emailSendDraft      ai.email_send
 * HTTP: emailOAuthCallback (OAuth redirect URI). Scheduled: emailSyncScheduled (10 min), aiMonitorScheduled (30 min).
 */
import { logger } from 'firebase-functions/v2'
import { HttpsError, onCall, onRequest, type CallableRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import type { AiEmail, AiStatus, EmailAccount } from './shared/ai/contract.js'
import { AI_COLLECTIONS, AI_PERMS } from './shared/ai/contract.js'
import { adminDb, type Db } from './lib/admin.js'
import { requireCaller, type AiCaller } from './lib/auth.js'
import { loadSettings, patchStatus } from './lib/audit.js'
import { parseKey } from './lib/crypto.js'
import {
  AI_SECRETS,
  ALL_SECRETS,
  ANTHROPIC_API_KEY,
  OPENAI_API_KEY,
  GEMINI_API_KEY,
  COMPANY_TZ,
  EMAIL_TOKEN_KEY,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  REGION,
  runtimeConfig,
  type RuntimeConfig,
} from './lib/params.js'
import { companyToday } from './lib/time.js'
import { aiNotConfigured, isAiError, makeClient, toHttpsError, type AnthropicLike } from './ai/claude.js'
import { runComplete } from './ai/complete.js'
import { publishKeyStatus, runManageKeys, withStoredKeys, type KeyedConfig } from './ai/keys.js'
import { makeGemini } from './ai/providers/gemini.js'
import { makeOpenAI } from './ai/providers/openai.js'
import { runVoiceSession } from './ai/voice.js'
import { runMonitor } from './ai/monitorRun.js'
import { connectImap, disconnectAccount, handleOAuthCallback, openSession, setSync, startConnect, type MailDeps } from './email/accounts.js'
import { analyzeEmail, loadReference } from './email/analyze.js'
import { generateReply, sendDraft } from './email/reply.js'
import { syncAll } from './email/sync.js'

const AI_OPTS = { region: REGION, timeoutSeconds: 540, memory: '512MiB' as const, maxInstances: 10 }
const MAIL_SECRETS = [EMAIL_TOKEN_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MS_CLIENT_ID, MS_CLIENT_SECRET]

function anthropic(cfg: RuntimeConfig): AnthropicLike | null {
  return cfg.anthropicKey ? makeClient(cfg.anthropicKey) : null
}

/** the deployed secrets with the keys saved in the AI Control Center applied on top */
const effectiveConfig = (db: Db) => withStoredKeys(db, runtimeConfig())

function mailDeps(db: Db, cfg: RuntimeConfig): MailDeps {
  return { db, fetch: (url, init) => fetch(url, init), config: cfg }
}

function tokenKeyOk(cfg: RuntimeConfig) {
  try {
    parseKey(cfg.tokenKey)
    return true
  } catch {
    return false
  }
}

/**
 * Keeps ai_status in step with what is configured on the server.
 * `ai`: false for functions that do not load the AI provider secrets (they would otherwise report "no key").
 */
async function refreshConfigStatus(db: Db, cfg: KeyedConfig, { ai = true } = {}) {
  const keyOk = tokenKeyOk(cfg)
  const patch: Partial<AiStatus> = { providers: { gmail: keyOk && !!cfg.google, microsoft: keyOk && !!cfg.microsoft, imap: keyOk } }
  await patchStatus(db, patch)
  if (ai) await publishKeyStatus(db, cfg)
}

/** Wraps a callable: signed-in active caller holding one of `perms`; unexpected errors become 'internal'. */
function callable<T>(perms: string[], secrets: typeof ALL_SECRETS, fn: (ctx: { db: Db; cfg: KeyedConfig; caller: AiCaller; data: unknown }) => Promise<T>) {
  return onCall({ ...AI_OPTS, secrets }, async (req: CallableRequest) => {
    const db = adminDb()
    const caller = await requireCaller(db, req.auth?.uid, perms)
    const cfg = await effectiveConfig(db)
    try {
      return await fn({ db, cfg, caller, data: req.data })
    } catch (e) {
      if (e instanceof HttpsError) throw e
      if (isAiError(e)) throw toHttpsError(e)
      logger.error('AI callable failed', e)
      throw new HttpsError('internal', ((e as Error)?.message || 'Unexpected server error').slice(0, 300))
    }
  })
}

// ----------------------------------------------------------------------------- chat / reports

/**
 * The app decides what to offer (live voice button, provider list) from ai_status. A new install has no status
 * until the monitor runs, so the chat function publishes it too — once per instance, again when keys change or
 * every 10 minutes.
 */
let keyStatusSeen = { sig: '', at: 0 }
async function publishKeyStatusIfChanged(db: Db, cfg: KeyedConfig) {
  const sig = JSON.stringify([!!cfg.openaiKey, !!cfg.geminiKey, !!cfg.anthropicKey, cfg.keySource])
  if (sig === keyStatusSeen.sig && Date.now() - keyStatusSeen.at < 10 * 60_000) return
  keyStatusSeen = { sig, at: Date.now() }
  try {
    await publishKeyStatus(db, cfg)
  } catch (e) {
    logger.warn('ai_status key publish failed', e)
  }
}

export const aiComplete = callable([AI_PERMS.view], AI_SECRETS, async ({ db, cfg, caller, data }) => {
  await publishKeyStatusIfChanged(db, cfg)
  return runComplete(
    {
      db,
      client: anthropic(cfg),
      openai: cfg.openaiKey ? makeOpenAI(cfg.openaiKey) : null,
      gemini: cfg.geminiKey ? makeGemini(cfg.geminiKey) : null,
      models: { openaiChat: cfg.models.openaiChat, gemini: cfg.models.gemini },
    },
    caller,
    data,
  )
})

// ----------------------------------------------------------------------------- live voice

export const voiceSession = callable([AI_PERMS.view], [OPENAI_API_KEY, GEMINI_API_KEY, EMAIL_TOKEN_KEY], ({ db, cfg, caller, data }) =>
  runVoiceSession(
    {
      db,
      openai: cfg.openaiKey ? makeOpenAI(cfg.openaiKey) : null,
      model: cfg.models.openaiRealtime,
      voice: cfg.models.openaiVoice,
      // Gemini Live fallback: the key stays here; the browser gets a single-use token
      gemini: cfg.geminiKey ? { key: cfg.geminiKey, model: cfg.models.geminiLive, voice: cfg.models.geminiVoice, fetch: (url, init) => fetch(url, init) } : null,
    },
    caller,
    data,
  ),
)

// ----------------------------------------------------------------------------- monitor

export const aiRunMonitor = callable([AI_PERMS.view], ALL_SECRETS, async ({ db, cfg, caller }) => {
  await refreshConfigStatus(db, cfg)
  const settings = await loadSettings(db)
  if (!settings.enabled) throw new HttpsError('failed-precondition', 'AI features are switched off in the AI Control Center.')
  return runMonitor(db, caller.uid)
})

export const aiMonitorScheduled = onSchedule({ ...AI_OPTS, schedule: 'every 30 minutes', timeZone: COMPANY_TZ, secrets: ALL_SECRETS }, async () => {
  const db = adminDb()
  await refreshConfigStatus(db, await effectiveConfig(db))
  const settings = await loadSettings(db)
  if (!settings.enabled) return
  await runMonitor(db, 'system')
})

// ----------------------------------------------------------------------------- accounts

export const emailConnectStart = callable([AI_PERMS.manage], MAIL_SECRETS, async ({ db, cfg, caller, data }) => {
  await refreshConfigStatus(db, cfg, { ai: false })
  return startConnect(mailDeps(db, cfg), caller, data)
})

export const emailOAuthCallback = onRequest({ region: REGION, timeoutSeconds: 120, memory: '256MiB', maxInstances: 5, secrets: MAIL_SECRETS }, async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed')
    return
  }
  const result = await handleOAuthCallback(mailDeps(adminDb(), runtimeConfig()), req.query as Record<string, unknown>)
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  if ('redirect' in result) {
    res.redirect(302, result.redirect)
    return
  }
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  res
    .status(result.status)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ABCkit</title><body style="font-family:system-ui;padding:2rem;max-width:40rem"><h1>Mailbox connection</h1><p>${esc(result.message)}</p><p>You can close this tab and return to ABCkit.</p></body>`)
})

export const emailConnectImap = callable([AI_PERMS.manage], MAIL_SECRETS, ({ db, cfg, caller, data }) => connectImap(mailDeps(db, cfg), caller, data))

export const emailDisconnect = callable([AI_PERMS.manage], MAIL_SECRETS, ({ db, cfg, caller, data }) => disconnectAccount(mailDeps(db, cfg), caller, data))

export const emailSetSync = callable([AI_PERMS.manage], [], ({ db, caller, data }) => setSync({ db }, caller, data))

// ----------------------------------------------------------------------------- sync & analysis

export const emailSyncNow = callable([AI_PERMS.manage, AI_PERMS.email], ALL_SECRETS, async ({ db, cfg, caller, data }) => {
  await refreshConfigStatus(db, cfg)
  if (!tokenKeyOk(cfg)) throw new HttpsError('failed-precondition', 'EMAIL_TOKEN_KEY is not configured on the server. See functions/AI_SETUP.md.')
  const raw = (data ?? {}) as { account_id?: unknown }
  const accountId = typeof raw.account_id === 'string' && raw.account_id ? raw.account_id : undefined
  if (accountId && !/^[a-z]+-[0-9a-f]{16}$/.test(accountId)) throw new HttpsError('invalid-argument', 'account_id is invalid')
  return syncAll({ ...mailDeps(db, cfg), client: anthropic(cfg), deadline: Date.now() + 420_000 }, caller.uid, accountId)
})

export const emailSyncScheduled = onSchedule({ ...AI_OPTS, schedule: 'every 10 minutes', timeZone: COMPANY_TZ, secrets: ALL_SECRETS }, async () => {
  const db = adminDb()
  const cfg = await effectiveConfig(db)
  await refreshConfigStatus(db, cfg)
  const settings = await loadSettings(db)
  if (!settings.email_sync_enabled || !tokenKeyOk(cfg)) return
  const res = await syncAll({ ...mailDeps(db, cfg), client: settings.enabled ? anthropic(cfg) : null, deadline: Date.now() + 420_000 }, 'system')
  if (res.errors.length) logger.warn('emailSyncScheduled finished with errors', res)
})

export const emailAnalyze = callable([AI_PERMS.email], ALL_SECRETS, async ({ db, cfg, caller, data }) => {
  const id = String(((data ?? {}) as { email_id?: unknown }).email_id ?? '')
  if (!id || id.includes('/') || id.length > 1500) throw new HttpsError('invalid-argument', 'email_id is required')
  const settings = await loadSettings(db)
  if (!settings.enabled) throw new HttpsError('failed-precondition', 'AI features are switched off in the AI Control Center.')
  const client = anthropic(cfg)
  if (!client) throw aiNotConfigured()
  const snap = await db.doc(`${AI_COLLECTIONS.emails}/${id}`).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Email not found')
  const email = snap.data() as AiEmail
  if (email.is_demo) throw new HttpsError('failed-precondition', 'Demo emails are analysed in Demo Mode only.')
  const account = (await db.doc(`${AI_COLLECTIONS.accounts}/${email.account_id}`).get()).data() as EmailAccount | undefined
  const deps = mailDeps(db, cfg)
  let session: Awaited<ReturnType<typeof openSession>> | null = null
  const loader =
    email.attachments.length && account && account.status !== 'disconnected' && tokenKeyOk(cfg)
      ? async (name: string) => {
          session ??= await openSession(deps, account)
          return session.downloadAttachment(email.provider_message_id, email.folder, name)
        }
      : null
  try {
    const ai = await analyzeEmail({ db, client, today: companyToday(), ref: await loadReference(db), actor: caller.uid }, email, loader)
    await runMonitor(db, caller.uid).catch((e) => logger.warn('monitor after re-analysis failed', e))
    return { ai }
  } finally {
    await (session as { close(): Promise<void> } | null)?.close().catch(() => undefined)
  }
})

// ----------------------------------------------------------------------------- replies

export const emailGenerateReply = callable([AI_PERMS.email], [ANTHROPIC_API_KEY, EMAIL_TOKEN_KEY], ({ db, cfg, caller, data }) => generateReply({ db, client: anthropic(cfg) }, caller, data))

export const emailSendDraft = callable([AI_PERMS.send], MAIL_SECRETS, ({ db, cfg, caller, data }) => {
  const deps = mailDeps(db, cfg)
  return sendDraft({ db, openSession: (account) => openSession(deps, account) }, caller, data)
})

// ----------------------------------------------------------------------------- AI provider keys (AI Control Center)

export const aiManageKeys = callable([AI_PERMS.manage], AI_SECRETS, ({ db, caller, data }) =>
  runManageKeys({ db, config: runtimeConfig(), fetch: (url, init) => fetch(url, init) }, caller, data),
)
