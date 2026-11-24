import { describe, expect, it } from 'vitest'
import { requireCaller } from '../lib/auth.js'
import { FakeDb, seedUser } from '../test/fakeFirestore.js'
import { fakeClaude } from '../test/fakeClaude.js'
import { fakeGemini, fakeOpenAI, httpError } from '../test/fakeProviders.js'
import { runComplete } from './complete.js'
import { CHAT_SYSTEM_PROMPT, REPORT_SYSTEM_PROMPT } from './prompts.js'
import { providerOrder, runChain } from './providers/chain.js'
import { forClaude } from './providers/claude.js'
import { fromGeminiResponse, geminiProvider, geminiStatus, resetGeminiCooldown, SKIP_SIGNATURE, toGeminiContents } from './providers/gemini.js'
import { providerHttpsError } from './claude.js'
import { fromOpenAIResponse, toOpenAIInput } from './providers/openai.js'
import type { CanonMessage, ChatProvider, TurnRequest } from './providers/types.js'

const TODAY = '2026-11-14'
const NOW = new Date('2026-11-14T09:00:00Z')
const tool = { name: 'list_projects', description: 'List projects', input_schema: { type: 'object', properties: {} } }
const B64 = 'QUJD'.repeat(10)

/** a conversation with a tool round that read a picture and a PDF */
const convo: CanonMessage[] = [
  { role: 'user', content: 'Show me the site photo and the contract' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look.' },
      { type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
      { type: 'tool_use', id: 'call_1', name: 'read_document', input: { document_id: 'd1' }, signature: 'gem-sig-1' },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'text', text: '{"title":"Contract"}' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: B64 } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: B64 }, title: 'Main contract' },
        ],
      },
    ],
  },
]

describe('OpenAI adapter (Responses API)', () => {
  it('translates the conversation: messages, function calls, outputs with image + PDF; drops thinking', () => {
    const input = toOpenAIInput(convo)
    expect(input[0]).toEqual({ role: 'user', content: 'Show me the site photo and the contract' })
    expect(input[1]).toEqual({ role: 'assistant', content: 'Let me look.' })
    expect(input[2]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'read_document', arguments: '{"document_id":"d1"}' })
    const out = input[3] as any
    expect(out.type).toBe('function_call_output')
    expect(out.call_id).toBe('call_1')
    expect(out.output[0]).toEqual({ type: 'input_text', text: '{"title":"Contract"}' })
    expect(out.output[1]).toMatchObject({ type: 'input_image', image_url: `data:image/jpeg;base64,${B64}` })
    expect(out.output[2]).toMatchObject({ type: 'input_file', filename: 'Main_contract.pdf', file_data: `data:application/pdf;base64,${B64}` })
    expect(JSON.stringify(input)).not.toContain('secret reasoning')
  })

  it('reads text, function calls, length cut-offs and refusals back', () => {
    const r = fromOpenAIResponse(
      {
        model: 'gpt-5.5',
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: 'Checking…' }] },
          { type: 'function_call', call_id: 'call_9', name: 'list_projects', arguments: '{"status":"active"}' },
        ],
        usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100 } },
      },
      'gpt-5.5',
    )
    expect(r.stop_reason).toBe('tool_use')
    expect(r.content).toEqual([
      { type: 'text', text: 'Checking…' },
      { type: 'tool_use', id: 'call_9', name: 'list_projects', input: { status: 'active' } },
    ])
    expect(r.usage).toEqual({ input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 100 })
    expect(fromOpenAIResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'm').stop_reason).toBe('max_tokens')
    expect(fromOpenAIResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }, 'm').stop_reason).toBe('refusal')
  })
})

describe('Gemini adapter', () => {
  it('translates calls (echoing thought signatures), responses by name, and attachments as inline data', () => {
    const contents = toGeminiContents(convo)
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(contents[1].parts).toEqual([
      { text: 'Let me look.' },
      { functionCall: { id: 'call_1', name: 'read_document', args: { document_id: 'd1' } }, thoughtSignature: 'gem-sig-1' },
    ])
    expect(contents[2].parts[0]).toEqual({ functionResponse: { id: 'call_1', name: 'read_document', response: { output: '{"title":"Contract"}' } } })
    expect(contents[2].parts.slice(1)).toEqual([{ inlineData: { mimeType: 'image/jpeg', data: B64 } }, { inlineData: { mimeType: 'application/pdf', data: B64 } }])
    // calls that came from another provider carry the documented placeholder signature
    const other = toGeminiContents([{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_projects', input: {} }] }])
    expect(other[1].parts[0].thoughtSignature).toBe(SKIP_SIGNATURE)
  })

  it('reads function calls with signatures, generates missing ids, and maps finish reasons', () => {
    const r = fromGeminiResponse(
      {
        candidates: [
          {
            content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Sawa.' }, { functionCall: { name: 'list_projects', args: { status: 'active' } }, thoughtSignature: 'S1' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8, thoughtsTokenCount: 4 },
      },
      'gemini-x',
    )
    expect(r.stop_reason).toBe('tool_use')
    expect(r.content[0]).toEqual({ type: 'text', text: 'Sawa.' })
    expect(r.content[1]).toMatchObject({ type: 'tool_use', name: 'list_projects', input: { status: 'active' }, signature: 'S1' })
    expect(String(r.content[1].id)).toMatch(/^gm_/)
    expect(r.usage.output_tokens).toBe(12)
    // generated ids are not sent back to Gemini
    expect(toGeminiContents([{ role: 'user', content: 'q' }, { role: 'assistant', content: [r.content[1]] }])[1].parts[0]).toEqual({ functionCall: { name: 'list_projects', args: { status: 'active' } }, thoughtSignature: 'S1' })
    expect(fromGeminiResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }, 'm').stop_reason).toBe('max_tokens')
    expect(fromGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }, 'm').stop_reason).toBe('refusal')
    expect(fromGeminiResponse({ promptFeedback: { blockReason: 'OTHER' }, candidates: [] }, 'm').stop_reason).toBe('refusal')
  })

  const gReq: TurnRequest = { purpose: 'chat', system: ['s'], messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 100, voice: false }
  const overloaded = () => httpError(503, '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}')

  it('moves to a lighter Gemini model when the configured one is overloaded, out of quota, missing or too slow', async () => {
    resetGeminiCooldown()
    // what AbortSignal.timeout really throws: a DOMException named TimeoutError with code 23 (not an HTTP status)
    const abort = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(abort.code).toBe(23)
    const gm = fakeGemini([overloaded(), httpError(429), abort])
    const r = await geminiProvider(gm.client, 'gemini-main', ['lite-a', 'lite-b', 'lite-c']).turn(gReq)
    expect(gm.calls.map((c) => c.model)).toEqual(['gemini-main', 'lite-a', 'lite-b', 'lite-c'])
    expect(r.model).toBe('lite-c')
    expect(gm.calls[0].config.abortSignal).toBeInstanceOf(AbortSignal)
    // the models that just failed are tried last on the next turn (no 35 s wait on a dead model)
    const again = fakeGemini()
    await geminiProvider(again.client, 'gemini-main', ['lite-a', 'lite-b', 'lite-c']).turn(gReq)
    expect(again.calls.map((c) => c.model)).toEqual(['lite-c'])
    resetGeminiCooldown()
  })

  it('does not try other models for a request error; resends with placeholder signatures if one is rejected', async () => {
    resetGeminiCooldown()
    const bad = fakeGemini([httpError(400, 'Invalid JSON payload')])
    await expect(geminiProvider(bad.client, 'gemini-main', ['lite-a']).turn(gReq)).rejects.toThrow(/Invalid JSON/)
    expect(bad.calls).toHaveLength(1)
    const sig = fakeGemini([httpError(400, 'Function call is missing a thought_signature in functionCall parts')])
    const convoReq = { ...gReq, messages: convo }
    await geminiProvider(sig.client, 'gemini-main', ['lite-a']).turn(convoReq)
    expect(sig.calls).toHaveLength(2)
    expect(sig.calls[1].model).toBe('gemini-main')
    expect(sig.calls[1].contents[1].parts[1].thoughtSignature).toBe(SKIP_SIGNATURE)
    // every model overloaded → the last error, shown to the user as a clear "busy" message
    const down = fakeGemini([overloaded(), overloaded()])
    const err = await geminiProvider(down.client, 'gemini-main', ['lite-a']).turn(gReq).catch((e) => e)
    expect(geminiStatus(err)).toBe(503)
    expect(providerHttpsError(err)).toMatchObject({ code: 'unavailable', message: expect.stringContaining('Huduma ya AI imezidiwa') })
    expect(providerHttpsError(httpError(429)).code).toBe('resource-exhausted')
    expect(providerHttpsError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).code).toBe('deadline-exceeded')
    resetGeminiCooldown()
  })
})

describe('Claude adapter', () => {
  it('removes provider fields from tool_use blocks but keeps Claude thinking blocks', () => {
    const m = forClaude(convo)[1].content as any[]
    expect(m[2]).toEqual({ type: 'tool_use', id: 'call_1', name: 'read_document', input: { document_id: 'd1' } })
    expect(m[1]).toEqual({ type: 'thinking', thinking: 'secret reasoning', signature: 'sig' })
  })
})

describe('provider chain', () => {
  const req: TurnRequest = { purpose: 'chat', system: ['s'], messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 100, voice: false }
  const ok = (id: 'openai' | 'gemini' | 'claude', calls: string[]): ChatProvider => ({
    id,
    turn: async () => (calls.push(id), { content: [{ type: 'text', text: id }], stop_reason: 'end_turn', model: id, usage: { input_tokens: 1, output_tokens: 1 } }),
  })
  const failing = (id: 'openai' | 'gemini' | 'claude', calls: string[], status = 503): ChatProvider => ({
    id,
    turn: async () => {
      calls.push(id)
      throw httpError(status)
    },
  })

  it('orders by settings with the previous turn’s provider first', () => {
    expect(providerOrder(['openai', 'gemini', 'claude'], undefined)).toEqual(['openai', 'gemini', 'claude'])
    expect(providerOrder(['openai', 'gemini', 'claude'], 'gemini')).toEqual(['gemini', 'openai', 'claude'])
    expect(providerOrder(['openai', 'gemini'], 'claude')).toEqual(['openai', 'gemini'])
  })

  it('asks only the first provider when it answers (no data to a second provider)', async () => {
    const calls: string[] = []
    const r = await runChain(['openai', 'gemini'], { openai: ok('openai', calls), gemini: ok('gemini', calls) }, req)
    expect(r).toMatchObject({ provider: 'openai', fallback_from: [] })
    expect(calls).toEqual(['openai'])
  })

  it('falls back to Gemini when OpenAI fails, skipping unconfigured providers', async () => {
    const calls: string[] = []
    const r = await runChain(['openai', 'claude', 'gemini'], { openai: failing('openai', calls, 429), claude: null, gemini: ok('gemini', calls) }, req)
    expect(r).toMatchObject({ provider: 'gemini', fallback_from: ['openai'] })
    expect(calls).toEqual(['openai', 'gemini'])
  })

  it('explains when nothing is configured or everything failed', async () => {
    await expect(runChain(['openai', 'gemini'], {}, req)).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringMatching(/OPENAI_API_KEY/) })
    const calls: string[] = []
    await expect(runChain(['openai', 'gemini'], { openai: failing('openai', calls), gemini: failing('gemini', calls, 500) }, req)).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/OpenAI: 503.*Google Gemini: 500/),
    })
  })
})

describe('aiComplete with OpenAI → Gemini → Claude', () => {
  const valid = (over: Record<string, unknown> = {}) => ({
    purpose: 'chat',
    messages: [{ role: 'user', content: 'Ni miradi gani iko nyuma?' }],
    tools: [tool],
    context: { today: TODAY, user_name: 'x', role: 'x', locale: 'sw' },
    ...over,
  })
  async function setup() {
    const db = new FakeDb()
    seedUser(db, 'u1', ['ai.view'], { name: 'Asha Director' })
    return { db, caller: await requireCaller(db.asDb(), 'u1', ['ai.view']) }
  }

  it('OpenAI answers chat by default with the ABCkit prompt and the tools; usage and activity name the provider', async () => {
    const { db, caller } = await setup()
    const oa = fakeOpenAI()
    const gm = fakeGemini()
    const cl = fakeClaude([])
    const r = await runComplete({ db: db.asDb(), client: cl.client, openai: oa.client, gemini: gm.client, models: { openaiChat: 'gpt-5.5', gemini: 'gemini-flash-latest' }, now: NOW }, caller, valid())
    expect(r).toMatchObject({ provider: 'openai', fallback_from: [], stop_reason: 'end_turn' })
    expect(oa.calls[0].instructions.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true)
    expect(oa.calls[0].instructions).toContain('Asha Director')
    expect(oa.calls[0].tools[0]).toMatchObject({ type: 'function', name: 'list_projects', strict: false })
    expect(oa.calls[0].store).toBe(false)
    expect(gm.calls).toHaveLength(0)
    expect(cl.calls).toHaveLength(0)
    expect(db.all('ai_usage')[0]).toMatchObject({ purpose: 'chat', model: 'openai:gpt-5.5', cost_usd: 0 })
    expect(db.all('ai_activity')[0].detail).toMatch(/Chat turn by OpenAI/)
  })

  it('falls back to Gemini, and keeps the conversation there on the next turn', async () => {
    const { db, caller } = await setup()
    const oa = fakeOpenAI([httpError(500, 'server error')])
    const gm = fakeGemini()
    const deps = { db: db.asDb(), client: null, openai: oa.client, gemini: gm.client, now: NOW }
    const r = await runComplete(deps, caller, valid())
    expect(r).toMatchObject({ provider: 'gemini', fallback_from: ['openai'] })
    expect(gm.calls[0].config.systemInstruction.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true)
    expect(gm.calls[0].config.tools[0].functionDeclarations[0]).toMatchObject({ name: 'list_projects', parametersJsonSchema: tool.input_schema })
    expect(db.all('ai_activity').at(-1)!.detail).toMatch(/fallback after OpenAI failed/)
    const r2 = await runComplete(deps, caller, valid({ context: { today: TODAY, locale: 'sw', provider_hint: 'gemini' } }))
    expect(r2.provider).toBe('gemini')
    expect(oa.calls).toHaveLength(1)
  })

  it('respects the admin’s provider list, and reports still use Claude', async () => {
    const { db, caller } = await setup()
    db.seed('ai_settings', [{ id: 'settings', enabled: true, chat_providers: ['gemini'] }])
    const oa = fakeOpenAI()
    const gm = fakeGemini()
    const cl = fakeClaude([])
    const deps = { db: db.asDb(), client: cl.client, openai: oa.client, gemini: gm.client, now: NOW }
    expect((await runComplete(deps, caller, valid())).provider).toBe('gemini')
    const rep = await runComplete(deps, caller, valid({ purpose: 'report' }))
    expect(rep.provider).toBe('claude')
    expect(cl.calls[0].system[0].text).toBe(REPORT_SYSTEM_PROMPT)
    expect(oa.calls).toHaveLength(0)
    // a report without Claude configured
    await expect(runComplete({ ...deps, client: null }, caller, valid({ purpose: 'report' }))).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })
})
