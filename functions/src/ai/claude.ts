/**
 * Claude API access. Every model call goes through the beta Messages endpoint so server-side refusal fallbacks
 * (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) are on by default.
 * The client is injectable (`AnthropicLike`) so unit tests never touch the network.
 */
import Anthropic from '@anthropic-ai/sdk'
import { HttpsError } from 'firebase-functions/v2/https'

/** The one model used everywhere. */
export const MODEL = 'claude-opus-5-5'

/** Spread into every request: server-side refusal fallback routed by refusal category. */
export const FALLBACK_PARAMS = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
} as const satisfies Pick<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, 'betas' | 'fallbacks'>

export type AnthropicLike = Pick<Anthropic, 'beta'>
export type BetaMessage = Anthropic.Beta.Messages.BetaMessage
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam
export type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock

export function makeClient(apiKey: string): AnthropicLike {
  // SDK retries 408/409/429/5xx and connection errors itself (maxRetries); timeout in ms.
  return new Anthropic({ apiKey, maxRetries: 3, timeout: 8 * 60 * 1000 })
}

/** Raised when the model output cannot be used (refusal / truncated). */
export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly stopReason: string | null,
  ) {
    super(message)
  }
}

/** stop_reason guard: call before reading content. */
export function assertUsable(msg: Pick<BetaMessage, 'stop_reason'>, what: string): void {
  if (msg.stop_reason === 'refusal') throw new ModelOutputError(`The AI declined to produce the ${what}.`, 'refusal')
  if (msg.stop_reason === 'max_tokens') throw new ModelOutputError(`The AI ${what} was cut off (output limit reached).`, 'max_tokens')
}

export function textOf(msg: Pick<BetaMessage, 'content'>): string {
  return msg.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Extra retry layer for long batch work (email analysis) on top of the SDK's own retries:
 * retries rate limits, 5xx/overload and connection errors; never retries 4xx request errors.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const retryable = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError
      if (!retryable || i >= attempts) throw e
      let wait = 2000 * 2 ** i
      if (e instanceof Anthropic.RateLimitError) {
        const ra = Number(e.headers?.get?.('retry-after'))
        if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra * 1000, 60_000)
      }
      await sleep(wait)
    }
  }
}

export function isAiError(e: unknown): boolean {
  return e instanceof Anthropic.APIError || e instanceof ModelOutputError
}

/** Maps SDK errors (most specific first) to callable errors with a clear message. */
export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e
  if (e instanceof ModelOutputError) return new HttpsError('aborted', e.message)
  if (e instanceof Anthropic.AuthenticationError) return new HttpsError('failed-precondition', 'The Anthropic API key on the server is invalid. Ask an administrator to update ANTHROPIC_API_KEY.')
  if (e instanceof Anthropic.PermissionDeniedError) return new HttpsError('failed-precondition', 'The Anthropic API key is not allowed to use this model.')
  if (e instanceof Anthropic.NotFoundError) return new HttpsError('failed-precondition', `The AI model ${MODEL} is not available to this Anthropic account.`)
  if (e instanceof Anthropic.RateLimitError) return new HttpsError('resource-exhausted', 'The AI service is busy (rate limit). Please try again in a minute.')
  if (e instanceof Anthropic.BadRequestError) return new HttpsError('invalid-argument', `The AI request was rejected: ${e.message}`)
  if (e instanceof Anthropic.InternalServerError) return new HttpsError('unavailable', 'The AI service is temporarily unavailable. Please try again.')
  if (e instanceof Anthropic.APIConnectionError) return new HttpsError('unavailable', 'Could not reach the AI service. Please try again.')
  if (e instanceof Anthropic.APIError) return new HttpsError('internal', `AI service error${e.status ? ` (${e.status})` : ''}`)
  return providerHttpsError(e)
}

/** Errors of the other providers (the Gemini / OpenAI SDKs carry an HTTP status) → a clear message, English · Kiswahili. */
export function providerHttpsError(e: unknown): HttpsError {
  const err = e as { status?: unknown; code?: unknown; message?: unknown; name?: unknown }
  const m = /"code"\s*:\s*(\d{3})/.exec(String(err?.message ?? ''))
  // only 100–599 is an HTTP status (a timeout DOMException has code 23)
  const http = (v: unknown) => (typeof v === 'number' && v >= 100 && v <= 599 ? v : undefined)
  const status = http(err?.status) ?? http(err?.code) ?? (m ? Number(m[1]) : undefined)
  const text = `${String(err?.name ?? '')} ${String(err?.message ?? '')}`
  if (status === 429) return new HttpsError('resource-exhausted', 'The AI service is busy or its free quota is used up. Try again in a minute. · Huduma ya AI imezidiwa au kiwango chake cha bure kimeisha — jaribu tena baada ya dakika moja.')
  if (status === 401 || status === 403) return new HttpsError('failed-precondition', 'The AI API key on the server is invalid or not allowed. Ask an administrator to check it. · API key ya AI haikubaliki — mwombe admin aikague.')
  if (status === 404) return new HttpsError('failed-precondition', 'The AI model is not available to this account. Ask an administrator to choose another model. · Model ya AI haipatikani kwa akaunti hii.')
  if (status === 400) return new HttpsError('invalid-argument', `The AI request was rejected: ${String(err?.message ?? '').slice(0, 200)}`)
  if (status !== undefined && status >= 500) return new HttpsError('unavailable', 'The AI service is overloaded right now. Try again in a moment. · Huduma ya AI imezidiwa kwa sasa — jaribu tena baada ya muda mfupi.')
  if (/abort|timed? ?out|deadline/i.test(text)) return new HttpsError('deadline-exceeded', 'The AI took too long to answer. Try again (a shorter question helps). · AI imechelewa kujibu — jaribu tena.')
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|network/i.test(text)) return new HttpsError('unavailable', 'Could not reach the AI service. Check the internet connection and try again. · Imeshindikana kufikia huduma ya AI — angalia mtandao.')
  return new HttpsError('internal', 'Unexpected AI error')
}

export function aiNotConfigured(): HttpsError {
  return new HttpsError('failed-precondition', 'AI is not configured on the server (ANTHROPIC_API_KEY is not set). See functions/AI_SETUP.md.')
}

/**
 * After a mid-output server-side fallback, blocks before the last `fallback` block that must not be echoed back
 * (thinking, redacted_thinking, tool_use, unpaired server tool use) are removed so the app can append the returned
 * content to the conversation as-is. Text blocks and the fallback block itself stay in place.
 */
export function echoSafeContent(content: BetaContentBlock[]): BetaContentBlock[] {
  let last = -1
  content.forEach((b, i) => {
    if (b.type === 'fallback') last = i
  })
  if (last < 0) return content
  const drop = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'])
  return content.filter((b, i) => i >= last || !drop.has(b.type))
}
