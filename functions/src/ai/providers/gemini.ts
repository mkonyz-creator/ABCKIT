/**
 * Google Gemini adapter (generateContent with function declarations). Fallback provider of the chat assistant.
 * Gemini 3 models return a thoughtSignature with each function call that must be sent back with that call;
 * it travels in the canonical tool_use block as `signature`.
 */
import { randomUUID } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'
import { logger } from 'firebase-functions/v2'
import { toolResultAttachments, toolResultText, type Block, type CanonMessage, type ChatProvider, type TurnRequest, type TurnResult } from './types.js'

export interface GeminiLike {
  models: { generateContent(params: any): Promise<any> }
}

export function makeGemini(apiKey: string): GeminiLike {
  // @google/genai 3.x defaults to API v1, where the "-latest" aliases and some tool fields are missing: pin v1beta
  return new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000, apiVersion: 'v1beta' } }) as unknown as GeminiLike
}

/** documented placeholder for function calls that did not come from Gemini (e.g. after a provider switch) */
export const SKIP_SIGNATURE = 'skip_thought_signature_validator'

/** ids we generated for id-less Gemini calls (gm_…) are not sent back */
const ownId = (id: unknown) => (typeof id === 'string' && id && !id.startsWith('gm_') ? { id } : {})

export function toGeminiContents(messages: CanonMessage[], skipSignatures = false): Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> {
  const names = new Map<string, string>()
  const out: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts: Array<Record<string, unknown>> = []
    if (typeof m.content === 'string') parts.push({ text: m.content })
    else
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ text: String(b.text) })
        else if (b.type === 'tool_use') {
          names.set(String(b.id), String(b.name))
          parts.push({ functionCall: { ...ownId(b.id), name: String(b.name), args: b.input ?? {} }, thoughtSignature: !skipSignatures && typeof b.signature === 'string' && b.signature ? b.signature : SKIP_SIGNATURE })
        } else if (b.type === 'tool_result') {
          parts.push({ functionResponse: { ...ownId(b.tool_use_id), name: names.get(String(b.tool_use_id)) ?? 'tool', response: { output: toolResultText(b) } } })
          for (const f of toolResultAttachments(b)) parts.push({ inlineData: { mimeType: f.type === 'image' ? f.source.media_type : 'application/pdf', data: f.source.data } })
        }
      }
    if (parts.length) out.push({ role, parts })
  }
  return out
}

const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'])

export function fromGeminiResponse(res: any, model: string): TurnResult {
  const cand = res?.candidates?.[0]
  const content: Block[] = []
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought) continue
    if (typeof p.text === 'string' && p.text) content.push({ type: 'text', text: p.text })
    if (p.functionCall) {
      content.push({
        type: 'tool_use',
        id: String(p.functionCall.id || `gm_${randomUUID().replace(/-/g, '').slice(0, 20)}`),
        name: String(p.functionCall.name),
        input: p.functionCall.args ?? {},
        ...(p.thoughtSignature ? { signature: String(p.thoughtSignature) } : {}),
      })
    }
  }
  const finish = String(cand?.finishReason ?? '')
  const blocked = BLOCKED.has(finish) || !!res?.promptFeedback?.blockReason
  const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : blocked ? 'refusal' : 'end_turn'
  const u = res?.usageMetadata ?? {}
  const cached = u.cachedContentTokenCount ?? 0
  return {
    content,
    stop_reason: stop,
    model: String(res?.modelVersion ?? model),
    usage: { input_tokens: Math.max(0, (u.promptTokenCount ?? 0) - cached), output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cache_read_input_tokens: cached },
  }
}

/**
 * Lighter Gemini models tried (in order) when the configured one is overloaded (503), out of quota (429), gone (404)
 * or too slow. Same provider and key, so no company data goes to a second provider.
 */
export const GEMINI_FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3-flash-preview']
/** time allowed for one model before the next one is tried */
export const GEMINI_ATTEMPT_MS = 35_000
/** a model that just failed this way is tried last for this long (per server instance) */
export const GEMINI_COOLDOWN_MS = 120_000

const http = (v: unknown) => (typeof v === 'number' && v >= 100 && v <= 599 ? v : undefined)
/**
 * HTTP status of a @google/genai error (ApiError.status, or the JSON in its message). Only 100–599 counts:
 * a timeout is a DOMException whose `code` is 23, which is not an HTTP status.
 */
export function geminiStatus(e: unknown): number | undefined {
  const err = e as { status?: unknown; code?: unknown; message?: unknown }
  const m = /"code"\s*:\s*(\d{3})/.exec(String(err?.message ?? ''))
  return http(err?.status) ?? http(err?.code) ?? (m ? Number(m[1]) : undefined)
}
const isTimeout = (e: unknown) => /abort|timed? ?out|deadline/i.test(`${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? ''}`)
/** worth trying another model: overloaded / quota / model missing / server error / too slow */
export function geminiRetryable(e: unknown) {
  const s = geminiStatus(e)
  return s === 404 || s === 408 || s === 429 || (s !== undefined && s >= 500) || (s === undefined && isTimeout(e))
}
const badSignature = (e: unknown) => geminiStatus(e) === 400 && /thought.?signature/i.test(String((e as Error)?.message ?? ''))

const cooling = new Map<string, number>()
export function resetGeminiCooldown() {
  cooling.clear()
}

export function geminiProvider(client: GeminiLike, model: string, fallbacks: string[] = GEMINI_FALLBACK_MODELS, attemptMs = GEMINI_ATTEMPT_MS): ChatProvider {
  const all = [...new Set([model, ...fallbacks].filter(Boolean))]
  return {
    id: 'gemini',
    async turn(req: TurnRequest) {
      const now = Date.now()
      // healthy models first; the ones that just failed go last (still tried, in case they recovered)
      const order = [...all.filter((m) => !((cooling.get(m) ?? 0) > now)), ...all.filter((m) => (cooling.get(m) ?? 0) > now)]
      const call = (m: string, skipSignatures: boolean) =>
        client.models.generateContent({
          model: m,
          contents: toGeminiContents(req.messages, skipSignatures),
          config: {
            systemInstruction: req.system.join('\n\n'),
            tools: req.tools.length ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }] : undefined,
            maxOutputTokens: req.maxTokens,
            abortSignal: AbortSignal.timeout(attemptMs),
          },
        })
      let last: unknown
      for (const m of order) {
        try {
          let res
          try {
            res = await call(m, false)
          } catch (e) {
            // a thought signature made by another model (after a fallback) is not accepted: send the placeholder
            if (!badSignature(e)) throw e
            res = await call(m, true)
          }
          cooling.delete(m)
          if (m !== model) logger.warn('Gemini model fallback', { configured: model, answered: m })
          return fromGeminiResponse(res, m)
        } catch (e) {
          last = e
          if (!geminiRetryable(e)) throw e
          cooling.set(m, Date.now() + GEMINI_COOLDOWN_MS)
          logger.warn(`Gemini model ${m} failed`, `${geminiStatus(e) ?? ''} ${String((e as Error)?.message ?? e).slice(0, 160)}`)
        }
      }
      throw last
    },
  }
}
