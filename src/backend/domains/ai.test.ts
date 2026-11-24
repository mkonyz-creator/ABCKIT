/**
 * AI Intelligence domain hooks on the in-memory store (security rules: tests/rules/ai.rules.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { AI_COLLECTIONS as C } from '@/shared/ai/contract'
import { createTestDb, ok } from '../testing'

function setup() {
  const t = createTestDb()
  const U = { admin: t.addUser('super_admin'), md: t.addUser('managing_director'), sys: t.addUser('administrator'), eng: t.addUser('site_engineer'), md2: t.addUser('managing_director') }
  const now = new Date().toISOString()
  t.raw.put(C.drafts, 'd1', {
    id: 'd1', email_id: 'e1', account_id: 'a1', thread_id: null, to: [{ name: 'Client', address: 'client@example.com' }], cc: [], subject: 'Re: Hello', body: 'Draft text',
    language: 'en', status: 'draft', ai_generated: true, instructions: null, created_by: 'x', created_at: now, updated_at: now, approved_by: null, approved_at: null,
    sent_at: null, provider_message_id: null, error: null, is_demo: false,
  })
  t.raw.put(C.alerts, 'al1', {
    id: 'al1', dedupe_key: 'k1', type: 'risk', priority: 'high', title: 'Risk', description: 'd', source: 'monitor', record: null, project: null, recommended_action: 'Act',
    status: 'open', first_seen_at: now, last_seen_at: now, resolved_at: null, acknowledged_by: null, acknowledged_at: null, is_demo: false,
  })
  return { t, U }
}

describe('reply drafts', () => {
  it('ai.email may edit text/recipients while draft; status changes only to discarded', async () => {
    const { t, U } = setup()
    const md = t.as(U.md)
    const r = ok(await md.from(C.drafts).update({ body: 'Edited reply', subject: 'Re: Hello (updated)', to: [{ address: 'client@example.com' }] }).eq('id', 'd1').select().single())
    expect(r).toMatchObject({ body: 'Edited reply', status: 'draft', to: [{ name: null, address: 'client@example.com' }] })
    // the app can never mark a draft approved/sent itself
    expect((await md.from(C.drafts).update({ status: 'sent' }).eq('id', 'd1')).error?.code).toBe('42501')
    expect((await md.from(C.drafts).update({ status: 'approved' }).eq('id', 'd1')).error?.code).toBe('42501')
    // non-editable fields
    expect((await md.from(C.drafts).update({ email_id: 'other' }).eq('id', 'd1')).error?.code).toBe('42501')
    expect((await md.from(C.drafts).update({ to: [{ address: 'not-an-email' }] }).eq('id', 'd1')).error?.code).toBe('23514')
    expect((await md.from(C.drafts).update({ to: [] }).eq('id', 'd1')).error?.code).toBe('23514')
    // discard cannot smuggle content changes
    expect((await md.from(C.drafts).update({ status: 'discarded', body: 'x' }).eq('id', 'd1')).error?.code).toBe('42501')
    ok(await md.from(C.drafts).update({ status: 'discarded' }).eq('id', 'd1'))
    expect(t.raw.get(C.drafts, 'd1')?.status).toBe('discarded')
    // once discarded (or sent) it is locked
    expect((await md.from(C.drafts).update({ body: 'again' }).eq('id', 'd1')).error?.code).toBe('42501')
  })

  it('roles without ai.email cannot edit; nobody can create or delete drafts from the app', async () => {
    const { t, U } = setup()
    expect((await t.as(U.eng).from(C.drafts).update({ body: 'x' }).eq('id', 'd1')).error?.code).toBe('42501')
    expect((await t.as(U.sys).from(C.drafts).update({ body: 'x' }).eq('id', 'd1')).error?.code).toBe('42501')
    expect((await t.as(U.admin).from(C.drafts).insert({ email_id: 'e1', to: [], subject: 's', body: 'b' })).error?.code).toBe('42501')
    expect((await t.as(U.admin).from(C.drafts).delete().eq('id', 'd1')).error?.code).toBe('42501')
  })
})

describe('alerts', () => {
  it('acknowledge / resolve record who and when; other fields are locked', async () => {
    const { t, U } = setup()
    const md = t.as(U.md)
    const a = ok(await md.from(C.alerts).update({ status: 'acknowledged' }).eq('id', 'al1').select().single())
    expect(a).toMatchObject({ status: 'acknowledged', acknowledged_by: U.md })
    expect(a.acknowledged_at).toBeTruthy()
    expect((await md.from(C.alerts).update({ title: 'changed' }).eq('id', 'al1')).error?.code).toBe('42501')
    const r = ok(await t.as(U.md2).from(C.alerts).update({ status: 'resolved' }).eq('id', 'al1').select().single())
    expect(r).toMatchObject({ status: 'resolved', acknowledged_by: U.md })
    expect(r.resolved_at).toBeTruthy()
    expect((await t.as(U.eng).from(C.alerts).update({ status: 'resolved' }).eq('id', 'al1')).error?.code).toBe('42501')
    expect((await md.from(C.alerts).insert({ dedupe_key: 'x', type: 'risk', title: 'fake' })).error?.code).toBe('42501')
  })
})

describe('chats, reports, activity, knowledge, settings', () => {
  it('chats are private and stamped with the owner', async () => {
    const { t, U } = setup()
    const c = ok(await t.as(U.md).from(C.chats).insert({ user_id: U.md2, title: 'Mine', messages: [{ role: 'user', text: 'Hi', at: 'now' }] }).select().single())
    expect(c.user_id).toBe(U.md)
    const other = await t.as(U.md2).from(C.chats).update({ title: 'stolen' }).eq('id', c.id)
    // md2's list scope excludes md's chat, so the update matches nothing
    expect(other.error).toBeNull()
    expect(t.raw.get(C.chats, c.id)?.title).toBe('Mine')
    expect(ok(await t.as(U.md2).from(C.chats).select('id'))).toHaveLength(0)
    expect((await t.as(U.eng).from(C.chats).insert({ title: 'x', messages: [] })).error?.code).toBe('42501')
  })

  it('memories are private, stamped with the owner and kept short', async () => {
    const { t, U } = setup()
    const m = ok(await t.as(U.md).from(C.memories).insert({ user_id: U.md2, text: '  Juma   ni msimamizi ', source: 'weird' }).select().single())
    expect(m).toMatchObject({ user_id: U.md, text: 'Juma ni msimamizi', source: 'chat' })
    await t.as(U.md2).from(C.memories).update({ text: 'stolen' }).eq('id', m.id)
    await t.as(U.md2).from(C.memories).delete().eq('id', m.id)
    expect(t.raw.get(C.memories, m.id)?.text).toBe('Juma ni msimamizi')
    expect(ok(await t.as(U.md2).from(C.memories).select('id'))).toHaveLength(0)
    expect((await t.as(U.md).from(C.memories).insert({ text: '   ' })).error?.code).toBe('23514')
    expect((await t.as(U.md).from(C.memories).insert({ text: 'x'.repeat(501) })).error?.code).toBe('23514')
    expect((await t.as(U.eng).from(C.memories).insert({ text: 'x' })).error?.code).toBe('42501')
    ok(await t.as(U.md).from(C.memories).delete().eq('id', m.id))
    expect(t.raw.get(C.memories, m.id)).toBeUndefined()
  })

  it('reports and activity are append-only and stamped with the caller', async () => {
    const { t, U } = setup()
    const md = t.as(U.md)
    const r = ok(await md.from(C.reports).insert({ title: 'Brief', kind: 'daily_brief', content_md: '# Hi', generated_by: 'someone-else', model: 'm' }).select().single())
    expect(r.generated_by).toBe(U.md)
    expect((await md.from(C.reports).update({ content_md: 'tampered' }).eq('id', r.id)).error?.code).toBe('42501')
    const a = ok(await md.from(C.activity).insert({ action: 'chat', detail: 'question', actor_id: 'spoof' }).select().single())
    expect(a.actor_id).toBe(U.md)
    expect((await md.from(C.activity).insert({ action: 'email_sent', detail: 'fake' })).error?.code).toBe('42501')
    expect((await md.from(C.activity).delete().eq('id', a.id)).error?.code).toBe('42501')
  })

  it('knowledge and settings need ai.manage', async () => {
    const { t, U } = setup()
    expect((await t.as(U.md).from(C.knowledge).insert({ title: 'Policy', kind: 'policy', body: 'x' })).error?.code).toBe('42501')
    const k = ok(await t.as(U.sys).from(C.knowledge).insert({ title: ' Policy ', kind: 'policy', body: 'x', tags: ['A', 'a', ' b '] }).select().single())
    expect(k).toMatchObject({ title: 'Policy', created_by: U.sys, tags: ['a', 'b'] })
    expect((await t.as(U.sys).from(C.knowledge).insert({ title: 'Bad', kind: 'gossip' })).error?.code).toBe('23514')
    ok(await t.as(U.sys).from(C.knowledge).update({ body: 'y' }).eq('id', k.id))
    ok(await t.as(U.sys).from(C.settings).insert({ id: 'settings', schedule_slip_threshold_pct: 15 }))
    expect((await t.as(U.md).from(C.settings).update({ schedule_slip_threshold_pct: 5 }).eq('id', 'settings')).error?.code).toBe('42501')
    expect((await t.as(U.sys).from(C.settings).update({ schedule_slip_threshold_pct: 500 }).eq('id', 'settings')).error?.code).toBe('23514')
    const s = ok(await t.as(U.sys).from(C.settings).update({ notify: { urgent_email: false } }).eq('id', 'settings').select().single())
    expect(s.notify.urgent_email).toBe(false)
    expect(s.notify.risk).toBe(true)
    expect(s.updated_by).toBe(U.sys)
  })

  it('server-written collections reject app writes', async () => {
    const { t, U } = setup()
    for (const table of [C.emails, C.usage, C.status, C.accounts, C.accountSecrets])
      expect((await t.as(U.admin).from(table).insert({ id: 'x' })).error?.code, table).toBe('42501')
  })
})
