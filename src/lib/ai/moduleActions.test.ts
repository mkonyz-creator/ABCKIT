/**
 * The module commands of the assistant (voice or chat): stock, attendance, employees, projects, clients, site
 * issues, approvals, expenses and the document upload form. Each one asks first, writes exactly what the
 * module's screen writes (the backend hooks keep stock balances, numbers and approver stamps) and is audited.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoTestDb } from '@/backend/testing'
import { AI_COLLECTIONS as C } from '@/shared/ai/contract'
import { ACTION_TOOL_NAMES, assertToolPolicy, createToolEnv, executeTool, localDate, sensitiveCategory, TOOL_NAMES, toolDefinitions, type ActionConfirm } from './tools'
import { NAVIGATE_EVENT } from './uiActions'

let demo: Awaited<ReturnType<typeof createDemoTestDb>>
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no network in tests'))))
  demo = await createDemoTestDb()
}, 120_000)
afterAll(() => vi.unstubAllGlobals())

const TODAY = localDate()
const asked: ActionConfirm[] = []
const run = async (uid: string, name: string, input: unknown, answer = true) => {
  const db = demo.as(uid)
  const env = await createToolEnv(db, { fns: db.functions, confirm: async (req) => (asked.push(req), answer) })
  const r = await executeTool(name, input, env)
  return { ...r, data: JSON.parse(typeof r.content === 'string' ? r.content : (r.content[0] as { text: string }).text) }
}
const MD = 'demo-managing_director'
const ADMIN = 'demo-super_admin'
const NEW = ['add_stock_item', 'record_stock_movement', 'record_attendance', 'add_employee', 'create_project', 'create_client', 'report_site_issue', 'decide_approval', 'record_expense']

describe('module commands: registry', () => {
  it('all new commands are confirmed action tools, the registry stays valid and within the 64-tool server limit', async () => {
    for (const n of NEW) expect(ACTION_TOOL_NAMES, n).toContain(n)
    expect(TOOL_NAMES).toContain('start_document_upload')
    expect(ACTION_TOOL_NAMES).not.toContain('start_document_upload')
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(64)
    for (const n of NEW) expect(sensitiveCategory(n), n).toBeNull()
    const db = demo.as(MD)
    const me = (await createToolEnv(db)).me
    // without a confirmation channel none of them is offered
    expect(toolDefinitions(me).map((t) => t.name).filter((n) => NEW.includes(n))).toEqual([])
    expect(() => assertToolPolicy([])).not.toThrow()
  })

  it('an employee account gets none of them', async () => {
    const db = demo.as('demo-employee')
    const me = (await createToolEnv(db)).me
    const names = toolDefinitions(me, { actions: true }).map((t) => t.name)
    for (const n of ['add_stock_item', 'record_stock_movement', 'add_employee', 'create_project', 'decide_approval', 'record_expense']) expect(names, n).not.toContain(n)
    const r = await run('demo-employee', 'record_expense', { amount: 1000, category: 'fuel', description: 'sneaky' })
    expect(r.is_error).toBe(true)
  })
})

describe('inventory', () => {
  it('adds a new stock item with opening stock; a "no" or a duplicate changes nothing', async () => {
    const before = demo.raw.all('materials').length
    const no = await run(ADMIN, 'add_stock_item', { name: '[DEMO] Roofing nails', unit: 'kg', unit_price: 4500, min_stock: 20, opening_stock: 50 }, false)
    expect(no.data).toMatchObject({ declined: true })
    expect(demo.raw.all('materials').length).toBe(before)
    asked.length = 0
    const yes = await run(ADMIN, 'add_stock_item', { name: '[DEMO] Roofing nails', unit: 'kg', unit_price: 4500, min_stock: 20, opening_stock: 50 })
    expect(yes.data).toMatchObject({ done: true, item: { name: '[DEMO] Roofing nails', in_stock: 50 } })
    expect(asked[0].title_sw).toBe('Ongeza kifaa stoo: “[DEMO] Roofing nails”')
    const m = demo.raw.all('materials').find((x) => x.name === '[DEMO] Roofing nails')!
    expect(m.code).toMatch(/^MAT-/)
    expect(m.current_stock).toBe(50)
    const dup = await run(ADMIN, 'add_stock_item', { name: '[demo] roofing NAILS' })
    expect(dup.data.done).toBe(false)
    expect(dup.data.note).toMatch(/already in the register/)
  })

  it('receives and issues stock through the ledger; never below zero', async () => {
    const cement = () => demo.raw.all('materials').find((x) => /Portland cement/.test(x.name))!
    const start = Number(cement().current_stock)
    const rec = await run(ADMIN, 'record_stock_movement', { material: 'cement', movement: 'receive', quantity: 100, reference: 'DN-77' })
    expect(rec.data).toMatchObject({ done: true, item: { stock_before: start, stock_after: start + 100 } })
    expect(Number(cement().current_stock)).toBe(start + 100)
    const noSite = await run(ADMIN, 'record_stock_movement', { material: 'cement', movement: 'issue', quantity: 10 })
    expect(noSite.data.note).toMatch(/need a project/)
    asked.length = 0
    const iss = await run(ADMIN, 'record_stock_movement', { material: 'cement', movement: 'issue', quantity: 30, project: 'Office Block' })
    expect(iss.data.done).toBe(true)
    expect(asked[0].lines_sw[0]).toBe(`Stoo: ${start + 100} → ${start + 70} bag`)
    expect(Number(cement().current_stock)).toBe(start + 70)
    const tooMuch = await run(ADMIN, 'record_stock_movement', { material: 'cement', movement: 'issue', quantity: 1_000_000, project: 'Office Block' })
    expect(tooMuch.data.done).toBe(false)
    expect(Number(cement().current_stock)).toBe(start + 70)
  })
})

describe('workforce', () => {
  it('registers an employee by voice with an automatic number and daily rate', async () => {
    asked.length = 0
    const r = await run(ADMIN, 'add_employee', { full_name: '[DEMO] Hamisi Mrisho', position: 'Mason', trade: 'Masonry', phone: '+255 700 000 555', daily_rate: 25000 })
    expect(r.data).toMatchObject({ done: true, employee: { name: '[DEMO] Hamisi Mrisho', position: 'Mason', department: 'Site Operations' } })
    expect(r.data.employee.number).toMatch(/^EMP-/)
    expect(asked[0].title_sw).toBe('Andikisha mfanyakazi: [DEMO] Hamisi Mrisho')
    const e = demo.raw.all('employees').find((x) => x.full_name === '[DEMO] Hamisi Mrisho')!
    expect(e).toMatchObject({ employment_type: 'casual', status: 'active', hire_date: TODAY })
    const pay = demo.raw.all('employee_compensation').find((x) => x.employee_id === e.id)
    if (pay) expect(pay).toMatchObject({ pay_basis: 'daily', daily_rate: 25000 })
    else expect(r.data.note).toMatch(/daily rate/)
    const again = await run(ADMIN, 'add_employee', { full_name: '[DEMO] Hamisi Mrisho' })
    expect(again.data.note).toMatch(/already registered/)
  })

  it('records attendance: named people plus "everyone else present", replacing that day', async () => {
    asked.length = 0
    const r = await run(ADMIN, 'record_attendance', { project: 'Office Block', entries: [{ employee: 'Baraka', status: 'sick' }], others_status: 'present' })
    expect(r.data.done).toBe(true)
    expect(r.data.sick).toBe(1)
    expect(r.data.present).toBeGreaterThanOrEqual(2)
    expect(asked[0].lines_sw.join(' ')).toMatch(/Baraka Said: mgonjwa/)
    const today = demo.raw.all('attendance').filter((a) => a.work_date === TODAY)
    const baraka = demo.raw.all('employees').find((x) => /Baraka/.test(x.full_name))!
    expect(today.find((a) => a.employee_id === baraka.id)).toMatchObject({ status: 'sick', hours_worked: 0 })
    expect(today.filter((a) => a.status === 'present').every((a) => a.hours_worked === 8)).toBe(true)
    // the same day again replaces, it does not duplicate
    await run(ADMIN, 'record_attendance', { entries: [{ employee: 'Baraka', status: 'present' }] })
    expect(demo.raw.all('attendance').filter((a) => a.work_date === TODAY && a.employee_id === baraka.id)).toHaveLength(1)
    const future = await run(ADMIN, 'record_attendance', { date: '2999-01-01', others_status: 'present' })
    expect(future.data.done).toBe(false)
  })
})

describe('projects, clients and site', () => {
  it('creates a client, then a project for that client with an automatic code', async () => {
    const c = await run(ADMIN, 'create_client', { name: '[DEMO] Mbeya Water Board', client_type: 'government', phone: '+255 700 000 777' })
    expect(c.data).toMatchObject({ done: true, client: { name: '[DEMO] Mbeya Water Board' } })
    expect((await run(ADMIN, 'create_client', { name: '[DEMO] Mbeya Water Board' })).data.note).toMatch(/already exists/)
    asked.length = 0
    const p = await run(ADMIN, 'create_project', { name: '[DEMO] Mbeya Water Tank', client: 'Mbeya Water', region: 'Mbeya', start_date: '2026-12-01', end_date: '2027-06-30', budget: 850000000 })
    expect(p.data).toMatchObject({ done: true, project: { name: '[DEMO] Mbeya Water Tank', status: 'planning' } })
    expect(p.data.project.code).toMatch(/^PRJ-/)
    expect(asked[0].lines_sw[0]).toBe('Mteja: [DEMO] Mbeya Water Board · Hali: planning')
    const bad = await run(ADMIN, 'create_project', { name: 'X project', start_date: '2027-01-01', end_date: '2026-01-01' })
    expect(bad.data.note).toMatch(/before the start/)
  })

  it('reports a site issue as an open safety incident', async () => {
    const r = await run('demo-site_engineer', 'report_site_issue', { project: 'Office Block', description: '[DEMO] Scaffold board cracked on level 3', severity: 'near_miss', category: 'Fall from height' })
    expect(r.data).toMatchObject({ done: true, issue: { severity: 'near_miss', status: 'open' } })
    expect(demo.raw.all('safety_incidents').find((x) => /Scaffold board cracked/.test(x.description))).toMatchObject({ status: 'open', incident_date: TODAY })
  })
})

describe('finance and approvals', () => {
  it('records an expense as PENDING (it pays nothing) and the approver can then decide it', async () => {
    asked.length = 0
    const r = await run('demo-accountant', 'record_expense', { amount: 350000, category: 'fuel', description: '[DEMO] Diesel for the mixer', project: 'Office Block', payment_method: 'cash' })
    expect(r.data).toMatchObject({ done: true, expense: { status: 'pending' } })
    expect(r.data.expense.number).toMatch(/^PV-/)
    expect(asked[0].title_sw).toBe('Rekodi matumizi: TZS 350,000 – fuel')
    const id = r.data.expense.id
    // the accountant cannot approve their own expense
    const own = await run('demo-accountant', 'decide_approval', { kind: 'transaction', item: id, decision: 'approve' })
    expect(own.data.done).not.toBe(true)
    asked.length = 0
    const no = await run(MD, 'decide_approval', { kind: 'transaction', item: id, decision: 'approve' }, false)
    expect(no.data.declined).toBe(true)
    expect(demo.raw.get('financial_transactions', id)!.status).toBe('pending')
    expect(asked[0].lines_sw[0]).toMatch(/^Kiasi: TZS 350,000/)
    const yes = await run(MD, 'decide_approval', { kind: 'transaction', item: id, decision: 'approve' })
    expect(yes.data).toMatchObject({ done: true, decision: 'approved' })
    expect(demo.raw.get('financial_transactions', id)).toMatchObject({ status: 'approved', approved_by: MD })
    const audit = demo.raw.all(C.activity).filter((a) => a.action === 'assistant_action' && /decide_approval/.test(a.detail))
    expect(audit.map((a) => (/declined/.test(a.detail) ? 'declined' : /— done/.test(a.detail) ? 'done' : 'not done'))).toEqual(['declined', 'done'])
  })

  it('rejecting a purchase request needs a reason; unsupported decisions are refused', async () => {
    const pr = await run('demo-site_engineer', 'create_purchase_request', { project: 'Office Block', items: [{ material: 'sand', quantity: 5 }] })
    expect(pr.data.submitted).toBe(true)
    const noReason = await run(MD, 'decide_approval', { kind: 'purchase_request', item: pr.data.number, decision: 'reject' })
    expect(noReason.data.note).toMatch(/reason/)
    const r = await run(MD, 'decide_approval', { kind: 'purchase_request', item: pr.data.number, decision: 'reject', reason: 'Sand is still in stock' })
    expect(r.data).toMatchObject({ done: true, decision: 'rejected' })
    expect(demo.raw.all('purchase_requests').find((p) => p.number === pr.data.number)).toMatchObject({ status: 'rejected', review_comment: 'Sand is still in stock' })
    const po = await run(MD, 'decide_approval', { kind: 'boq', item: 'x', decision: 'reject' })
    expect(po.data.done).toBe(false)
  })
})

describe('documents', () => {
  it('opens the upload form filled in; nothing is uploaded by the assistant', async () => {
    const seen: string[] = []
    const target = new EventTarget()
    vi.stubGlobal('window', Object.assign(target, { dispatchEvent: target.dispatchEvent.bind(target) }))
    target.addEventListener(NAVIGATE_EVENT, (e) => seen.push((e as CustomEvent<string>).detail))
    try {
      const before = demo.raw.all('documents').length
      const r = await run(ADMIN, 'start_document_upload', { title: 'Mkataba wa Mbeya', category: 'contract', project: 'Office Block' })
      expect(r.data).toMatchObject({ opened: true, uploaded: false })
      expect(seen[0]).toMatch(/^\/documents\?upload=1&title=Mkataba\+wa\+Mbeya&category=contract&project=/)
      expect(demo.raw.all('documents').length).toBe(before)
    } finally {
      vi.stubGlobal('window', undefined)
    }
  })
})

describe('administration', () => {
  it('blocks and unblocks an ABCkit user account after confirmation; never yourself', async () => {
    const acc = () => demo.raw.get('profiles', 'demo-accountant')!
    expect(acc().is_active).toBe(true)
    const no = await run(ADMIN, 'set_user_access', { user: 'accountant', block: true }, false)
    expect(no.data.declined).toBe(true)
    expect(acc().is_active).toBe(true)
    asked.length = 0
    const r = await run(ADMIN, 'set_user_access', { user: 'accountant', block: true })
    expect(r.data).toMatchObject({ done: true, user: { active: false } })
    expect(asked[0].title_sw).toMatch(/^Zuia mtumiaji: /)
    expect(acc().is_active).toBe(false)
    const again = await run(ADMIN, 'set_user_access', { user: 'accountant', block: true })
    expect(again.data.note).toMatch(/already blocked/)
    expect((await run(ADMIN, 'set_user_access', { user: 'accountant', block: false })).data.done).toBe(true)
    expect(acc().is_active).toBe(true)
    const self = await run(ADMIN, 'set_user_access', { user: String(demo.raw.get('profiles', ADMIN)!.full_name), block: true })
    expect(self.data.done).toBe(false)
    // only user managers get the command
    expect((await run('demo-site_engineer', 'set_user_access', { user: 'accountant', block: true })).is_error).toBe(true)
  })

  it('changes a user role; only a super admin can hand out super admin', async () => {
    const r = await run(ADMIN, 'change_user_role', { user: 'demo-employee', role: 'storekeeper' })
    expect(r.data).toMatchObject({ done: true })
    expect(demo.raw.get('profiles', 'demo-employee')!.role_id).toBe('storekeeper')
    await run(ADMIN, 'change_user_role', { user: 'demo-employee', role: 'employee' })
    expect(demo.raw.get('profiles', 'demo-employee')!.role_id).toBe('employee')
    const unknown = await run(ADMIN, 'change_user_role', { user: 'demo-employee', role: 'astronaut' })
    expect(unknown.data.note).toMatch(/No role matches/)
  })
})
