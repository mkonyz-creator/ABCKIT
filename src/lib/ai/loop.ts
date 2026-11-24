/**
 * The assistant's tool-use loop. The model is reached only through the `aiComplete` callable (the server
 * holds the API key and the system prompt); every tool the model asks for runs here, in the browser,
 * under the signed-in user's permissions.
 *
 *   send {purpose, messages, tools, context} → {content, stop_reason}
 *   stop_reason 'tool_use' → run each tool_use block, append the assistant turn + ONE user turn with all
 *   tool_result blocks, repeat (max rounds); 'end_turn' → done; 'refusal' / 'max_tokens' handled gracefully.
 */
import type { AiToolDef, CallableContracts, ChatProviderId, RecordRef } from '@/shared/ai/contract'
import { callAi, type Invoker } from './api'
import type { ToolResult } from './tools'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; [k: string]: unknown }>; is_error?: boolean }
  | { type: string; [k: string]: unknown }

export interface ApiMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface LoopStep {
  round: number
  /** tools being run in this round */
  tools: Array<{ id: string; name: string; input: unknown; status: 'running' | 'done' | 'error' }>
}

export interface LoopResult {
  text: string
  stopReason: string | null
  toolsUsed: string[]
  links: RecordRef[]
  /** full transcript including tool rounds (not stored; chats keep only the plain text turns) */
  messages: ApiMessage[]
  model: string
  rounds: number
  usage: { input_tokens: number; output_tokens: number }
  /** the AI provider that answered the last round (OpenAI / Gemini / Claude) */
  provider?: ChatProviderId
  /** providers that failed during this answer */
  fallback_from: ChatProviderId[]
}

export interface LoopOptions {
  fns: Invoker
  purpose: 'chat' | 'report'
  messages: ApiMessage[]
  tools: AiToolDef[]
  context: CallableContracts['aiComplete']['req']['context']
  execute: (name: string, input: unknown) => Promise<ToolResult>
  maxRounds?: number
  onStep?: (step: LoopStep) => void
  signal?: AbortSignal
}

export const MAX_ROUNDS = 8

const textOf = (content: ContentBlock[]) =>
  content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n\n')
    .trim()

export async function runAssistant(opts: LoopOptions): Promise<LoopResult> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS
  const messages: ApiMessage[] = [...opts.messages]
  const toolsUsed: string[] = []
  const links: RecordRef[] = []
  const usage = { input_tokens: 0, output_tokens: 0 }
  let model = ''
  let provider: ChatProviderId | undefined = opts.context.provider_hint
  const fallback: ChatProviderId[] = []
  const toolNames = new Set(opts.tools.map((t) => t.name))

  for (let round = 1; round <= maxRounds; round++) {
    if (opts.signal?.aborted) throw new Error('Stopped')
    // stay on the provider that answered the previous round, so one answer is not split across providers
    const res = await callAi(opts.fns, 'aiComplete', { purpose: opts.purpose, messages, tools: opts.tools, context: { ...opts.context, ...(provider ? { provider_hint: provider } : {}) } })
    model = res.model || model
    provider = res.provider ?? provider
    for (const f of res.fallback_from ?? []) if (!fallback.includes(f)) fallback.push(f)
    usage.input_tokens += res.usage?.input_tokens ?? 0
    usage.output_tokens += res.usage?.output_tokens ?? 0
    const content = (Array.isArray(res.content) ? res.content : []) as ContentBlock[]
    const stop = res.stop_reason
    const done = (text: string): LoopResult => ({ text, stopReason: stop, toolsUsed, links, messages: [...messages, { role: 'assistant', content }], model, rounds: round, usage, provider, fallback_from: fallback })

    if (stop === 'tool_use') {
      const calls = content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
      if (!calls.length) return done(textOf(content) || 'The assistant did not return an answer.')
      const step: LoopStep = { round, tools: calls.map((c) => ({ id: c.id, name: c.name, input: c.input, status: 'running' })) }
      opts.onStep?.({ ...step, tools: step.tools.map((t) => ({ ...t })) })
      const results = await Promise.all(
        calls.map(async (c, i): Promise<ContentBlock> => {
          let r: ToolResult
          if (!toolNames.has(c.name)) r = { content: JSON.stringify({ error: `Unknown tool "${c.name}"` }), is_error: true, links: [] }
          else {
            try {
              r = await opts.execute(c.name, c.input)
            } catch (e) {
              r = { content: JSON.stringify({ error: (e as Error)?.message ?? String(e) }), is_error: true, links: [] }
            }
          }
          step.tools[i].status = r.is_error ? 'error' : 'done'
          if (!r.is_error && !toolsUsed.includes(c.name)) toolsUsed.push(c.name)
          for (const l of r.links) if (!links.some((x) => x.link === l.link && x.label === l.label) && links.length < 30) links.push(l)
          return { type: 'tool_result', tool_use_id: c.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) }
        }),
      )
      opts.onStep?.({ ...step, tools: step.tools.map((t) => ({ ...t })) })
      messages.push({ role: 'assistant', content }, { role: 'user', content: results })
      continue
    }
    if (stop === 'pause_turn') {
      // server-side tool paused a long turn: send the partial assistant turn back to continue it
      messages.push({ role: 'assistant', content })
      continue
    }
    if (stop === 'refusal') return done(textOf(content) || '> **The assistant declined this request.** Try rephrasing it as a question about company operations.')
    if (stop === 'max_tokens') {
      const t = textOf(content)
      return done(/cut off/i.test(t) ? t : `${t}\n\n_(The answer was cut off because it reached the length limit. Ask for a shorter answer or a narrower topic.)_`.trim())
    }
    return done(textOf(content) || 'The assistant returned an empty answer.')
  }
  return {
    text: `> **Stopped after ${maxRounds} rounds of data lookups without a final answer.** Try a more specific question.`,
    stopReason: 'max_rounds',
    toolsUsed,
    links,
    messages,
    model,
    rounds: maxRounds,
    usage,
    provider,
    fallback_from: fallback,
  }
}
