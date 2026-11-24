/**
 * Provider-neutral shape of one assistant turn.
 *
 * The app's tool loop speaks one message format (Anthropic-style content blocks: text, tool_use, tool_result with
 * optional image / PDF blocks). Each provider adapter translates that to its own API and back, so the loop, the tools
 * and the audit trail stay the same whichever provider answers.
 */
import type { ChatProviderId } from '../../shared/ai/contract.js'

export type Block = { type: string; [k: string]: any }
export interface CanonMessage {
  role: 'user' | 'assistant'
  content: string | Block[]
}
export interface CanonTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface TurnRequest {
  purpose: 'chat' | 'report'
  /** system prompt parts; [0] is the long static prompt (cacheable), the rest are per-request context */
  system: string[]
  messages: CanonMessage[]
  tools: CanonTool[]
  maxTokens: number
  /** spoken conversation: answer fast */
  voice: boolean
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | string

export interface TurnResult {
  /** text and tool_use blocks (tool_use may carry a provider `signature` that must be echoed back) */
  content: Block[]
  stop_reason: StopReason | null
  model: string
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
}

export interface ChatProvider {
  id: ChatProviderId
  turn(req: TurnRequest): Promise<TurnResult>
}

/** text of a tool_result's content (string or blocks) */
export function toolResultText(b: Block): string {
  const c = b.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x: Block) => x.type === 'text').map((x: Block) => String(x.text ?? '')).join('\n') : ''
  return b.is_error ? `ERROR: ${text}` : text
}

/** image / PDF blocks inside a tool_result */
export function toolResultAttachments(b: Block): Block[] {
  return Array.isArray(b.content) ? b.content.filter((x: Block) => x.type === 'image' || x.type === 'document') : []
}

export function safeJson(s: unknown): Record<string, unknown> {
  if (s && typeof s === 'object') return s as Record<string, unknown>
  try {
    const v = JSON.parse(String(s ?? '{}'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}
