/** Fake Anthropic client: records requests, returns canned messages. Never touches the network. */
import type { AnthropicLike } from '../ai/claude.js'

export interface FakeReply {
  content?: any[]
  stop_reason?: string
  model?: string
  usage?: Record<string, number>
  parsed_output?: unknown
  error?: Error
}

export function fakeClaude(replies: FakeReply[] | ((params: any) => FakeReply)) {
  const calls: any[] = []
  const next = (params: any): any => {
    calls.push(params)
    const r = typeof replies === 'function' ? replies(params) : (replies.shift() ?? { content: [{ type: 'text', text: 'ok' }] })
    if (r.error) throw r.error
    return {
      id: `msg_${calls.length}`,
      type: 'message',
      role: 'assistant',
      model: r.model ?? 'claude-opus-5-5',
      content: r.content ?? [{ type: 'text', text: 'ok', citations: null }],
      stop_reason: r.stop_reason ?? 'end_turn',
      stop_details: null,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, ...(r.usage ?? {}) },
      parsed_output: r.parsed_output ?? null,
    }
  }
  const client = {
    beta: {
      messages: {
        stream: (params: any) => {
          let msg: any
          let err: unknown
          try {
            msg = next(params)
          } catch (e) {
            err = e
          }
          return { finalMessage: async () => (err ? Promise.reject(err) : msg) }
        },
        parse: async (params: any) => next(params),
        create: async (params: any) => next(params),
      },
    },
  }
  return { client: client as unknown as AnthropicLike, calls }
}
