import { describe, expect, it } from 'vitest'
import { computeAlerts, type MonitorInput } from '../shared/ai/monitor.js'

const TODAY = '2026-11-14'

function input(over: Partial<MonitorInput> = {}): MonitorInput {
  return {
    today: TODAY,
    settings: { schedule_slip_threshold_pct: 10, approval_stale_days: 2, low_stock_alerts: true },
    projects: [],
    tasks: [],
    boqs: [],
    site_reports: [],
    safety_incidents: [],
    purchase_requests: [],
    purchase_orders: [],
    financial_transactions: [],
    client_invoices: [],
    supplier_invoices: [],
    leave_requests: [],
    materials: [],
    emails: [],
    suppliers: [],
    clients: [],
    ...over,
  }
}

const P1 = { id: 'p1', code: 'PRJ-001', name: 'Mbezi Villas', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', progress: 40, budget: 1000, currency: 'TZS' }
const byKey = (alerts: ReturnType<typeof computeAlerts>) => new Map(alerts.map((a) => [a.dedupe_key, a]))

describe('computeAlerts — projects', () => {
  it('flags an active project whose progress lags elapsed time by more than the threshold', () => {
    // 317 of 364 days elapsed (~87%) vs 40% progress
    const a = byKey(computeAlerts(input({ projects: [P1] }))).get('project_behind_schedule:p1')!
    expect(a.type).toBe('project_behind_schedule')
    expect(a.priority).toBe('high')
    expect(a.record).toEqual({ table: 'projects', id: 'p1', label: 'Mbezi Villas', link: '/projects/p1' })
    expect(a.project).toEqual({ id: 'p1', name: 'Mbezi Villas' })
  })

  it('does not flag a project within the threshold, or a non-active one', () => {
    const onTrack = { ...P1, progress: 80 }
    const planning = { ...P1, id: 'p2', status: 'planning' }
    expect(computeAlerts(input({ projects: [onTrack, planning] }))).toEqual([])
  })

  it('uses medium priority for a small slip', () => {
    const p = { ...P1, progress: 70 } // ~87% elapsed → 17 points
    expect(byKey(computeAlerts(input({ projects: [p] }))).get('project_behind_schedule:p1')!.priority).toBe('medium')
  })

  it('flags a project past its end date (urgent after 30 days) instead of the slip alert', () => {
    const late = { ...P1, end_date: '2026-11-01', progress: 90 }
    const veryLate = { ...P1, id: 'p3', end_date: '2026-09-01', status: 'on_hold' }
    const done = { ...P1, id: 'p4', end_date: '2026-09-01', status: 'completed' }
    const m = byKey(computeAlerts(input({ projects: [late, veryLate, done] })))
    expect(m.get('project_past_end:p1')!.priority).toBe('high')
    expect(m.has('project_behind_schedule:p1')).toBe(false)
    expect(m.get('project_past_end:p3')!.priority).toBe('urgent')
    expect(m.has('project_past_end:p4')).toBe(false)
  })

  it('flags budget overrun from approved expenses only', () => {
    const txs = [
      { id: 't1', project_id: 'p1', direction: 'expense', status: 'approved', amount_base: 900 },
      { id: 't2', project_id: 'p1', direction: 'expense', status: 'approved', amount_base: 300 },
      { id: 't3', project_id: 'p1', direction: 'expense', status: 'pending', amount_base: 5000 },
      { id: 't4', project_id: 'p1', direction: 'income', status: 'approved', amount_base: 5000 },
    ]
    const a = byKey(computeAlerts(input({ projects: [{ ...P1, progress: 95 }], financial_transactions: txs }))).get('budget_overrun:p1')!
    expect(a.type).toBe('budget_overrun')
    expect(a.priority).toBe('urgent') // 120%
    expect(a.description).toContain('TZS 1,200')
  })

  it('warns when 90% of the budget is used with low progress', () => {
    const txs = [{ id: 't1', project_id: 'p1', direction: 'expense', status: 'approved', amount: 950 }]
    const m = byKey(computeAlerts(input({ projects: [{ ...P1, progress: 85, end_date: '2027-12-31' }, { ...P1, id: 'p9', progress: 50, budget: 1000 }], financial_transactions: [...txs, { id: 't9', project_id: 'p9', direction: 'expense', status: 'approved', amount: 950 }] })))
    expect(m.has('budget_risk:p1')).toBe(false) // progress >= 80
    expect(m.get('budget_risk:p9')!.priority).toBe('medium')
  })
})

describe('computeAlerts — tasks, approvals, money, deliveries, safety, stock', () => {
  it('flags overdue open tasks with priority from the task', () => {
    const tasks = [
      { id: 'a', title: 'Pour slab', status: 'in_progress', priority: 'critical', due_date: '2026-11-10', project_id: 'p1' },
      { id: 'b', title: 'Order tiles', status: 'todo', priority: 'medium', due_date: '2026-10-01' },
      { id: 'c', title: 'Done task', status: 'done', priority: 'high', due_date: '2026-10-01' },
      { id: 'd', title: 'Future', status: 'todo', priority: 'high', due_date: '2026-12-01' },
    ]
    const m = byKey(computeAlerts(input({ projects: [{ ...P1, progress: 90 }], tasks })))
    expect(m.get('task_overdue:a')!.priority).toBe('urgent')
    expect(m.get('task_overdue:a')!.project).toEqual({ id: 'p1', name: 'Mbezi Villas' })
    expect(m.get('task_overdue:b')!.priority).toBe('high') // medium raised after 14 days
    expect(m.get('task_overdue:b')!.record!.link).toBe('/tasks')
    expect(m.has('task_overdue:c')).toBe(false)
    expect(m.has('task_overdue:d')).toBe(false)
  })

  it('flags approvals older than approval_stale_days for every approval type', () => {
    const old = '2026-11-05T08:00:00.000Z'
    const fresh = '2026-11-13T08:00:00.000Z'
    const m = byKey(
      computeAlerts(
        input({
          boqs: [{ id: 'b1', number: 'BOQ-1', status: 'submitted', updated_at: old }, { id: 'b2', status: 'submitted', updated_at: fresh }],
          site_reports: [{ id: 's1', number: 'SR-1', status: 'submitted', submitted_at: old }],
          purchase_requests: [{ id: 'r1', number: 'PR-1', status: 'submitted', priority: 'urgent', updated_at: old }],
          purchase_orders: [{ id: 'o1', number: 'PO-1', status: 'pending_approval', updated_at: old }],
          financial_transactions: [{ id: 'f1', number: 'FT-1', status: 'pending', direction: 'expense', amount: 10, created_at: old }],
          leave_requests: [{ id: 'l1', status: 'pending', leave_type: 'annual', start_date: '2026-12-01', created_at: old }],
        }),
      ),
    )
    expect(m.get('approval_pending:boqs:b1')!.record!.link).toBe('/boq/b1')
    expect(m.has('approval_pending:boqs:b2')).toBe(false)
    expect(m.get('approval_pending:site_reports:s1')!.record!.link).toBe('/site-reports/s1')
    expect(m.get('approval_pending:purchase_requests:r1')!.priority).toBe('urgent') // high base, 9 days > 3x stale
    expect(m.get('approval_pending:purchase_orders:o1')!.record!.link).toBe('/procurement')
    expect(m.get('approval_pending:financial_transactions:f1')!.record!.link).toBe('/finance')
    expect(m.get('approval_pending:leave_requests:l1')!.record!.link).toBe('/workforce')
    expect([...m.values()].every((a) => a.type === 'approval_pending')).toBe(true)
  })

  it('flags overdue client and supplier invoices with an unpaid balance', () => {
    const m = byKey(
      computeAlerts(
        input({
          clients: [{ id: 'c1', name: 'Wizara ya Ujenzi' }],
          suppliers: [{ id: 's1', name: 'Simba Cement' }],
          client_invoices: [
            { id: 'ci1', number: 'INV-1', client_id: 'c1', status: 'partially_paid', due_date: '2026-09-01', total: 1000, currency: 'TZS' },
            { id: 'ci2', number: 'INV-2', client_id: 'c1', status: 'issued', due_date: '2026-11-01', total: 500 },
            { id: 'ci3', number: 'INV-3', status: 'paid', due_date: '2026-01-01', total: 500 },
          ],
          supplier_invoices: [{ id: 'si1', invoice_no: 'S-9', supplier_id: 's1', status: 'unpaid', due_date: '2026-11-10', total: 200 }],
          financial_transactions: [
            { id: 'x', status: 'approved', client_invoice_id: 'ci1', amount_base: 400, direction: 'income' },
            { id: 'y', status: 'approved', client_invoice_id: 'ci2', amount_base: 500, direction: 'income' },
          ],
        }),
      ),
    )
    const ci1 = m.get('client_invoice_overdue:ci1')!
    expect(ci1.type).toBe('payment_overdue')
    expect(ci1.priority).toBe('urgent') // 74 days
    expect(ci1.description).toContain('TZS 600')
    expect(m.has('client_invoice_overdue:ci2')).toBe(false) // fully paid
    expect(m.has('client_invoice_overdue:ci3')).toBe(false)
    expect(m.get('supplier_invoice_overdue:si1')!.priority).toBe('medium')
  })

  it('flags purchase orders past their expected date that are not fully received', () => {
    const m = byKey(
      computeAlerts(
        input({
          projects: [{ ...P1, progress: 90 }],
          purchase_orders: [
            { id: 'o1', number: 'PO-1', status: 'sent', expected_date: '2026-11-12', project_id: 'p1' },
            { id: 'o2', number: 'PO-2', status: 'partially_received', expected_date: '2026-10-01' },
            { id: 'o3', number: 'PO-3', status: 'received', expected_date: '2026-10-01' },
            { id: 'o4', number: 'PO-4', status: 'approved', expected_date: '2026-11-13' },
          ],
        }),
      ),
    )
    expect(m.get('po_delivery_overdue:o1')!.priority).toBe('medium')
    expect(m.get('po_delivery_overdue:o2')!.priority).toBe('high')
    expect(m.has('po_delivery_overdue:o3')).toBe(false)
    expect(m.get('po_delivery_overdue:o4')!.type).toBe('delivery_overdue')
  })

  it('flags open safety incidents by severity and low stock when enabled', () => {
    const base = input({
      safety_incidents: [
        { id: 'i1', status: 'open', severity: 'major', report_id: 'sr1', description: 'Fall from scaffold' },
        { id: 'i2', status: 'closed', severity: 'fatal' },
      ],
      materials: [
        { id: 'm1', name: 'Cement', unit: 'bags', min_stock: 50, current_stock: 0 },
        { id: 'm2', name: 'Sand', unit: 't', min_stock: 10, current_stock: 8 },
        { id: 'm3', name: 'Nails', unit: 'kg', min_stock: 10, current_stock: 30 },
      ],
    })
    const m = byKey(computeAlerts(base))
    expect(m.get('safety_incident:i1')!.priority).toBe('high')
    expect(m.get('safety_incident:i1')!.record!.link).toBe('/site-reports/sr1')
    expect(m.has('safety_incident:i2')).toBe(false)
    expect(m.get('low_stock:m1')!.priority).toBe('high')
    expect(m.get('low_stock:m2')!.priority).toBe('medium')
    expect(m.has('low_stock:m3')).toBe(false)
    const off = byKey(computeAlerts({ ...base, settings: { ...base.settings, low_stock_alerts: false } }))
    expect([...off.keys()].some((k) => k.startsWith('low_stock'))).toBe(false)
  })
})

describe('computeAlerts — emails', () => {
  const insight = (over: Record<string, unknown> = {}) => ({
    category: 'supplier',
    priority: 'medium',
    is_important: true,
    summary: 'Supplier says the cement delivery will be late.',
    required_action: null,
    related_project_id: null,
    related_party: { type: null, id: null, name: null },
    flags: { complaint: false, delivery_issue: false, payment_related: false, approval_request: false, meeting_request: false, suspicious_instructions: false },
    ...over,
  })
  const email = (id: string, ai: Record<string, unknown>, from = 'orders@simbacement.co.tz', folder = 'inbox') => ({
    id,
    subject: `Subject ${id}`,
    folder,
    status: 'analyzed',
    from: { name: null, address: from },
    ai,
  })
  const suppliers = [{ id: 's1', name: 'Simba Cement', email: 'sales@simbacement.co.tz' }]

  it('cross-checks a delivery issue with the supplier’s open POs and raises priority for active projects', () => {
    const flags = { ...insight().flags, delivery_issue: true }
    const m = byKey(
      computeAlerts(
        input({
          projects: [{ ...P1, progress: 90 }],
          suppliers,
          purchase_orders: [
            { id: 'o1', number: 'PO-7', supplier_id: 's1', project_id: 'p1', status: 'sent', expected_date: '2026-11-20' },
            { id: 'o2', number: 'PO-8', supplier_id: 'other', status: 'sent', expected_date: '2026-11-20' },
          ],
          emails: [email('e1', insight({ flags }))],
        }),
      ),
    )
    const a = m.get('supplier_delivery_issue:e1')!
    expect(a.type).toBe('supplier_delivery_issue')
    expect(a.source).toBe('email')
    expect(a.priority).toBe('high') // medium raised: PO on an active project
    expect(a.title).toContain('Simba Cement') // matched by sender domain
    expect(a.description).toContain('PO-7')
    expect(a.description).not.toContain('PO-8')
    expect(a.project).toEqual({ id: 'p1', name: 'Mbezi Villas' })
    expect(a.record!.link).toBe('/ai?tab=email&email=e1')
  })

  it('keeps medium priority when the supplier has no PO on an active project, and says when no supplier matches', () => {
    const flags = { ...insight().flags, delivery_issue: true }
    const m = byKey(computeAlerts(input({ suppliers, emails: [email('e1', insight({ flags })), email('e2', insight({ flags }), 'someone@gmail.com')] })))
    expect(m.get('supplier_delivery_issue:e1')!.priority).toBe('medium')
    expect(m.get('supplier_delivery_issue:e1')!.description).toContain('No open purchase orders')
    expect(m.get('supplier_delivery_issue:e2')!.description).toContain('could not be matched')
  })

  it('creates complaint and urgent-email alerts, skipping sent mail and unanalysed mail', () => {
    const m = byKey(
      computeAlerts(
        input({
          emails: [
            email('c1', insight({ category: 'complaint', flags: { ...insight().flags, complaint: true } })),
            email('u1', insight({ priority: 'urgent', is_important: true })),
            email('h1', insight({ priority: 'high', is_important: true })),
            email('h2', insight({ priority: 'high', is_important: false })),
            email('s1', insight({ priority: 'urgent' }), 'me@aricom.co.tz', 'sent'),
            { ...email('n1', insight({ priority: 'urgent' })), status: 'new' },
          ],
        }),
      ),
    )
    expect(m.get('client_complaint:c1')!.priority).toBe('high')
    expect(m.get('urgent_email:u1')!.priority).toBe('urgent')
    expect(m.get('urgent_email:h1')!.priority).toBe('high')
    expect(m.has('urgent_email:h2')).toBe(false)
    expect(m.has('urgent_email:s1')).toBe(false)
    expect(m.has('urgent_email:n1')).toBe(false)
  })

  it('warns about suspicious instructions in the description', () => {
    const a = computeAlerts(input({ emails: [email('u1', insight({ priority: 'urgent', flags: { ...insight().flags, suspicious_instructions: true } }))] }))[0]
    expect(a.description).toMatch(/Caution/)
  })
})

describe('computeAlerts — determinism', () => {
  it('produces identical, sorted output with stable dedupe keys for the same input', () => {
    const inp = input({
      projects: [P1, { ...P1, id: 'p2', name: 'B', end_date: '2026-10-01' }],
      tasks: [{ id: 't', title: 'x', status: 'todo', due_date: '2026-11-01' }],
      materials: [{ id: 'm1', name: 'Cement', min_stock: 5, current_stock: 1 }],
    })
    const a = computeAlerts(inp)
    const b = computeAlerts(JSON.parse(JSON.stringify(inp)))
    expect(b).toEqual(a)
    expect(a.map((x) => x.dedupe_key)).toEqual(['project_past_end:p2', 'project_behind_schedule:p1', 'low_stock:m1', 'task_overdue:t']) // urgent, high, medium, medium (by key)
    expect(new Set(a.map((x) => x.dedupe_key)).size).toBe(a.length)
  })
})
