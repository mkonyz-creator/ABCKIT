/**
 * Anthropic Claude adapter (the original ABCkit AI provider). Optional for chat; used for reports in phase 1.
 */
import { echoSafeContent, FALLBACK_PARAMS, MODEL, type AnthropicLike } from '../claude.js'
import type { Block, CanonMessage, ChatProvider, TurnRequest } from './types.js'

/** tool_use blocks from other providers may carry fields Claude does not accept */
export function forClaude(messages: CanonMessage[]): CanonMessage[] {
  return messages.map((m) =>
    typeof m.content === 'string'
      ? m
      : { ...m, content: m.content.map((b: Block) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} } : b)) },
  )
}

export function claudeProvider(client: AnthropicLike): ChatProvider {
  return {
    id: 'claude',
    async turn(req: TurnRequest) {
      const [main, ...rest] = req.system
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: req.maxTokens,
        thinking: { type: 'adaptive' },
        // spoken answers should come back quickly
        output_config: { effort: req.voice ? 'low' : 'medium' },
        // second breakpoint: the end of the conversation, so the next turn reuses this prefix
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text' as const, text: main, cache_control: { type: 'ephemeral' as const } }, ...rest.map((text) => ({ type: 'text' as const, text }))],
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as { type: 'object' } })),
        messages: forClaude(req.messages) as any,
        ...FALLBACK_PARAMS,
      })
      const msg = await stream.finalMessage()
      return { content: echoSafeContent(msg.content) as Block[], stop_reason: msg.stop_reason ?? null, model: msg.model ?? MODEL, usage: msg.usage }
    },
  }
}
