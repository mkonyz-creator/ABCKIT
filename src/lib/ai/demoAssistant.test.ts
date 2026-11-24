/**
 * Demo Mode: the rule-based assistant answers the sample questions from the demo data through the same
 * aiComplete → tool loop the real assistant uses; demo "send" never sends anything.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoTestDb } from '@/backend/testing'
import { DEMO_NOT_SENT } from '@/backend/demoAiFunctions'
import { AI_COLLECTIONS as C } from '@/shared/ai/contract'
import { callAi } from './api'
import { DEMO_BANNER, detectLanguage } from './demoAssistant'
import { runAssistant } from './loop'
import { createToolEnv, executeTool, localDate, toolDefinitions } from './tools'

export const SAMPLE_QUESTIONS = [
  'Niambie kila kinachoendelea kwenye kampuni leo.',
  'Which projects are behind schedule?',
  'Show me all important emails received today.',
  'Are there any urgent emails that need my attention?',
  'Which suppliers have delayed deliveries?',
  'Which projects have pending approvals?',
  'Summarize all important communications from this week.',
  'Prepare a reply to the latest client email.',
  'Give me a complete company operations report.',
  'Which issues require my attention today?',
]

let demo: Awaited<ReturnType<typeof createDemoTestDb>>
const fetchSpy = vi.fn(async () => {
  throw new Error('network access is not allowed in Demo Mode')
})

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy)
  demo = await createDemoTestDb()
}, 120_000)
afterAll(() => vi.unstubAllGlobals())

async function ask(uid: string, question: string, purpose: 'chat' | 'report' = 'chat') {
  const db = demo.as(uid)
  const env = await createToolEnv(db, { fns: db.functions })
  const tools = toolDefinitions(env.me)
  const used: string[] = []
  const r = await runAssistant({
    fns: db.functions,
    purpose,
    messages: [{ role: 'user', content: question }],
    tools,
    context: { today: localDate(), user_name: 'Demo', role: env.me.roleKey ?? '', locale: 'en' },
    execute: (name, input) => (used.push(name), executeTool(name, input, env)),
  })
  return { ...r, used }
}

describe('[DEMO] rule-based assistant', () => {
  it('answers the 10 sample questions from demo data', async () => {
    const expectations: Array<[RegExp, string[]]> = [
      [/Miradi inayoendelea|Muhtasari/, ['get_company_overview']],
      [/Health Centre Renovation[^\n]*\| active/, ['get_projects']],
      [/Complaint: dust and noise/, ['search_emails']],
      [/Delay in delivery of Y12\/Y16 bars|URGENT: updated bank details/, ['search_emails']],
      [/Sample Steel Traders/, ['list_deliveries']],
      [/Purchase order|Purchase request/, ['get_pending_approvals']],
      [/Request for progress update/, ['search_emails']],
      [/NOT been sent/, ['search_emails', 'draft_email']],
      [/Receivables outstanding[\s\S]*Supplier deliveries|Supplier deliveries[\s\S]*Receivables outstanding/, ['get_financial_summary', 'list_deliveries', 'get_workforce_summary']],
      [/Alerts|Tahadhari/, ['list_alerts', 'list_tasks']],
    ]
    const draftsBefore = demo.raw.all(C.drafts).length
    for (const [i, q] of SAMPLE_QUESTIONS.entries()) {
      const r = await ask('demo-managing_director', q)
      expect(r.stopReason, q).toBe('end_turn')
      expect(r.text, q).toContain(DEMO_BANNER)
      expect(r.text, q).toMatch(/\*\*Verified \(from ABCkit records\)\*\*/)
      expect(r.text, q).toMatch(expectations[i][0])
      for (const t of expectations[i][1]) expect(r.used, `${q} → ${t}`).toContain(t)
      expect(r.links.length, q).toBeGreaterThan(0)
    }
    // the reply question created a draft (only a draft)
    const drafts = demo.raw.all(C.drafts)
    expect(drafts.length).toBe(draftsBefore + 1)
    expect(drafts.every((d) => d.status === 'draft')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  }, 60_000)

  it('replies in Kiswahili to Kiswahili questions and flags the suspicious email', async () => {
    expect(detectLanguage(SAMPLE_QUESTIONS[0])).toBe('sw')
    expect(detectLanguage(SAMPLE_QUESTIONS[1])).toBe('en')
    const urgent = await ask('demo-managing_director', 'Are there any urgent emails that need my attention?')
    expect(urgent.text).toMatch(/suspicious instructions/)
    expect(urgent.text).toMatch(/email \(untrusted\)/)
  })

  it('respects the asking user’s permissions (accountant sees no emails)', async () => {
    const role = demo.store.data.get('roles')!.get('accountant')!
    role.perms = [...role.perms, 'ai.view']
    const r = await ask('demo-accountant', 'Show me all important emails received today.')
    expect(r.used).not.toContain('search_emails')
    expect(r.text).toMatch(/Missing \/ not available[\s\S]*not available to your role/)
    const fin = await ask('demo-accountant', 'Give me a complete company operations report.', 'report')
    expect(fin.text).toMatch(/^# \[DEMO\] Company operations report/)
    expect(fin.used).toContain('get_financial_summary')
  })

  it('demo send never really sends: the draft is only marked sent with a note', async () => {
    const md = demo.as('demo-managing_director')
    const { draft_id } = await callAi(md.functions, 'emailGenerateReply', { email_id: 'demo-gmail__demo-dust-complaint', language: 'en' })
    const d = demo.raw.get(C.drafts, draft_id)!
    expect(d.body).toMatch(/\[DEMO\]/)
    // a role without ai.email_send cannot send
    const role = demo.store.data.get('roles')!.get('administrator')!
    expect(role.perms).not.toContain('ai.email_send')
    const sys = demo.as('demo-administrator')
    await expect(callAi(sys.functions, 'emailSendDraft', { draft_id })).rejects.toThrow(/does not allow/)
    const res = await callAi(demo.as('demo-managing_director').functions, 'emailSendDraft', { draft_id })
    expect(res.ok).toBe(true)
    expect(demo.raw.get(C.drafts, draft_id)).toMatchObject({ status: 'sent', demo_note: DEMO_NOT_SENT })
    const sent = demo.raw.all(C.emails).find((e) => e.folder === 'sent' && e.provider_message_id === `demo-sent-${draft_id}`)!
    expect(sent.body_text).toContain(DEMO_NOT_SENT)
    expect(demo.raw.all(C.activity).some((a) => a.action === 'email_sent' && a.detail.includes(DEMO_NOT_SENT))).toBe(true)
    await expect(callAi(demo.as('demo-managing_director').functions, 'emailSendDraft', { draft_id })).rejects.toThrow(/sent and cannot be sent/)
    // connecting real mailboxes is refused in Demo Mode
    await expect(callAi(demo.as('demo-super_admin').functions, 'emailConnectStart', { provider: 'gmail', return_url: 'x' })).rejects.toThrow(/Not available in Demo Mode/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the demo monitor runs on demo data without dropping seeded alerts', async () => {
    const before = demo.raw.all(C.alerts).filter((a) => a.status !== 'resolved').length
    const r = await callAi(demo.as('demo-managing_director').functions, 'aiRunMonitor', {})
    expect(r.alerts_open).toBeGreaterThanOrEqual(before > 0 ? 1 : 0)
    expect(demo.raw.get(C.status, 'status')?.last_monitor_ok).toBe(true)
    // one alert per condition: a second run creates nothing new and seeded alerts are updated in place
    const again = await callAi(demo.as('demo-managing_director').functions, 'aiRunMonitor', {})
    expect(again.created).toBe(0)
    const keys = demo.raw.all(C.alerts).filter((a) => a.status !== 'resolved').map((a) => a.dedupe_key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter((k) => k.startsWith('po_delivery_overdue:'))).toHaveLength(1)
  })
})
