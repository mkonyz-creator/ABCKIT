/**
 * aiComplete — one model turn for the chat assistant / report writer.
 * The app owns the tool loop: it sends the conversation + its tool definitions, runs returned tool_use blocks under
 * the user's own Firestore permissions and calls again with the tool results. The server never reads business data here.
 */
import { HttpsError } from 'firebase-functions/v2/https'
import type { CallableContracts } from '../shared/ai/contract.js'
import { AI_COLLECTIONS, AI_MEMORY_LIMITS, AI_PAGE_TEXT_LIMIT, CHAT_PROVIDER_LABEL, CHAT_PROVIDERS, type ChatProviderId } from '../shared/ai/contract.js'
import type { Db } from '../lib/admin.js'
import type { AiCaller } from '../lib/auth.js'
import { loadSettings, recordUsage, writeActivity } from '../lib/audit.js'
import { companyToday, startOfCompanyDayIso } from '../lib/time.js'
import { aiNotConfigured, toHttpsError, type AnthropicLike, type BetaMessageParam } from './claude.js'
import { providerOrder, runChain } from './providers/chain.js'
import { claudeProvider } from './providers/claude.js'
import { geminiProvider, type GeminiLike } from './providers/gemini.js'
import { openaiProvider, type OpenAILike } from './providers/openai.js'
import type { Block, CanonMessage, ChatProvider } from './providers/types.js'
import { CHAT_SYSTEM_PROMPT, REPORT_SYSTEM_PROMPT, VOICE_MODE_BLOCK, contextBlock, memoryBlock, pageBlock } from './prompts.js'

type Req = CallableContracts['aiComplete']['req']
type Res = CallableContracts['aiComplete']['res']

export const LIMITS = {
  maxTools: 64,
  maxMessages: 400,
  maxBytes: 400 * 1024,
  maxToolDescription: 4000,
  maxSchemaBytes: 16 * 1024,
  /** base64 of all pictures / PDFs in one request, and of each one (callable requests are limited to ~10 MB) */
  maxAttachmentBytes: 7 * 1024 * 1024,
  maxAttachmentBytesEach: 4.8 * 1024 * 1024,
}

/** the user's saved memories sent with a question: strings only, capped in number and size (oldest dropped first) */
export function cleanMemories(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw bad('context.memories must be a list of strings')
  const out: string[] = []
  let total = 0
  for (const m of v.slice(0, AI_MEMORY_LIMITS.contextItems)) {
    if (typeof m !== 'string') throw bad('context.memories must be a list of strings')
    const s = m.replace(/\s+/g, ' ').trim().slice(0, AI_MEMORY_LIMITS.maxChars + 20)
    if (!s) continue
    if (total + s.length > AI_MEMORY_LIMITS.contextChars) break
    total += s.length
    out.push(s)
  }
  return out
}

const TOOL_NAME_RE = /^[a-z_][a-z0-9_]{0,63}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** content block types a client may send back in the conversation */
const ALLOWED_BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'fallback'])

export interface ValidComplete {
  purpose: 'chat' | 'report'
  messages: BetaMessageParam[]
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  context: { today: string; locale: 'en' | 'sw'; page: { path: string; title: string; text: string } | null; voice: boolean; provider_hint?: ChatProviderId; memories?: string[] }
}

const bad = (msg: string) => new HttpsError('invalid-argument', msg)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** a tool result may carry text plus the pictures / PDFs the assistant read with read_document */
function checkToolResultBlocks(blocks: unknown[], where: string) {
  if (blocks.length > 6) throw bad(`${where}: too many content blocks`)
  blocks.forEach((c, k) => {
    if (!isObj(c)) throw bad(`${where}.content[${k}] must be an object`)
    if (c.type === 'text') {
      if (typeof c.text !== 'string') throw bad(`${where}.content[${k}].text must be a string`)
      return
    }
    if (c.type !== 'image' && c.type !== 'document') throw bad(`${where}.content[${k}] has an unsupported type`)
    const src = c.source
    if (!isObj(src) || src.type !== 'base64' || typeof src.data !== 'string' || !src.data.length) throw bad(`${where}.content[${k}].source must be base64 data`)
    if (src.data.length > LIMITS.maxAttachmentBytesEach) throw bad(`${where}.content[${k}] is too large`)
    if (!BASE64_RE.test(src.data.slice(0, 4096))) throw bad(`${where}.content[${k}].source.data is not base64`)
    if (c.type === 'image' && !IMAGE_TYPES.has(String(src.media_type))) throw bad(`${where}.content[${k}] image type is not supported`)
    if (c.type === 'document' && src.media_type !== 'application/pdf') throw bad(`${where}.content[${k}] document must be a PDF`)
    for (const key of Object.keys(c)) if (!['type', 'source', 'title', 'cache_control'].includes(key)) throw bad(`${where}.content[${k}] has an unexpected field "${key}"`)
  })
}

/** Removes client-supplied cache_control markers (the server places its own breakpoints; max 4 per request). */
function stripCacheControl(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCacheControl)
  if (isObj(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) if (k !== 'cache_control') out[k] = stripCacheControl(val)
    return out
  }
  return v
}

export function validateCompleteRequest(data: unknown, serverToday: string): ValidComplete {
  if (!isObj(data)) throw bad('Request body is required')
  const purpose = data.purpose
  if (purpose !== 'chat' && purpose !== 'report') throw bad('purpose must be "chat" or "report"')

  // ---- tools
  const tools = data.tools ?? []
  if (!Array.isArray(tools)) throw bad('tools must be an array')
  if (tools.length > LIMITS.maxTools) throw bad(`At most ${LIMITS.maxTools} tools are allowed`)
  const names = new Set<string>()
  const cleanTools = tools.map((t, i) => {
    if (!isObj(t)) throw bad(`tools[${i}] must be an object`)
    if (typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) throw bad(`tools[${i}].name is invalid`)
    if (names.has(t.name)) throw bad(`Duplicate tool name ${t.name}`)
    names.add(t.name)
    if (typeof t.description !== 'string' || t.description.length > LIMITS.maxToolDescription) throw bad(`tools[${i}].description is invalid`)
    if (!isObj(t.input_schema) || t.input_schema.type !== 'object') throw bad(`tools[${i}].input_schema must be a JSON Schema object with type "object"`)
    if (JSON.stringify(t.input_schema).length > LIMITS.maxSchemaBytes) throw bad(`tools[${i}].input_schema is too large`)
    return { name: t.name, description: t.description, input_schema: stripCacheControl(t.input_schema) as Record<string, unknown> }
  })

  // ---- messages
  const messages = data.messages
  if (!Array.isArray(messages) || messages.length === 0) throw bad('messages must be a non-empty array')
  if (messages.length > LIMITS.maxMessages) throw bad(`At most ${LIMITS.maxMessages} messages are allowed`)
  // files the assistant read (pictures / PDFs inside tool results) are counted separately from the text
  let attachmentBytes = 0
  let bytes = 0
  try {
    bytes = Buffer.byteLength(
      JSON.stringify(messages, (k, v) => {
        if (k === 'data' && typeof v === 'string' && v.length > 1000) {
          attachmentBytes += v.length
          return ''
        }
        return v
      }),
      'utf8',
    )
  } catch {
    throw bad('messages must be JSON')
  }
  if (attachmentBytes > LIMITS.maxAttachmentBytes) throw bad('The files in this conversation are too large to send together. Start a new chat or ask about one file at a time.')
  if (bytes > LIMITS.maxBytes) throw bad(`The conversation is too long (${Math.round(bytes / 1024)} KB; limit ${LIMITS.maxBytes / 1024} KB). Start a new chat.`)
  messages.forEach((m, i) => {
    if (!isObj(m)) throw bad(`messages[${i}] must be an object`)
    if (m.role !== 'user' && m.role !== 'assistant') throw bad(`messages[${i}].role must be "user" or "assistant"`)
    if (typeof m.content === 'string') {
      if (!m.content.length) throw bad(`messages[${i}].content is empty`)
    } else if (Array.isArray(m.content)) {
      if (!m.content.length) throw bad(`messages[${i}].content is empty`)
      m.content.forEach((b, j) => {
        if (!isObj(b) || typeof b.type !== 'string' || !ALLOWED_BLOCKS.has(b.type)) throw bad(`messages[${i}].content[${j}] has an unsupported type`)
        if (b.type === 'tool_use' && (typeof b.name !== 'string' || !names.has(b.name))) throw bad(`messages[${i}].content[${j}] uses an unknown tool`)
        if ((b.type === 'tool_use' || b.type === 'fallback' || b.type === 'thinking' || b.type === 'redacted_thinking') && m.role !== 'assistant')
          throw bad(`messages[${i}].content[${j}] is only allowed in assistant messages`)
        if (b.type === 'tool_result' && m.role !== 'user') throw bad(`messages[${i}].content[${j}] is only allowed in user messages`)
        if (b.type === 'tool_result' && Array.isArray(b.content)) checkToolResultBlocks(b.content, `messages[${i}].content[${j}]`)
        else if (b.type === 'tool_result' && b.content !== undefined && typeof b.content !== 'string') throw bad(`messages[${i}].content[${j}].content must be a string or an array`)
      })
    } else throw bad(`messages[${i}].content must be a string or an array`)
  })
  if ((messages[0] as Record<string, unknown>).role !== 'user') throw bad('The first message must be from the user')

  // ---- context (only the date and language are taken from the client; name/role come from the profile)
  const ctx = isObj(data.context) ? data.context : {}
  const locale = ctx.locale === 'sw' ? 'sw' : 'en'
  let today = typeof ctx.today === 'string' && DATE_RE.test(ctx.today) ? ctx.today : serverToday
  // tolerate client clock / time zone differences of a day, otherwise use the server's date
  if (Math.abs(Date.parse(today) - Date.parse(serverToday)) > 36 * 3600 * 1000) today = serverToday

  // page the user has open (floating assistant) — plain strings, size-capped; treated as untrusted data in the prompt
  let page: ValidComplete['context']['page'] = null
  if (ctx.page !== undefined && ctx.page !== null) {
    const pg = ctx.page
    if (!isObj(pg) || typeof pg.path !== 'string' || typeof pg.title !== 'string' || typeof pg.text !== 'string') throw bad('context.page must be {path, title, text}')
    page = { path: pg.path.slice(0, 300), title: pg.title.slice(0, 300), text: pg.text.slice(0, AI_PAGE_TEXT_LIMIT) }
  }
  const voice = ctx.voice === true && purpose === 'chat'
  const provider_hint = CHAT_PROVIDERS.find((p) => p === ctx.provider_hint)

  return { purpose, messages: stripCacheControl(messages) as BetaMessageParam[], tools: cleanTools, context: { today, locale, page, voice, ...(provider_hint ? { provider_hint } : {}), ...(purpose === 'chat' && ctx.memories !== undefined ? { memories: cleanMemories(ctx.memories) } : {}) } }
}

/** Number of chat/report model calls the user made today (company time zone). Single-field query, filtered in memory. */
export async function countTodayCalls(db: Db, uid: string, now = new Date()): Promise<number> {
  const since = startOfCompanyDayIso(now)
  const snap = await db.collection(AI_COLLECTIONS.usage).where('at', '>=', since).select('user_id', 'purpose').get()
  return snap.docs.filter((d) => {
    const r = d.data()
    return r.user_id === uid && (r.purpose === 'chat' || r.purpose === 'report')
  }).length
}

export interface CompleteDeps {
  db: Db
  /** Anthropic client (reports; optional chat provider) */
  client: AnthropicLike | null
  openai?: OpenAILike | null
  gemini?: GeminiLike | null
  models?: { openaiChat: string; gemini: string }
  now?: Date
}

/** the configured providers, by id */
export function chatProviders(deps: CompleteDeps): Partial<Record<ChatProviderId, ChatProvider | null>> {
  return {
    openai: deps.openai ? openaiProvider(deps.openai, deps.models?.openaiChat ?? 'gpt-5.5') : null,
    gemini: deps.gemini ? geminiProvider(deps.gemini, deps.models?.gemini ?? 'gemini-3.5-flash') : null,
    claude: deps.client ? claudeProvider(deps.client) : null,
  }
}

export async function runComplete(deps: CompleteDeps, caller: AiCaller, data: unknown): Promise<Res> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const req = validateCompleteRequest(data, companyToday(now))
  const settings = await loadSettings(db)
  if (!settings.enabled) throw new HttpsError('failed-precondition', 'AI features are switched off in the AI Control Center.')
  // phase 1: reports are written by Claude; the chat assistant uses the configured provider order (OpenAI → Gemini → …)
  const order = req.purpose === 'report' ? (['claude'] as ChatProviderId[]) : providerOrder(settings.chat_providers, req.context.provider_hint)
  const providers = chatProviders(deps)
  if (!order.some((id) => providers[id]))
    throw req.purpose === 'report'
      ? aiNotConfigured()
      : new HttpsError('failed-precondition', 'No AI provider is configured for the assistant. An administrator must set OPENAI_API_KEY and/or GEMINI_API_KEY (or ANTHROPIC_API_KEY for Claude) — see functions/AI_SETUP.md.')
  const used = await countTodayCalls(db, caller.uid, now)
  if (used >= settings.daily_chat_limit_per_user)
    throw new HttpsError('resource-exhausted', `Daily AI limit reached (${settings.daily_chat_limit_per_user} requests per user). It resets at midnight East Africa Time.`)

  const system = [
    req.purpose === 'report' ? REPORT_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT,
    contextBlock({ today: req.context.today, userName: caller.name, role: caller.roleKey, locale: req.context.locale }),
    ...(req.context.memories?.length ? [memoryBlock(req.context.memories)] : []),
    ...(req.context.page ? [pageBlock(req.context.page)] : []),
    ...(req.context.voice ? [VOICE_MODE_BLOCK] : []),
  ]

  let chain
  try {
    chain = await runChain(order, providers, {
      purpose: req.purpose,
      system,
      messages: req.messages as unknown as CanonMessage[],
      tools: req.tools,
      maxTokens: req.purpose === 'report' ? 64000 : req.context.voice ? 4000 : 32000,
      voice: req.context.voice,
    })
  } catch (e) {
    await writeActivity(db, caller.uid, req.purpose, `Model call failed: ${(e as Error)?.message ?? e}`, null, false)
    throw e instanceof HttpsError ? e : toHttpsError(e)
  }
  const { result: msg, provider, fallback_from } = chain

  await recordUsage(db, caller.uid, req.purpose, provider === 'claude' ? msg.model : `${provider}:${msg.model}`, msg.usage, provider)

  let content: Block[] = msg.content
  if (msg.stop_reason === 'refusal') {
    // never hand a declined partial back into the conversation
    content = [{ type: 'text', text: req.context.locale === 'sw' ? 'Samahani, siwezi kusaidia na ombi hili.' : 'Sorry, I can’t help with that request.', citations: null }]
  } else if (msg.stop_reason === 'max_tokens') {
    // a tool call cut off mid-way cannot be run
    content = content.filter((b) => b.type !== 'tool_use')
    content.push({ type: 'text', text: '\n\n_(The answer was cut off because it reached the length limit.)_', citations: null })
  }
  const toolNames = msg.content.filter((b) => b.type === 'tool_use').map((b) => String(b.name))
  const via = `${CHAT_PROVIDER_LABEL[provider]}${fallback_from.length ? ` (fallback after ${fallback_from.map((f) => CHAT_PROVIDER_LABEL[f]).join(', ')} failed)` : ''}`
  await writeActivity(
    db,
    caller.uid,
    req.purpose,
    `${req.purpose === 'report' ? 'Report' : 'Chat'} turn by ${via} (${msg.stop_reason ?? 'unknown'})${toolNames.length ? `; tools requested: ${toolNames.join(', ')}` : ''}`,
    null,
    msg.stop_reason !== 'refusal',
  )
  return {
    content,
    stop_reason: msg.stop_reason ?? null,
    model: msg.model,
    usage: { input_tokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), output_tokens: msg.usage.output_tokens },
    provider,
    fallback_from,
  }
}

export type { Req as CompleteRequest }
