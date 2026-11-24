/**
 * Phase 1 voice engine — command tools and safety rules:
 *  - the 13 named command tools exist and follow the user's role,
 *  - sensitive actions (send email, payments, deletions, purchase orders, financial records) can only exist as
 *    confirmed action tools; every confirmation carries its own id and lands in the audit trail,
 *  - spoken approval must be explicit (no hedged "yes, but…"),
 *  - the [DEMO] assistant handles the new commands in English, Kiswahili and mixed speech, without network access.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoTestDb } from '@/backend/testing'
import { AI_COLLECTIONS as C } from '@/shared/ai/contract'
import { callAi } from './api'
import { DEMO_BANNER, dashboardOf } from './demoAssistant'
import { runAssistant } from './loop'
import {
  assertToolPolicy,
  createToolEnv,
  executeTool,
  localDate,
  sensitiveCategory,
  toolDefinitions,
  ACTION_TOOL_NAMES,
  DASHBOARDS,
  LEGACY_TOOL_NAMES,
  SENSITIVE_ACTIONS,
  TOOL_NAMES,
  type ActionConfirm,
} from './tools'
import { parseYesNo } from './voice'

export const PHASE1_TOOLS = [
  'get_projects',
  'get_project_details',
  'get_project_progress',
  'get_financial_summary',
  'get_pending_approvals',
  'get_inventory',
  'get_employee_directory',
  'get_attendance_summary',
  'search_emails',
  'summarize_email',
  'draft_email',
  'open_dashboard',
  'generate_project_report',
]

let demo: Awaited<ReturnType<typeof createDemoTestDb>>
const fetchSpy = vi.fn(async () => {
  throw new Error('network access is not allowed in Demo Mode')
})

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy)
  demo = await createDemoTestDb()
  // the assistant (and its audit trail) needs ai.view: let these roles use it, so we can see what they may (not) do
  for (const key of ['site_engineer', 'project_manager']) {
    const role = demo.store.data.get('roles')!.get(key)!
    if (!(role.perms as string[]).includes('ai.view')) role.perms = [...(role.perms as string[]), 'ai.view']
  }
}, 120_000)
afterAll(() => vi.unstubAllGlobals())

const asked: ActionConfirm[] = []
async function envAs(uid: string, answer: boolean | null = null) {
  const db = demo.as(uid)
  return createToolEnv(db, { fns: db.functions, ...(answer === null ? {} : { confirm: async (req) => (asked.push(req), answer) }) })
}
const run = async (uid: string, name: string, input: unknown = {}, answer: boolean | null = null) => {
  const r = await executeTool(name, input, await envAs(uid, answer))
  return { ...r, data: JSON.parse(typeof r.content === 'string' ? r.content : (r.content[0] as { text: string }).text) }
}

describe('command tool registry', () => {
  it('has all 13 phase-1 command tools, and the managing director is offered them', async () => {
    for (const t of PHASE1_TOOLS) expect(TOOL_NAMES, t).toContain(t)
    const md = await envAs('demo-managing_director')
    expect(toolDefinitions(md.me).map((t) => t.name)).toEqual(expect.arrayContaining(PHASE1_TOOLS))
  })

  it('stays within the server limit of 64 tools per request (aiComplete / voiceSession)', () => {
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(64)
  })

  it('old tool names still run (saved conversations)', async () => {
    for (const [old, now] of Object.entries(LEGACY_TOOL_NAMES)) {
      expect(TOOL_NAMES, now).toContain(now)
      expect(TOOL_NAMES, old).not.toContain(old)
    }
    const r = await run('demo-managing_director', 'list_projects')
    expect(r.is_error).toBe(false)
    expect(r.data.projects.length).toBeGreaterThan(0)
  })

  it('rejects invalid arguments', async () => {
    const r = await run('demo-managing_director', 'open_dashboard', { dashboard: 'DROP TABLE projects' })
    expect(r.is_error).toBe(true)
    expect(r.data.error).toBe('Invalid tool input')
    const p = await run('demo-managing_director', 'get_project_progress', { limit: 1000 })
    expect(p.is_error).toBe(true)
  })
})

describe('get_project_progress', () => {
  it('reports progress, time elapsed, tasks and the latest site report', async () => {
    const r = await run('demo-managing_director', 'get_project_progress')
    expect(r.is_error).toBe(false)
    expect(r.data.projects.length).toBeGreaterThan(0)
    for (const p of r.data.projects) {
      expect(p.status).toBe('active')
      expect(typeof p.progress_pct).toBe('number')
      expect(p.link).toMatch(/^\/projects\//)
    }
    const one = await run('demo-managing_director', 'get_project_progress', { project: 'Office Block' })
    expect(one.data.projects).toHaveLength(1)
    expect(one.data.projects[0].name).toMatch(/Office Block/)
    expect(one.data.projects[0].tasks).toMatchObject({ total: expect.any(Number), done: expect.any(Number) })
  })

  it('a site engineer only sees their own projects; unknown projects return "no access"', async () => {
    const visible = (await run('demo-site_engineer', 'get_projects', { limit: 50 })).data.projects.map((p: any) => p.id)
    const mine = await run('demo-site_engineer', 'get_project_progress', { limit: 30 })
    expect(mine.data.projects.length).toBeGreaterThan(0)
    for (const p of mine.data.projects) expect(visible).toContain(p.id)
    expect(mine.data.projects.map((p: any) => p.name)).not.toContain('[DEMO] Warehouse Extension')
    const other = await run('demo-site_engineer', 'get_project_progress', { project: 'Warehouse Extension' })
    expect(other.data.note).toMatch(/no access/i)
  })
})

describe('summarize_email', () => {
  it('returns the stored analysis for people with email access, wrapped as untrusted', async () => {
    const list = await run('demo-managing_director', 'search_emails', { limit: 1 })
    const id = list.data.emails[0].id
    const r = await run('demo-managing_director', 'summarize_email', { email_id: id })
    expect(r.is_error).toBe(false)
    expect(r.data.source).toBe('email (untrusted)')
    expect(r.data.email.subject).toBeTruthy()
    expect(r.data.email.summary ?? r.data.excerpt).toBeTruthy()
  })

  it('is not available to a role without email access', async () => {
    const env = await envAs('demo-site_engineer')
    expect(toolDefinitions(env.me).map((t) => t.name)).not.toContain('summarize_email')
    const r = await executeTool('summarize_email', { email_id: 'demo-gmail__demo-client-progress' }, env)
    expect(r.is_error).toBe(true)
    expect(String(r.content)).toMatch(/no access/i)
  })
})

describe('open_dashboard', () => {
  it('checks the role against the menu before opening', async () => {
    const md = await run('demo-managing_director', 'open_dashboard', { dashboard: 'finance' })
    expect(md.data).toMatchObject({ dashboard: 'finance', path: '/finance' })
    const se = await run('demo-site_engineer', 'open_dashboard', { dashboard: 'finance' })
    expect(se.data.opened).toBe(false)
    expect(se.data.note).toMatch(/cannot open/i)
    expect(Object.values(DASHBOARDS).every((p) => p.startsWith('/'))).toBe(true)
  })
})

describe('sensitive actions', () => {
  it('classifies every sensitive kind of action', () => {
    expect(Object.keys(SENSITIVE_ACTIONS).sort()).toEqual(['approve_payment', 'delete_record', 'issue_purchase_order', 'make_payment', 'modify_financial_record', 'send_email'].sort())
    expect(sensitiveCategory('send_email')).toBe('send_email')
    expect(sensitiveCategory('approve_payment')).toBe('approve_payment')
    expect(sensitiveCategory('make_payment')).toBe('make_payment')
    expect(sensitiveCategory('delete_task')).toBe('delete_record')
    expect(sensitiveCategory('issue_purchase_order')).toBe('issue_purchase_order')
    expect(sensitiveCategory('update_invoice')).toBe('modify_financial_record')
    // today's tools: read-only or confirmed, non-sensitive actions
    for (const n of ['draft_email', 'create_task', 'update_task', 'create_purchase_request', 'search_emails', 'get_financial_summary']) expect(sensitiveCategory(n), n).toBeNull()
  })

  it('the registry refuses a sensitive tool that is not a described, confirmed action', () => {
    const def = (name: string) => ({ name, description: 'x', input_schema: { type: 'object' as const, properties: {} } })
    expect(() => assertToolPolicy([{ def: def('send_email') }])).toThrow(/must be a confirmed action tool/)
    expect(() => assertToolPolicy([{ def: def('make_payment'), action: true }])).toThrow(/must declare sensitive/)
    expect(() => assertToolPolicy([{ def: def('delete_record'), action: true, sensitive: 'delete_record' }])).toThrow(/must describe/)
    expect(() =>
      assertToolPolicy([{ def: def('approve_payment'), action: true, sensitive: 'approve_payment', describe: () => ({ title: 'Approve', title_sw: 'Idhinisha', lines: [], lines_sw: [] }) }]),
    ).not.toThrow()
    expect(() => assertToolPolicy([{ def: def('get_projects') }, { def: def('get_projects') }])).toThrow(/duplicate/)
    // the real registry has no sensitive action at all
    expect(ACTION_TOOL_NAMES.filter((n) => sensitiveCategory(n))).toEqual([])
  })

  it('every confirmation has its own id, recorded with the answer in the audit trail', async () => {
    asked.length = 0
    const input = { title: '[DEMO] Check formwork', project: 'Office Block', due_date: '2026-11-20' }
    const no = await run('demo-project_manager', 'create_task', input, false)
    const yes = await run('demo-project_manager', 'create_task', input, true)
    expect(no.data.declined).toBe(true)
    expect(yes.data.done).toBe(true)
    expect(asked).toHaveLength(2)
    const [a, b] = asked.map((x) => x.id!)
    expect(a).toMatch(/^act_/)
    expect(b).toMatch(/^act_/)
    expect(a).not.toBe(b)
    const audit = demo.raw.all(C.activity).filter((x) => x.action === 'assistant_action' && /Check formwork/.test(x.detail))
    expect(audit.map((x) => x.detail).join('\n')).toContain(`confirmation ${a}=no`)
    expect(audit.map((x) => x.detail).join('\n')).toContain(`confirmation ${b}=yes`)
  })
})

describe('explicit spoken confirmation', () => {
  it('accepts a clear yes / no in Kiswahili or English', () => {
    for (const y of ['Ndiyo', 'yes', 'Yes please.', 'sawa, endelea', 'ndio thibitisha', 'go ahead']) expect(parseYesNo(y), y).toBe(true)
    for (const n of ['Hapana', 'no', 'cancel', 'acha', 'usifanye hivyo', 'no wait']) expect(parseYesNo(n), n).toBe(false)
  })

  it('does not treat a hedged, deferred or long answer as approval', () => {
    for (const q of ['yes, but first tell me the cost', 'ndiyo lakini subiri', 'labda ndiyo', 'okay later', 'sawa kwanza niambie bei', 'yes I think we should probably do that one tomorrow morning ok']) expect(parseYesNo(q), q).toBeNull()
    expect(parseYesNo('Nifanye? Sema ndiyo au hapana.')).toBeNull()
  })
})

describe('[DEMO] assistant: new commands, three languages, no network', () => {
  async function ask(uid: string, question: string) {
    const db = demo.as(uid)
    const env = await createToolEnv(db, { fns: db.functions })
    const used: string[] = []
    const r = await runAssistant({
      fns: db.functions,
      purpose: 'chat',
      messages: [{ role: 'user', content: question }],
      tools: toolDefinitions(env.me),
      context: { today: localDate(), user_name: 'Demo', role: env.me.roleKey ?? '', locale: 'en' },
      execute: (name, input) => (used.push(name), executeTool(name, input, env)),
    })
    return { ...r, used }
  }

  it.each([
    ['English', 'How far is the Office Block project?', /Project progress|Office Block/],
    ['Kiswahili', 'Mradi wa Office Block umefika wapi?', /Maendeleo ya miradi|Office Block/],
    ['mixed', 'Nionyeshe progress ya projects zote', /Maendeleo ya miradi|Project progress/],
  ])('project progress (%s)', async (_lang, q, re) => {
    const r = await ask('demo-managing_director', q)
    expect(r.used).toContain('get_project_progress')
    expect(r.text).toContain(DEMO_BANNER)
    expect(r.text).toMatch(re)
  })

  it.each([
    ['English', 'Summarize the latest email'],
    ['Kiswahili', 'Nifupishie barua pepe ya mwisho'],
  ])('summarises one email (%s)', async (_lang, q) => {
    const r = await ask('demo-managing_director', q)
    expect(r.used).toEqual(['search_emails', 'summarize_email'])
    expect(r.text).toContain(DEMO_BANNER)
    expect(r.text).toMatch(/Email summary|Muhtasari wa barua/)
  })

  it('opens dashboards by voice words, within the role', async () => {
    expect(dashboardOf('fungua dashibodi ya fedha')).toBe('finance')
    expect(dashboardOf('open the dashboard')).toBe('main')
    expect(dashboardOf('show me the projects dashboard')).toBe('projects')
    const md = await ask('demo-managing_director', 'Fungua dashibodi ya fedha')
    expect(md.used).toEqual(['open_dashboard'])
    expect(md.text).toContain(DEMO_BANNER)
    const se = await ask('demo-site_engineer', 'Open the finance dashboard')
    expect(se.text).toMatch(/cannot open/i)
  })

  it('never stores an AI API key in Demo Mode (admin or not)', async () => {
    const before = JSON.stringify([...demo.store.data.keys()])
    const admin = demo.as('demo-super_admin')
    await expect(callAi(admin.functions, 'aiManageKeys', { action: 'set', provider: 'openai', key: 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).rejects.toThrow(/\[DEMO\] API keys are never saved/)
    const engineer = demo.as('demo-site_engineer')
    await expect(callAi(engineer.functions, 'aiManageKeys', { action: 'test', provider: 'openai' })).rejects.toThrow(/does not allow/)
    expect(JSON.stringify([...demo.store.data.keys()])).toBe(before)
    expect(demo.raw.all(C.providerKeys)).toEqual([])
  })

  it('never touched the network', () => {
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
