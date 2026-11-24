/**
 * OpenAI adapter (Responses API, stateless: store = false). Primary provider of the chat assistant.
 */
import OpenAI from 'openai'
import { safeJson, toolResultAttachments, toolResultText, type Block, type CanonMessage, type ChatProvider, type TurnRequest, type TurnResult } from './types.js'

/** the part of the SDK we use (tests pass a fake) */
export interface OpenAILike {
  responses: { create(body: any, opts?: any): Promise<any> }
  realtime: { clientSecrets: { create(body: any, opts?: any): Promise<any> } }
}

export function makeOpenAI(apiKey: string): OpenAILike {
  return new OpenAI({ apiKey, timeout: 120_000, maxRetries: 1 }) as unknown as OpenAILike
}

function toolOutput(b: Block): string | Array<Record<string, unknown>> {
  const text = toolResultText(b)
  const files = toolResultAttachments(b)
  if (!files.length) return text
  return [
    { type: 'input_text', text },
    ...files.map((f) =>
      f.type === 'image'
        ? { type: 'input_image', image_url: `data:${f.source.media_type};base64,${f.source.data}`, detail: 'auto' }
        : { type: 'input_file', filename: `${String(f.title ?? 'document').replace(/[^\w.-]+/g, '_').slice(0, 80)}.pdf`, file_data: `data:application/pdf;base64,${f.source.data}` },
    ),
  ]
}

/** canonical conversation → Responses API input items */
export function toOpenAIInput(messages: CanonMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const texts: string[] = []
    const flush = () => {
      if (texts.length) out.push({ role: m.role, content: texts.join('\n\n') })
      texts.length = 0
    }
    for (const b of m.content) {
      if (b.type === 'text' && b.text) texts.push(String(b.text))
      else if (b.type === 'tool_use') {
        flush()
        out.push({ type: 'function_call', call_id: String(b.id), name: String(b.name), arguments: JSON.stringify(b.input ?? {}) })
      } else if (b.type === 'tool_result') {
        flush()
        out.push({ type: 'function_call_output', call_id: String(b.tool_use_id), output: toolOutput(b) })
      }
      // thinking / redacted_thinking / fallback blocks belong to other providers and are dropped
    }
    flush()
  }
  return out
}

/** Responses API result → canonical turn */
export function fromOpenAIResponse(res: any, model: string): TurnResult {
  const content: Block[] = []
  let refusal = false
  for (const item of res?.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) content.push({ type: 'text', text: part.text })
        if (part.type === 'refusal') {
          refusal = true
          content.push({ type: 'text', text: String(part.refusal ?? '') })
        }
      }
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: String(item.call_id), name: String(item.name), input: safeJson(item.arguments) })
    }
  }
  const calls = content.some((b) => b.type === 'tool_use')
  const stop = calls ? 'tool_use' : res?.status === 'incomplete' && res?.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : refusal ? 'refusal' : 'end_turn'
  const u = res?.usage ?? {}
  const cached = u.input_tokens_details?.cached_tokens ?? 0
  return {
    content,
    stop_reason: stop,
    model: String(res?.model ?? model),
    usage: { input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached), output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: cached },
  }
}

export function openaiProvider(client: OpenAILike, model: string): ChatProvider {
  return {
    id: 'openai',
    async turn(req: TurnRequest) {
      const reasoning = /^(gpt-5|o\d)/.test(model) ? { reasoning: { effort: req.voice ? 'low' : 'medium' } } : {}
      const res = await client.responses.create({
        model,
        instructions: req.system.join('\n\n'),
        input: toOpenAIInput(req.messages),
        tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
        store: false,
        max_output_tokens: req.maxTokens,
        ...reasoning,
      })
      return fromOpenAIResponse(res, model)
    },
  }
}
