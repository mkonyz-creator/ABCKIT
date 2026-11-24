/**
 * Provider selection and fallback for one assistant turn.
 * Providers are tried in the configured order; a provider is only asked when the ones before it are not configured
 * or failed (so company data is not sent to a second provider unless the first one could not answer).
 * A refusal or any other completed answer is final — only errors move on to the next provider.
 */
import { logger } from 'firebase-functions/v2'
import { HttpsError } from 'firebase-functions/v2/https'
import { CHAT_PROVIDER_LABEL, type ChatProviderId } from '../../shared/ai/contract.js'
import { isAiError, toHttpsError } from '../claude.js'
import type { ChatProvider, TurnRequest, TurnResult } from './types.js'

export interface ChainResult {
  result: TurnResult
  provider: ChatProviderId
  fallback_from: ChatProviderId[]
}

export function providerOrder(configured: ChatProviderId[], hint: ChatProviderId | undefined): ChatProviderId[] {
  const order = [...new Set(configured)]
  // keep a conversation on the provider that answered its previous turn (if it is still allowed)
  if (hint && order.includes(hint)) return [hint, ...order.filter((p) => p !== hint)]
  return order
}

function shortError(e: unknown) {
  const err = e as { status?: number; message?: string }
  return `${err?.status ? `${err.status} ` : ''}${String(err?.message ?? e).slice(0, 200)}`
}

export async function runChain(order: ChatProviderId[], providers: Partial<Record<ChatProviderId, ChatProvider | null>>, req: TurnRequest): Promise<ChainResult> {
  const failed: Array<{ id: ChatProviderId; error: unknown }> = []
  for (const id of order) {
    const p = providers[id]
    if (!p) continue
    try {
      const result = await p.turn(req)
      if (failed.length) logger.warn('AI provider fallback', { answered: id, failed: failed.map((f) => `${f.id}: ${shortError(f.error)}`) })
      return { result, provider: id, fallback_from: failed.map((f) => f.id) }
    } catch (e) {
      logger.warn(`AI provider ${id} failed`, shortError(e))
      failed.push({ id, error: e })
    }
  }
  if (!failed.length)
    throw new HttpsError(
      'failed-precondition',
      `No AI provider is configured for this feature (${order.map((o) => CHAT_PROVIDER_LABEL[o]).join(', ') || 'none selected'}). An administrator must set OPENAI_API_KEY, GEMINI_API_KEY and/or ANTHROPIC_API_KEY — see functions/AI_SETUP.md.`,
    )
  // a single provider failed: report its own error, as before the provider chain existed
  if (failed.length === 1) throw isAiError(failed[0].error) || !(failed[0].error instanceof HttpsError) ? toHttpsError(failed[0].error) : failed[0].error
  throw new HttpsError('unavailable', `The AI service is not available right now (${failed.map((f) => `${CHAT_PROVIDER_LABEL[f.id]}: ${shortError(f.error)}`).join('; ')}). Try again in a moment.`)
}
