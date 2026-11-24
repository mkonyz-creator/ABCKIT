/** The assistant tool loop against a fake aiComplete. */
import { describe, expect, it } from 'vitest'
import type { AiToolDef } from '@/shared/ai/contract'
import { runAssistant, type ApiMessage, type LoopStep } from './loop'
import type { ToolResult } from './tools'

const tools: AiToolDef[] = [
  { name: 'get_projects', description: 'x', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_alerts', description: 'x', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
]
const context = { today: '2026-11-14', user_name: 'Tester', role: 'md', locale: 'en' as const }

/** fake callable: returns the scripted responses in order and records every request */
function fake(script: Array<{ content: unknown[]; stop_reason: string | null } | { error: string }>) {
  const calls: any[] = []
  return {
    calls,
    fns: {
      async invoke(name: string, opts?: { body?: unknown }) {
        expect(name).toBe('aiComplete')
        calls.push(JSON.parse(JSON.stringify(opts?.body)))
        const next = script[calls.length - 1] ?? { content: [{ type: 'text', text: 'extra' }], stop_reason: 'end_turn' }
        if ('error' in next) return { data: null, error: { message: next.error, code: 'functions/failed-precondition' } }
        return { data: { ...next, model: 'fake-model', usage: { input_tokens: 10, output_tokens: 5 } }, error: null }
      },
    },
  }
}

const execOk = async (name: string): Promise<ToolResult> => ({ content: JSON.stringify({ source: 'ABCkit records', name, items: [{ name: 'P1', link: '/projects/p1' }] }), is_error: false, links: [{ table: 'projects', id: 'p1', label: 'P1', link: '/projects/p1' }] })
const question: ApiMessage[] = [{ role: 'user', content: 'Which projects are behind schedule?' }]

describe('runAssistant', () => {
  it('tool_use → tool results in ONE user message → end_turn', async () => {
    const f = fake([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '…', signature: 'sig' },
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 't1', name: 'get_projects', input: {} },
          { type: 'tool_use', id: 't2', name: 'list_alerts', input: {} },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '**Verified (from ABCkit records)**\n- [P1](/projects/p1) is late.' }] },
    ])
    const steps: LoopStep[] = []
    const ran: string[] = []
    const r = await runAssistant({ fns: f.fns, purpose: 'chat', messages: question, tools, context, execute: async (n) => (ran.push(n), execOk(n)), onStep: (s) => steps.push(s) })
    expect(r.text).toContain('P1')
    expect(r.stopReason).toBe('end_turn')
    expect(r.toolsUsed).toEqual(['get_projects', 'list_alerts'])
    expect(r.links[0].link).toBe('/projects/p1')
    expect(ran.sort()).toEqual(['get_projects', 'list_alerts'])
    expect(f.calls).toHaveLength(2)
    const second = f.calls[1]
    expect(second.purpose).toBe('chat')
    expect(second.tools.map((t: AiToolDef) => t.name)).toEqual(['get_projects', 'list_alerts'])
    // assistant turn echoed unchanged (incl. thinking), then exactly one user turn with both results
    expect(second.messages).toHaveLength(3)
    expect(second.messages[1].role).toBe('assistant')
    expect(second.messages[1].content.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use'])
    expect(second.messages[2].role).toBe('user')
    expect(second.messages[2].content.map((b: any) => [b.type, b.tool_use_id])).toEqual([
      ['tool_result', 't1'],
      ['tool_result', 't2'],
    ])
    expect(steps.at(-1)!.tools.every((t) => t.status === 'done')).toBe(true)
    expect(r.usage).toEqual({ input_tokens: 20, output_tokens: 10 })
  })

  it('an unknown tool gets an is_error result without running anything', async () => {
    const f = fake([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'delete_everything', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry.' }] },
    ])
    let ran = 0
    const r = await runAssistant({ fns: f.fns, purpose: 'chat', messages: question, tools, context, execute: async () => (ran++, execOk('x')) })
    expect(ran).toBe(0)
    const result = f.calls[1].messages[2].content[0]
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'x', is_error: true })
    expect(result.content).toMatch(/Unknown tool/)
    expect(r.toolsUsed).toEqual([])
  })

  it('a tool that throws becomes an is_error result and the loop continues', async () => {
    const f = fake([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'get_projects', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Could not read projects.' }] },
    ])
    const r = await runAssistant({ fns: f.fns, purpose: 'chat', messages: question, tools, context, execute: async () => { throw new Error('boom') } })
    expect(f.calls[1].messages[2].content[0]).toMatchObject({ is_error: true })
    expect(r.text).toBe('Could not read projects.')
  })

  it('stops after the maximum number of rounds', async () => {
    const loop = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'get_projects', input: {} }] }
    const f = fake(Array.from({ length: 20 }, () => loop))
    const r = await runAssistant({ fns: f.fns, purpose: 'report', messages: question, tools, context, execute: execOk, maxRounds: 3 })
    expect(f.calls).toHaveLength(3)
    expect(r.stopReason).toBe('max_rounds')
    expect(r.text).toMatch(/Stopped after 3 rounds/)
  })

  it('handles refusal, max_tokens and server errors', async () => {
    const refusal = await runAssistant({ fns: fake([{ stop_reason: 'refusal', content: [] }]).fns, purpose: 'chat', messages: question, tools, context, execute: execOk })
    expect(refusal.stopReason).toBe('refusal')
    expect(refusal.text).toMatch(/declined/)
    const served = await runAssistant({ fns: fake([{ stop_reason: 'refusal', content: [{ type: 'text', text: 'Sorry, I can’t help with that request.' }] }]).fns, purpose: 'chat', messages: question, tools, context, execute: execOk })
    expect(served.text).toBe('Sorry, I can’t help with that request.')
    const long = await runAssistant({ fns: fake([{ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Partial answer' }] }]).fns, purpose: 'chat', messages: question, tools, context, execute: execOk })
    expect(long.text).toMatch(/^Partial answer[\s\S]*cut off/)
    await expect(runAssistant({ fns: fake([{ error: 'AI is not configured on the server' }]).fns, purpose: 'chat', messages: question, tools, context, execute: execOk })).rejects.toThrow(/not configured/)
  })
})
