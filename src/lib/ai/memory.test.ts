/**
 * The assistant's memory: what the user asks it to remember (ai_memories, private to them) is sent with every
 * later question, can be corrected, searched (together with earlier conversations) and forgotten after a "yes".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoTestDb } from '@/backend/testing'
import { chatKey, resumeTurns, RESUME_WITHIN_MS, turnsToChat } from '@/components/ai/conversationMemory'
import { AI_COLLECTIONS as C, AI_MEMORY_LIMITS } from '@/shared/ai/contract'
import { ACTION_TOOL_NAMES, createToolEnv, executeTool, memoryContext, TOOL_NAMES, toolDefinitions, type ActionConfirm } from './tools'

let demo: Awaited<ReturnType<typeof createDemoTestDb>>
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no network in tests'))))
  demo = await createDemoTestDb()
}, 120_000)
afterAll(() => vi.unstubAllGlobals())

const asked: ActionConfirm[] = []
const run = async (uid: string, name: string, input: unknown, answer = true) => {
  const db = demo.as(uid)
  const env = await createToolEnv(db, { fns: db.functions, confirm: async (req) => (asked.push(req), answer) })
  const r = await executeTool(name, input, env)
  return { ...r, data: JSON.parse(typeof r.content === 'string' ? r.content : (r.content[0] as { text: string }).text) }
}
const MD = 'demo-managing_director'
const OTHER = 'demo-super_admin'

describe('memory tools', () => {
  it('remember / search are offered everywhere (no confirmation needed); forget asks first', async () => {
    expect(TOOL_NAMES).toEqual(expect.arrayContaining(['remember', 'search_my_memory', 'forget_memory']))
    expect(ACTION_TOOL_NAMES).toContain('forget_memory')
    expect(ACTION_TOOL_NAMES).not.toContain('remember')
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(64)
    const me = (await createToolEnv(demo.as(MD))).me
    const offered = toolDefinitions(me).map((t) => t.name)
    expect(offered).toEqual(expect.arrayContaining(['remember', 'search_my_memory']))
    expect(offered).not.toContain('forget_memory')
  })

  it('remembers, skips duplicates, corrects, and the memory goes with every later question', async () => {
    const a = await run(MD, 'remember', { text: 'Msimamizi wa mradi wa Office Block ni Neema.' })
    expect(a.data).toMatchObject({ done: true, remembered: 'Msimamizi wa mradi wa Office Block ni Neema.' })
    const again = await run(MD, 'remember', { text: '  msimamizi wa mradi wa office block ni Neema ' })
    expect(again.data).toMatchObject({ done: true, already: true })
    await run(MD, 'remember', { text: 'Wants the weekly report every Monday, in Kiswahili.' })
    const fixed = await run(MD, 'remember', { text: 'Msimamizi wa mradi wa Office Block sasa ni Juma.', replaces: 'msimamizi Office Block' })
    expect(fixed.data).toMatchObject({ done: true, replaced: 'Msimamizi wa mradi wa Office Block ni Neema.' })

    const ctx = await memoryContext(demo.as(MD), MD)
    expect(ctx).toHaveLength(2)
    expect(ctx.join('\n')).toContain('sasa ni Juma')
    expect(ctx.join('\n')).not.toContain('ni Neema')
    expect(ctx[0]).toMatch(/^\d{4}-\d{2}-\d{2}: /)
  })

  it('memories are private: another user neither sees nor can search them', async () => {
    expect(await memoryContext(demo.as(OTHER), OTHER)).toEqual([])
    const s = await run(OTHER, 'search_my_memory', { query: 'Office Block' })
    expect(s.data.memories).toEqual([])
    const md = demo.as(MD)
    const mine = (await md.from(C.memories).select('id').eq('user_id', MD)).data ?? []
    await demo.as(OTHER).from(C.memories).update({ text: 'changed' }).eq('id', mine[0].id)
    await demo.as(OTHER).from(C.memories).delete().eq('id', mine[0].id)
    expect((await md.from(C.memories).select('text').eq('id', mine[0].id).single()).data?.text).not.toBe('changed')
  })

  it('search_my_memory also finds what was said in earlier conversations', async () => {
    const md = demo.as(MD)
    await md.from(C.chats).insert({ title: 'Saruji', messages: [{ role: 'user', text: 'Tumeagiza mifuko 300 ya saruji kutoka Twiga, itafika Ijumaa.', at: '2026-11-10T08:00:00Z' }, { role: 'assistant', text: 'Sawa.', at: '2026-11-10T08:00:05Z' }] })
    const s = await run(MD, 'search_my_memory', { query: 'saruji Twiga' })
    expect(s.data.earlier_conversations[0]).toMatchObject({ said_by: 'user', date: '2026-11-10' })
    expect(s.data.earlier_conversations[0].text).toContain('mifuko 300')
    const all = await run(MD, 'search_my_memory', {})
    expect(all.data.memories.length).toBe(2)
  })

  it('forget asks first; "no" keeps it, "yes" removes it', async () => {
    asked.length = 0
    const no = await run(MD, 'forget_memory', { query: 'weekly report Monday' }, false)
    expect(no.data).toMatchObject({ done: false, declined: true })
    expect(asked[0]).toMatchObject({ action: 'forget_memory', title_sw: 'Nisahau kumbukumbu hii?' })
    expect(await memoryContext(demo.as(MD), MD)).toHaveLength(2)
    const yes = await run(MD, 'forget_memory', { query: 'weekly report Monday' })
    expect(yes.data).toMatchObject({ done: true, forgotten: 1 })
    expect(await memoryContext(demo.as(MD), MD)).toHaveLength(1)
    const nothing = await run(MD, 'forget_memory', { query: 'kitu kisichokuwepo kabisa' })
    expect(nothing.data.done).toBe(false)
  })

  it('a memory is one short note', async () => {
    const r = await run(MD, 'remember', { text: 'x'.repeat(AI_MEMORY_LIMITS.maxChars + 1) })
    expect(r.is_error).toBe(true)
  })
})

describe('the floating assistant keeps its conversation', () => {
  const NOW = Date.parse('2026-11-17T10:00:00Z')
  it('saves what was said (typed or spoken), titled by the first question', () => {
    const chat = turnsToChat([
      { role: 'assistant', text: 'Tahadhari: mradi umechelewa.' },
      { role: 'user', text: 'Leo   wote wapo kazini', voice: true, at: '2026-11-17T09:00:00Z' },
      { role: 'assistant', text: '', at: 'x' },
    ], '2026-11-17T09:00:01Z')
    expect(chat?.title).toBe('Leo wote wapo kazini')
    expect(chat?.messages).toEqual([
      { role: 'assistant', text: 'Tahadhari: mradi umechelewa.', at: '2026-11-17T09:00:01Z' },
      { role: 'user', text: 'Leo   wote wapo kazini', at: '2026-11-17T09:00:00Z' },
    ])
    expect(turnsToChat([{ role: 'assistant', text: 'alert only' }])).toBeNull()
    expect(chatKey(chat!.messages)).toBe(chatKey(chat!.messages.map((m) => ({ ...m, at: 'later' }))))
  })

  it('reopens the last conversation after a reload when it is recent', () => {
    const messages = [{ role: 'user' as const, text: 'Habari', at: '2026-11-17T09:00:00Z' }]
    expect(resumeTurns({ messages, updated_at: new Date(NOW - 3600_000).toISOString() }, NOW)).toEqual([{ role: 'user', text: 'Habari', at: '2026-11-17T09:00:00Z' }])
    expect(resumeTurns({ messages, updated_at: new Date(NOW - RESUME_WITHIN_MS - 1).toISOString() }, NOW)).toBeNull()
    expect(resumeTurns({ messages: [], updated_at: new Date(NOW).toISOString() }, NOW)).toBeNull()
    expect(resumeTurns(null, NOW)).toBeNull()
  })
})
