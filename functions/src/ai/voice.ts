/**
 * voiceSession — a short-lived credential for one live voice conversation (hybrid: OpenAI first, Gemini fallback).
 *
 *  - OpenAI Realtime: an ephemeral client secret; the browser connects over WebRTC (POST /v1/realtime/calls).
 *  - Google Gemini Live API: an ephemeral, single-use auth token whose Live setup (model, prompt, voice, tools) is
 *    LOCKED in the token; the browser connects over WebSocket (BidiGenerateContentConstrained).
 * The real API keys never leave the server. Gemini is used only when OpenAI is not configured, fails here, or the
 * browser could not connect to it (`exclude: ['openai']`): one conversation goes to one provider only. The session is configured here: the ABCkit system prompt, the user's context, the page
 * on screen, voice settings and the tool definitions. Tools still run in the browser under the user's own
 * Firestore permissions; action tools still ask the user to confirm.
 */
import { HttpsError } from 'firebase-functions/v2/https'
import type { CallableContracts } from '../shared/ai/contract.js'
import { AI_COLLECTIONS, AI_PAGE_TEXT_LIMIT } from '../shared/ai/contract.js'
import type { Db } from '../lib/admin.js'
import type { AiCaller } from '../lib/auth.js'
import { loadSettings, recordUsage, writeActivity } from '../lib/audit.js'
import { companyToday, startOfCompanyDayIso } from '../lib/time.js'
import { LIMITS, cleanMemories } from './complete.js'
import { CHAT_SYSTEM_PROMPT, REALTIME_VOICE_BLOCK, contextBlock, memoryBlock, pageBlock } from './prompts.js'
import type { OpenAILike } from './providers/openai.js'

type Res = CallableContracts['voiceSession']['res']

const TOOL_NAME_RE = /^[a-z_][a-z0-9_]{0,63}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const bad = (msg: string) => new HttpsError('invalid-argument', msg)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** how long the browser has to open the WebRTC connection with the key */
export const VOICE_KEY_TTL_SECONDS = 120
export const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'

export type VoiceProvider = 'openai' | 'gemini'
export const VOICE_PROVIDERS: VoiceProvider[] = ['openai', 'gemini']
export const GEMINI_TOKENS_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'
export const GEMINI_LIVE_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'
/** a Gemini Live token: the call must START within 2 minutes; the token is dead after 30 minutes */
export const GEMINI_NEW_SESSION_SECONDS = 120
export const GEMINI_TOKEN_SECONDS = 30 * 60

export interface ValidVoice {
  exclude: VoiceProvider[]
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  today: string
  locale: 'en' | 'sw'
  page: { path: string; title: string; text: string } | null
  /** the user's saved memories (newest first, capped) */
  memories?: string[]
}

export function validateVoiceRequest(data: unknown, serverToday: string): ValidVoice {
  if (!isObj(data)) throw bad('Request body is required')
  const tools = data.tools ?? []
  if (!Array.isArray(tools) || tools.length > LIMITS.maxTools) throw bad(`tools must be an array of at most ${LIMITS.maxTools}`)
  const names = new Set<string>()
  const clean = tools.map((t, i) => {
    if (!isObj(t) || typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name) || names.has(t.name)) throw bad(`tools[${i}].name is invalid`)
    names.add(t.name)
    if (typeof t.description !== 'string' || t.description.length > LIMITS.maxToolDescription) throw bad(`tools[${i}].description is invalid`)
    if (!isObj(t.input_schema) || t.input_schema.type !== 'object' || JSON.stringify(t.input_schema).length > LIMITS.maxSchemaBytes) throw bad(`tools[${i}].input_schema is invalid`)
    return { name: t.name, description: t.description, input_schema: t.input_schema }
  })
  const ctx = isObj(data.context) ? data.context : {}
  let today = typeof ctx.today === 'string' && DATE_RE.test(ctx.today) ? ctx.today : serverToday
  if (Math.abs(Date.parse(today) - Date.parse(serverToday)) > 36 * 3600 * 1000) today = serverToday
  let page: ValidVoice['page'] = null
  if (ctx.page !== undefined && ctx.page !== null) {
    const pg = ctx.page
    if (!isObj(pg) || typeof pg.path !== 'string' || typeof pg.title !== 'string' || typeof pg.text !== 'string') throw bad('context.page must be {path, title, text}')
    page = { path: pg.path.slice(0, 300), title: pg.title.slice(0, 300), text: pg.text.slice(0, AI_PAGE_TEXT_LIMIT) }
  }
  const ex = data.exclude ?? []
  if (!Array.isArray(ex) || ex.some((p) => !VOICE_PROVIDERS.includes(p as VoiceProvider))) throw bad('exclude must list voice providers (openai, gemini)')
  return { exclude: [...new Set(ex as VoiceProvider[])], tools: clean, today, locale: ctx.locale === 'en' ? 'en' : 'sw', page, memories: cleanMemories(ctx.memories) }
}

export async function countTodayVoiceSessions(db: Db, uid: string, now = new Date()): Promise<number> {
  const snap = await db.collection(AI_COLLECTIONS.usage).where('at', '>=', startOfCompanyDayIso(now)).select('user_id', 'purpose').get()
  return snap.docs.filter((d) => d.data().user_id === uid && d.data().purpose === 'voice').length
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>

export interface VoiceDeps {
  db: Db
  openai: OpenAILike | null
  model: string
  voice: string
  /** Gemini Live fallback (null / absent = no Gemini key) */
  gemini?: { key: string; model: string; voice: string; fetch: FetchLike } | null
  now?: Date
}

function voiceInstructions(v: ValidVoice, caller: AiCaller) {
  return [
    CHAT_SYSTEM_PROMPT,
    contextBlock({ today: v.today, userName: caller.name, role: caller.roleKey, locale: v.locale }),
    ...(v.memories?.length ? [memoryBlock(v.memories)] : []),
    ...(v.page ? [pageBlock(v.page)] : []),
    REALTIME_VOICE_BLOCK,
  ].join('\n\n')
}

/** the Realtime session configuration (also used by the tests) */
export function buildVoiceSession(v: ValidVoice, caller: AiCaller, model: string, voice: string) {
  return {
    type: 'realtime' as const,
    model,
    instructions: voiceInstructions(v, caller),
    output_modalities: ['audio' as const],
    audio: {
      input: {
        // transcribe what the user says in the language they chose (Kiswahili is otherwise often heard as another language)
        transcription: { model: TRANSCRIPTION_MODEL, language: v.locale },
        noise_reduction: { type: 'near_field' as const },
        // the model notices when the user starts talking and stops speaking (interruptions)
        turn_detection: { type: 'semantic_vad' as const, create_response: true, interrupt_response: true },
      },
      output: { voice },
    },
    tools: v.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.input_schema })),
    tool_choice: 'auto' as const,
  }
}

/** the Gemini Live setup (BidiGenerateContentSetup) locked inside the ephemeral token (also used by the tests) */
export function buildGeminiLiveSetup(v: ValidVoice, caller: AiCaller, model: string, voice: string) {
  return {
    model: `models/${model}`,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    systemInstruction: { parts: [{ text: voiceInstructions(v, caller) }] },
    ...(v.tools.length
      ? { tools: [{ functionDeclarations: v.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }] }
      : {}),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // long calls: older turns are compressed instead of the session ending at the context limit
    contextWindowCompression: { slidingWindow: {} },
  }
}

const parseJson = (text: string): any => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** POST /v1beta/auth_tokens with the server key: a single-use token bound to this setup */
export async function createGeminiLiveToken(fetch: FetchLike, key: string, setup: ReturnType<typeof buildGeminiLiveSetup>, now: Date) {
  const iso = (sec: number) => new Date(now.getTime() + sec * 1000).toISOString()
  const res = await fetch(GEMINI_TOKENS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    // no fieldMask: the token's setup is used and the browser's setup message cannot change it
    body: JSON.stringify({ uses: 1, expireTime: iso(GEMINI_TOKEN_SECONDS), newSessionExpireTime: iso(GEMINI_NEW_SESSION_SECONDS), bidiGenerateContentSetup: setup }),
  })
  const text = await res.text().catch(() => '')
  const body = parseJson(text)
  if (res.status < 200 || res.status >= 300) throw new Error(`Gemini ${res.status}: ${String(body?.error?.message ?? text).slice(0, 200)}`)
  const name = body?.name
  if (typeof name !== 'string' || !name) throw new Error('Gemini returned no token')
  return { token: name, expires_at: Math.floor(now.getTime() / 1000) + GEMINI_NEW_SESSION_SECONDS }
}

const LABEL: Record<VoiceProvider, string> = { openai: 'OpenAI', gemini: 'Google Gemini' }

export async function runVoiceSession(deps: VoiceDeps, caller: AiCaller, data: unknown): Promise<Res> {
  const now = deps.now ?? new Date()
  const v = validateVoiceRequest(data, companyToday(now))
  const settings = await loadSettings(deps.db)
  if (!settings.enabled) throw new HttpsError('failed-precondition', 'AI features are switched off in the AI Control Center.')
  if (!settings.voice_enabled) throw new HttpsError('failed-precondition', 'Live voice is switched off in the AI Control Center.')
  const available: Record<VoiceProvider, boolean> = { openai: !!deps.openai, gemini: !!deps.gemini }
  if (!available.openai && !available.gemini)
    throw new HttpsError(
      'failed-precondition',
      'Live voice needs an OpenAI API key (OPENAI_API_KEY) or a Google Gemini API key (GEMINI_API_KEY) on the server — add one in System Settings → AI API keys, or see functions/AI_SETUP.md.',
    )
  const order = VOICE_PROVIDERS.filter((p) => available[p] && !v.exclude.includes(p))
  if (!order.length) throw new HttpsError('unavailable', 'No other live voice provider is configured to fall back to.')
  const used = await countTodayVoiceSessions(deps.db, caller.uid, now)
  if (used >= settings.daily_voice_sessions_per_user)
    throw new HttpsError('resource-exhausted', `Daily live-voice limit reached (${settings.daily_voice_sessions_per_user} conversations per user). It resets at midnight East Africa Time.`)

  // one provider at a time: the next one is asked only when the previous one failed
  const failures: string[] = []
  const fallbackFrom = v.exclude.filter((p) => available[p])
  for (const provider of order) {
    try {
      let res: Res
      if (provider === 'openai') {
        const secret: { value?: string; expires_at?: number } = await deps.openai!.realtime.clientSecrets.create({
          expires_after: { anchor: 'created_at', seconds: VOICE_KEY_TTL_SECONDS },
          session: buildVoiceSession(v, caller, deps.model, deps.voice),
        })
        if (!secret?.value) throw new Error('no session key returned')
        res = {
          provider,
          client_secret: secret.value,
          expires_at: Number(secret.expires_at ?? Math.floor(now.getTime() / 1000) + VOICE_KEY_TTL_SECONDS),
          model: deps.model,
          voice: deps.voice,
        }
      } else {
        const g = deps.gemini!
        const setup = buildGeminiLiveSetup(v, caller, g.model, g.voice)
        const tok = await createGeminiLiveToken(g.fetch, g.key, setup, now)
        // the setup goes back too, so the browser's setup message matches the one locked in the token
        res = { provider, client_secret: tok.token, expires_at: tok.expires_at, model: g.model, voice: g.voice, ws_url: GEMINI_LIVE_WS_URL, setup }
      }
      if (fallbackFrom.length) res.fallback_from = [...fallbackFrom]
      await recordUsage(deps.db, caller.uid, 'voice', `${provider}:${res.model}`, { input_tokens: 0, output_tokens: 0 }, provider)
      const extra = `${v.page ? `, page ${v.page.path}` : ''}${fallbackFrom.length ? `, fallback from ${fallbackFrom.map((p) => LABEL[p]).join(', ')}` : ''}`
      await writeActivity(deps.db, caller.uid, 'voice', `Live voice conversation started (${LABEL[provider]} ${res.model}, ${v.tools.length} tools${extra})`)
      return res
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300)
      failures.push(`${LABEL[provider]}: ${msg}`)
      fallbackFrom.push(provider)
      await writeActivity(deps.db, caller.uid, 'voice', `Live voice session could not start with ${LABEL[provider]}: ${msg}`, null, false)
    }
  }
  throw new HttpsError('unavailable', `The live voice service is not available right now (${failures.join('; ')}).`)
}
