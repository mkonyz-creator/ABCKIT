import { beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, ok } from '../testing'
import { defineView, registry, type Row } from '../registry'
import { roundTo } from './analytics'

/*
 * Raw rows are seeded with t.raw.put (no hooks), so these tests only depend on the analytics domain.
 * boq_totals / purchase_order_totals belong to other domains; if they are not registered (yet),
 * equivalent stubs following the SQL definitions are registered here.
 */
beforeAll(() => {
  if (!registry.view('boq_totals'))
    defineView('boq_totals', async (ctx) => {
      const [boqs, items] = await Promise.all([ctx.select('boqs'), ctx.select('boq_items')])
      return boqs.map((b) => {
        const sub = items.filter((i) => i.boq_id === b.id).reduce((a, i) => a + Number(i.amount), 0)
        const rate = ((b.taxes ?? []) as Row[]).reduce((a, t) => a + Number(t.rate), 0)
        return { boq_id: b.id, project_id: b.project_id, subtotal: sub, tax_rate_total: rate, grand_total: roundTo(sub * (1 + rate / 100), 2) }
      })
    })
  if (!registry.view('purchase_order_totals'))
    defineView('purchase_order_totals', async (ctx) => {
      const [pos, items] = await Promise.all([ctx.select('purchase_orders'), ctx.select('purchase_order_items')])
      return pos.map((po) => {
        const sub = items.filter((i) => i.po_id === po.id).reduce((a, i) => a + Number(i.amount), 0)
        return { po_id: po.id, subtotal: sub, total: roundTo(sub * (1 + Number(po.tax_rate) / 100), 2) }
      })
    })
})

// ----------------------------------------------------------------------------- dates

const pad = (n: number) => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const day = (n: number) => {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + n))
  return d.toISOString().slice(0, 10)
}
const month = (n: number) => new Date(Date.UTC(now.getFullYear(), now.getMonth() + n, 1)).toISOString().slice(0, 10)

// ----------------------------------------------------------------------------- fixture

function setup() {
  const t = createTestDb()
  const admin = t.addUser('super_admin', { name: 'Admin' })
  const accountant = t.addUser('accountant', { name: 'Acc' })
  const pm = t.addUser('project_manager', { name: 'PM' })
  const employee = t.addUser('employee', { name: 'Emp' })
  const procurement = t.addUser('procurement_officer')
  const hr = t.addUser('hr_officer')
  const storekeeper = t.addUser('storekeeper')
  const put = (table: string, rows: Row[]) => rows.forEach((r) => t.raw.put(table, String(r.id), r))

  const project = (id: string, name: string, o: Row) => ({
    id, code: `P-${id}`, name, status: 'active', progress: 0, contract_value: 0, budget: 0, start_date: '2026-01-01', end_date: null,
    is_archived: false, is_demo: false, project_manager_id: null, created_by: null, updated_at: '2026-11-01T00:00:00Z', ...o,
  })
  put('projects', [
    project('p1', 'Alpha', { progress: 40, contract_value: 1_000_000, budget: 500_000, end_date: day(10), updated_at: '2026-11-01T00:00:00Z' }),
    project('p2', 'Beta', { status: 'planning', contract_value: 200_000, end_date: day(100), updated_at: '2026-11-05T00:00:00Z' }),
    project('p3', 'Gamma', { status: 'completed', progress: 100, contract_value: 300_000, budget: 100_000, is_archived: true }),
    project('p4', 'Delta', { status: 'cancelled', contract_value: 50_000, budget: 40_000 }),
  ])
  for (const [pid, uid] of [['p1', pm], ['p1', employee]]) t.raw.put('project_members', `${pid}__${uid}`, { project_id: pid, user_id: uid, member_role: 'member' })

  const ft = (id: string, o: Row) => ({ id, number: `FT-${id}`, project_id: 'p1', direction: 'expense', category: 'materials', amount_base: 0, status: 'approved', transaction_date: today, client_invoice_id: null, supplier_invoice_id: null, ...o })
  put('financial_transactions', [
    ft('f1', { amount_base: 120_000.5 }),
    ft('f2', { category: 'labour', amount_base: 30_000 }),
    ft('f3', { direction: 'income', category: 'payment', amount_base: 200_000, client_invoice_id: 'ci1' }),
    ft('f4', { amount_base: 99_999, status: 'pending' }),
    ft('f5', { project_id: 'p2', amount_base: 1_000, transaction_date: month(-1) }),
    ft('f6', { amount_base: 5_000, supplier_invoice_id: 'si1' }),
  ])
  put('client_invoices', [
    { id: 'ci1', number: 'INV-1', project_id: 'p1', total: 250_000, status: 'partially_paid' },
    { id: 'ci2', number: 'INV-2', project_id: 'p1', total: 70_000, status: 'void' },
    { id: 'ci3', number: 'INV-3', project_id: 'p2', total: 10_000, status: 'issued' },
  ])
  put('supplier_invoices', [
    { id: 'si1', supplier_id: 's1', project_id: 'p1', total: 8_000, status: 'partially_paid' },
    { id: 'si2', supplier_id: 's1', project_id: 'p1', total: 2_000, status: 'void' },
    { id: 'si3', supplier_id: 's2', project_id: 'p2', total: 4_000, status: 'paid' },
  ])
  put('boqs', [
    { id: 'b1', project_id: 'p1', status: 'approved', taxes: [{ name: 'VAT', rate: 18 }], updated_at: '2026-10-01T00:00:00Z' },
    { id: 'b2', project_id: 'p1', status: 'draft', taxes: [], updated_at: '2026-11-10T00:00:00Z' },
    { id: 'b3', project_id: 'p1', status: 'superseded', taxes: [], updated_at: '2026-11-12T00:00:00Z' },
    { id: 'b4', project_id: 'p2', status: 'draft', taxes: [{ rate: 10 }, { rate: 5 }], updated_at: '2026-11-01T00:00:00Z' },
  ])
  // project_id is denormalised from the parent BOQ by the engine (defineInherit); raw rows must carry it too
  put('boq_items', [
    { id: 'bi1', boq_id: 'b1', project_id: 'p1', amount: 1_000 },
    { id: 'bi2', boq_id: 'b1', project_id: 'p1', amount: 500 },
    { id: 'bi3', boq_id: 'b2', project_id: 'p1', amount: 3_000 },
    { id: 'bi4', boq_id: 'b3', project_id: 'p1', amount: 9_000 },
    { id: 'bi5', boq_id: 'b4', project_id: 'p2', amount: 100 },
  ])

  put('materials', [
    { id: 'm1', name: 'Cement', unit: 'bag', current_stock: 5, min_stock: 10, unit_price: 15_000, is_active: true },
    { id: 'm2', name: 'Steel', unit: 'kg', current_stock: 100, min_stock: 20, unit_price: 2_000, is_active: true },
    { id: 'm3', name: 'Sand', unit: 't', current_stock: 0, min_stock: 5, unit_price: 100, is_active: true },
    { id: 'm4', name: 'Old', unit: 'pc', current_stock: 1, min_stock: 10, unit_price: 1, is_active: false },
  ])
  const it = (id: string, o: Row) => ({ id, material_id: 'm1', project_id: 'p1', txn_type: 'issue', quantity: 0, unit_price: 15_000, ...o })
  put('inventory_transactions', [
    it('it1', { quantity: 10 }),
    it('it2', { txn_type: 'return', quantity: 2 }),
    it('it3', { txn_type: 'receipt', quantity: 100, unit_price: 14_000 }),
    it('it4', { material_id: 'm2', quantity: 5.5, unit_price: null }),
    it('it5', { project_id: null, quantity: 3 }),
  ])

  put('suppliers', [
    { id: 's1', name: 'Acme Supplies', category: 'materials', rating: 4, is_active: true },
    { id: 's2', name: 'Bolt Co', category: 'hardware', rating: 3, is_active: true },
    { id: 's3', name: 'Idle Ltd', category: null, rating: null, is_active: false },
  ])
  put('purchase_orders', [
    { id: 'po1', supplier_id: 's1', project_id: 'p1', status: 'received', expected_date: day(-10), tax_rate: 18 },
    { id: 'po2', supplier_id: 's1', project_id: 'p1', status: 'approved', expected_date: day(-20), tax_rate: 0 },
    { id: 'po3', supplier_id: 's1', project_id: 'p1', status: 'draft', expected_date: null, tax_rate: 0 },
    { id: 'po4', supplier_id: 's2', project_id: 'p2', status: 'sent', expected_date: null, tax_rate: 0 },
  ])
  put('purchase_order_items', [
    { id: 'poi1', po_id: 'po1', amount: 1_000 },
    { id: 'poi2', po_id: 'po2', amount: 500 },
    { id: 'poi3', po_id: 'po3', amount: 9_999 },
    { id: 'poi4', po_id: 'po4', amount: 200 },
  ])
  put('goods_received', [
    { id: 'g1', po_id: 'po1', supplier_id: 's1', project_id: 'p1', received_date: day(-12) },
    { id: 'g2', po_id: 'po1', supplier_id: 's1', project_id: 'p1', received_date: day(-5) },
    { id: 'g3', po_id: 'po2', supplier_id: 's1', project_id: 'p1', received_date: day(-15) },
    { id: 'g4', po_id: 'po4', supplier_id: 's2', project_id: 'p2', received_date: day(-1) },
  ])

  put('equipment', [
    { id: 'e1', code: 'EQ-1', name: 'Excavator', category: 'earthmoving', status: 'in_use', ownership: 'owned', current_project_id: 'p1', hourly_rate: 50_000 },
    { id: 'e2', code: 'EQ-2', name: 'Roller', category: 'compaction', status: 'available', ownership: 'hired', current_project_id: null, hourly_rate: null },
  ])
  const log = (id: string, o: Row) => ({ id, equipment_id: 'e1', project_id: 'p1', usage_date: day(-1), hours_operated: 0, idle_hours: 0, fuel_litres: 0, fuel_cost: 0, ...o })
  put('equipment_usage_logs', [
    log('l1', { hours_operated: 8, idle_hours: 1, fuel_litres: 50, fuel_cost: 100_000 }),
    log('l2', { hours_operated: 4, fuel_litres: 20, fuel_cost: 40_000 }),
    log('l3', { usage_date: day(-29), hours_operated: 6 }),
    log('l4', { usage_date: day(-30), hours_operated: 100 }),
  ])
  put('maintenance_records', [
    { id: 'mr1', equipment_id: 'e1', maintenance_type: 'breakdown', cost: 500_000, downtime_hours: 12.5, status: 'completed' },
    { id: 'mr2', equipment_id: 'e1', maintenance_type: 'service', cost: 100, downtime_hours: 1, status: 'cancelled' },
    { id: 'mr3', equipment_id: 'e1', maintenance_type: 'service', cost: 20_000, downtime_hours: 2, status: 'scheduled' },
  ])

  put('employees', [
    { id: 'emp1', full_name: 'Juma', status: 'active', profile_id: employee },
    { id: 'emp2', full_name: 'Neema', status: 'on_leave', profile_id: null },
    { id: 'emp3', full_name: 'Gone', status: 'terminated', profile_id: null },
  ])
  const owner: Record<string, string | null> = { emp1: employee, emp2: null }
  put('attendance', [
    { id: 'a1', employee_id: 'emp1', project_id: 'p1', work_date: today, status: 'present', hours_worked: 8, overtime_hours: 1.5 },
    { id: 'a2', employee_id: 'emp2', project_id: 'p1', work_date: today, status: 'sick', hours_worked: 0, overtime_hours: 0 },
    { id: 'a3', employee_id: 'emp1', project_id: 'p1', work_date: day(-1), status: 'late', hours_worked: 7.5, overtime_hours: 0 },
    { id: 'a4', employee_id: 'emp2', project_id: 'p2', work_date: day(-5), status: 'present', hours_worked: 8, overtime_hours: 0 },
  ].map((a) => ({ ...a, employee_profile_id: owner[a.employee_id] })))

  put('tasks', [
    { id: 't1', project_id: 'p1', title: 'Order steel', status: 'todo', priority: 'medium', due_date: day(3), assigned_to: admin },
    { id: 't2', project_id: 'p1', title: 'Pour slab', status: 'in_progress', priority: 'high', due_date: day(-2), assigned_to: employee },
    { id: 't3', project_id: 'p1', title: 'Done thing', status: 'done', priority: 'low', due_date: day(-1), assigned_to: employee },
    { id: 't4', project_id: 'p2', title: 'Later', status: 'todo', priority: 'low', due_date: day(30), assigned_to: null },
  ])
  put('site_reports', [
    { id: 'r1', project_id: 'p1', report_date: day(-1), status: 'submitted' },
    { id: 'r2', project_id: 'p1', report_date: day(-10), status: 'approved' },
  ])
  put('safety_incidents', [
    { id: 'i1', project_id: 'p1', status: 'open' },
    { id: 'i2', project_id: 'p1', status: 'closed' },
  ])

  const audit = (id: string, table_name: string, action: string, data: Row, at: number, by: string | null = admin) => ({
    id, table_name, record_id: data.id ?? id, action, old_data: action === 'DELETE' ? data : null, new_data: action === 'DELETE' ? null : data,
    changed_by: by, changed_at: `2026-11-1${at}T08:00:00.000Z`,
  })
  put('audit_logs', [
    audit('al1', 'projects', 'INSERT', { id: 'p1', name: 'Alpha', code: 'P-p1' }, 1),
    audit('al2', 'financial_transactions', 'INSERT', { id: 'f1', number: 'FT-f1', project_id: 'p1' }, 2),
    audit('al3', 'tasks', 'UPDATE', { id: 't4', title: 'Later', project_id: 'p2' }, 3, employee),
    audit('al4', 'employees', 'INSERT', { id: 'emp1', full_name: 'Juma' }, 4),
    audit('al5', 'documents', 'INSERT', { id: 'd1', title: 'Secret', access_level: 'restricted', project_id: 'p1' }, 5),
    audit('al6', 'documents', 'INSERT', { id: 'd2', title: 'Drawing', access_level: 'project', project_id: 'p1' }, 6),
    audit('al7', 'clients', 'DELETE', { id: 'c1', name: 'Old client' }, 7, null),
  ])

  return { t, admin, accountant, pm, employee, procurement, hr, storekeeper }
}

const byKey = <T extends Row>(rows: T[], key: string) => Object.fromEntries(rows.map((r) => [r[key], r]))

// ----------------------------------------------------------------------------- tests

describe('analytics views', () => {
  it('roundTo rounds half away from zero like PostgreSQL', () => {
    expect(roundTo(1.005, 2)).toBe(1.01)
    expect(roundTo(-2.5, 0)).toBe(-3)
    expect(roundTo(31.0001, 1)).toBe(31)
  })

  it('client_invoice_balances: paid = approved payments, finance.view only', async () => {
    const s = setup()
    const rows = ok(await s.t.as(s.accountant).from('client_invoice_balances').select('id,total,paid,balance,status'))
    const by = byKey(rows, 'id')
    expect(by.ci1).toMatchObject({ total: 250_000, paid: 200_000, balance: 50_000 })
    expect(by.ci2).toMatchObject({ paid: 0, balance: 70_000 })
    expect(rows).toHaveLength(3)
    // single-row lookup by id (FinancePage readFrom) works on the view
    const one = ok(await s.t.as(s.accountant).from('client_invoice_balances').select('*').eq('id', 'ci1').single())
    expect(one.number).toBe('INV-1')
    // project manager: finance.view but only the projects they belong to
    const pmRows = ok(await s.t.as(s.pm).from('client_invoice_balances').select('id'))
    expect(pmRows.map((r) => r.id).sort()).toEqual(['ci1', 'ci2'])
    expect(ok(await s.t.as(s.procurement).from('client_invoice_balances').select('id'))).toEqual([])
    expect(ok(await s.t.as(s.employee).from('client_invoice_balances').select('id'))).toEqual([])
  })

  it('supplier_invoice_balances: payments only count for finance viewers (RLS on financial_transactions)', async () => {
    const s = setup()
    const acc = byKey(ok(await s.t.as(s.accountant).from('supplier_invoice_balances').select('id,paid,balance')), 'id')
    expect(acc.si1).toMatchObject({ paid: 5_000, balance: 3_000 })
    expect(acc.si3).toMatchObject({ paid: 0, balance: 4_000 })
    const proc = byKey(ok(await s.t.as(s.procurement).from('supplier_invoice_balances').select('id,paid,balance')), 'id')
    expect(proc.si1).toMatchObject({ paid: 0, balance: 8_000 })
    expect(ok(await s.t.as(s.employee).from('supplier_invoice_balances').select('id'))).toEqual([])
  })

  it('project_financials: costs, income, receivables, budget use and the current BOQ', async () => {
    const s = setup()
    const rows = ok(await s.t.as(s.accountant).from('project_financials').select('*').order('name'))
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma'])
    const by = byKey(rows, 'project_id')
    expect(by.p1).toMatchObject({
      code: 'P-p1', status: 'active', progress: 40, contract_value: 1_000_000, budget: 500_000, is_archived: false, is_demo: false,
      actual_cost: 155_000.5, income_received: 200_000, invoiced: 250_000, outstanding_receivable: 50_000,
      remaining_budget: 344_999.5, budget_used_pct: 31, boq_total: 1_770, net_cash: 44_999.5,
    })
    expect(by.p2).toMatchObject({ actual_cost: 1_000, budget_used_pct: 0, remaining_budget: -1_000, invoiced: 10_000, outstanding_receivable: 10_000, boq_total: 115, net_cash: -1_000 })
    expect(by.p4).toMatchObject({ actual_cost: 0, remaining_budget: 40_000, boq_total: 0 })
    // filters are applied on the computed rows
    const archived = ok(await s.t.as(s.accountant).from('project_financials').select('project_id').eq('is_archived', true))
    expect(archived).toEqual([{ project_id: 'p3' }])
  })

  it('project_financials respects project access and finance permission', async () => {
    const s = setup()
    const pmRows = ok(await s.t.as(s.pm).from('project_financials').select('project_id,actual_cost,boq_total'))
    expect(pmRows).toEqual([{ project_id: 'p1', actual_cost: 155_000.5, boq_total: 1_770 }])
    // employee: sees the project row (projects.view) but no money from finance tables or BOQs
    const emp = ok(await s.t.as(s.employee).from('project_financials').select('project_id,actual_cost,income_received,invoiced,boq_total,budget'))
    expect(emp).toEqual([{ project_id: 'p1', actual_cost: 0, income_received: 0, invoiced: 0, boq_total: 0, budget: 500_000 }])
  })

  it('project_cost_breakdown groups approved expenses by project and category', async () => {
    const s = setup()
    const rows = ok(await s.t.as(s.accountant).from('project_cost_breakdown').select('*'))
    const by = Object.fromEntries(rows.map((r) => [`${r.project_id}/${r.category}`, r]))
    expect(Object.keys(by).sort()).toEqual(['p1/labour', 'p1/materials', 'p2/materials'])
    expect(by['p1/materials']).toMatchObject({ amount: 125_000.5, txn_count: 2 })
    expect(by['p1/labour']).toMatchObject({ amount: 30_000, txn_count: 1 })
    const pm = ok(await s.t.as(s.pm).from('project_cost_breakdown').select('project_id').eq('project_id', 'p2'))
    expect(pm).toEqual([])
    expect(ok(await s.t.as(s.employee).from('project_cost_breakdown').select('*'))).toEqual([])
  })

  it('material_consumption: issues minus returns per project and material', async () => {
    const s = setup()
    const rows = ok(await s.t.as(s.storekeeper).from('material_consumption').select('*').eq('project_id', 'p1'))
    const by = byKey(rows, 'material_id')
    expect(rows).toHaveLength(2)
    expect(by.m1).toEqual({ project_id: 'p1', material_id: 'm1', material_name: 'Cement', unit: 'bag', qty_consumed: 8, value_consumed: 120_000 })
    expect(by.m2).toMatchObject({ material_name: 'Steel', qty_consumed: 5.5, value_consumed: 0 })
    expect(ok(await s.t.as(s.employee).from('material_consumption').select('*'))).toEqual([])
  })

  it('supplier_performance: orders, value, on-time delivery and outstanding balance', async () => {
    const s = setup()
    const acc = byKey(ok(await s.t.as(s.accountant).from('supplier_performance').select('*').order('order_value', { ascending: false })), 'supplier_id')
    expect(acc.s1).toEqual({
      supplier_id: 's1', name: 'Acme Supplies', category: 'materials', rating: 4, is_active: true,
      orders: 2, order_value: 1_680, orders_completed: 1, on_time_orders: 1, orders_with_due_date: 2, outstanding_balance: 3_000,
    })
    expect(acc.s2).toMatchObject({ orders: 1, order_value: 200, orders_completed: 0, on_time_orders: 0, orders_with_due_date: 0, outstanding_balance: 4_000 })
    expect(acc.s3).toMatchObject({ orders: 0, order_value: 0, outstanding_balance: 0 })
    // procurement cannot see payments (finance.view) → full invoice total is outstanding
    const proc = byKey(ok(await s.t.as(s.procurement).from('supplier_performance').select('supplier_id,outstanding_balance')), 'supplier_id')
    expect(proc.s1.outstanding_balance).toBe(8_000)
    expect(ok(await s.t.as(s.employee).from('supplier_performance').select('*'))).toEqual([])
  })

  it('equipment_utilization: last-30-day usage and lifetime maintenance', async () => {
    const s = setup()
    const rows = ok(await s.t.as(s.accountant).from('equipment_utilization').select('*').order('hours_30d', { ascending: false }))
    expect(rows.map((r) => r.equipment_id)).toEqual(['e1', 'e2'])
    expect(rows[0]).toEqual({
      equipment_id: 'e1', code: 'EQ-1', name: 'Excavator', category: 'earthmoving', status: 'in_use', ownership: 'owned', current_project_id: 'p1', hourly_rate: 50_000,
      hours_30d: 18, idle_hours_30d: 1, fuel_litres_30d: 70, fuel_cost_30d: 140_000, days_logged_30d: 2, utilization_pct: 7.5,
      maintenance_cost_total: 520_000, downtime_hours_total: 14.5, breakdowns_total: 1,
    })
    expect(rows[1]).toMatchObject({ hours_30d: 0, utilization_pct: 0, maintenance_cost_total: 0, breakdowns_total: 0 })
    expect(ok(await s.t.as(s.employee).from('equipment_utilization').select('*'))).toEqual([])
  })
})

describe('analytics RPCs', () => {
  it('dashboard_summary for a super admin', async () => {
    const s = setup()
    const d = ok(await s.t.as(s.admin).rpc('dashboard_summary')) as any
    expect(d.projects).toEqual({ active: 1, completed: 0, pending: 1, on_hold: 0, total: 3, contract_value: 1_200_000, budget: 500_000, avg_progress: 40 })
    expect(d.finance).toEqual({ expenditure: 156_000.5, income: 200_000, remaining_budget: 343_999.5, receivable: 60_000, payable: 3_000, pending_approvals: 1 })
    expect(d.inventory.low_stock_count).toBe(2)
    expect(d.inventory.low_stock.map((m: Row) => m.id)).toEqual(['m3', 'm1'])
    expect(d.inventory.low_stock[1]).toEqual({ id: 'm1', name: 'Cement', unit: 'bag', current_stock: 5, min_stock: 10 })
    expect(d.inventory.stock_value).toBe(275_000)
    expect(d.workforce).toEqual({ employees: 2, present_today: 1, absent_today: 1, on_leave: 1 })
    expect(d.progress.map((p: Row) => p.id)).toEqual(['p1', 'p2'])
    expect(d.progress[0]).toEqual({ id: 'p1', code: 'P-p1', name: 'Alpha', progress: 40, status: 'active', end_date: day(10) })
    expect(d.deadlines.map((x: Row) => `${x.kind}:${x.id}`)).toEqual(['task:t2', 'task:t1', 'project:p1'])
    expect(d.deadlines[0]).toEqual({ kind: 'task', id: 't2', label: 'Pour slab', due: day(-2), priority: 'high', project: 'Alpha', status: 'in_progress' })
    expect(d.deadlines[2]).toEqual({ kind: 'project', id: 'p1', label: 'Alpha', due: day(10), priority: 'high', project: 'P-p1', status: 'active' })
    expect(d.tasks).toEqual({ open: 3, overdue: 1, mine: 1 })
    expect(d.site).toEqual({ pending_reports: 1, reports_7d: 1, open_incidents: 1 })
  })

  it('dashboard_summary hides modules the role may not see', async () => {
    const s = setup()
    const d = ok(await s.t.as(s.employee).rpc('dashboard_summary')) as any
    expect(d.finance).toBeNull()
    expect(d.inventory).toBeNull()
    expect(d.workforce).toBeNull()
    expect(d.site).toBeNull()
    expect(d.projects).toMatchObject({ active: 1, total: 1, contract_value: 1_000_000 })
    expect(d.tasks).toEqual({ open: 2, overdue: 1, mine: 1 })
    expect(d.deadlines.map((x: Row) => x.id)).toEqual(['t2', 't1', 'p1'])

    const hr = ok(await s.t.as(s.hr).rpc('dashboard_summary')) as any
    expect(hr.finance).toBeNull()
    expect(hr.workforce).toEqual({ employees: 2, present_today: 1, absent_today: 1, on_leave: 1 })

    const pm = ok(await s.t.as(s.pm).rpc('dashboard_summary')) as any
    expect(pm.finance).toMatchObject({ expenditure: 155_000.5, income: 200_000, receivable: 50_000, pending_approvals: 1 })
  })

  it('monthly_finance: one row per month, approved transactions only, optional project filter', async () => {
    const s = setup()
    const rows = ok(await s.t.as(s.accountant).rpc('monthly_finance', { p_months: 3 })) as Row[]
    expect(rows).toEqual([
      { month: month(-2), income: 0, expense: 0 },
      { month: month(-1), income: 0, expense: 1_000 },
      { month: month(0), income: 200_000, expense: 155_000.5 },
    ])
    const p1 = ok(await s.t.as(s.accountant).rpc('monthly_finance', { p_months: 2, p_project: 'p1' })) as Row[]
    expect(p1.map((r) => r.expense)).toEqual([0, 155_000.5])
    expect(ok(await s.t.as(s.accountant).rpc('monthly_finance', { p_months: 0 }))).toHaveLength(1)
    expect(ok(await s.t.as(s.accountant).rpc('monthly_finance'))).toHaveLength(12)
    const emp = ok(await s.t.as(s.employee).rpc('monthly_finance', { p_months: 3 })) as Row[]
    expect(emp.every((r) => r.income === 0 && r.expense === 0)).toBe(true)
  })

  it('workforce_productivity: daily attendance, own rows only without hr.view', async () => {
    const s = setup()
    const rows = ok(await s.t.as(s.hr).rpc('workforce_productivity', { p_days: 3 })) as Row[]
    expect(rows).toEqual([
      { day: day(-2), present: 0, absent: 0, hours: 0, overtime: 0 },
      { day: day(-1), present: 1, absent: 0, hours: 7.5, overtime: 0 },
      { day: today, present: 1, absent: 1, hours: 8, overtime: 1.5 },
    ])
    const sumPresent = (rs: Row[]) => rs.reduce((a, r) => a + r.present, 0)
    expect(sumPresent(ok(await s.t.as(s.hr).rpc('workforce_productivity', { p_days: 6 })) as Row[])).toBe(3)
    expect(sumPresent(ok(await s.t.as(s.hr).rpc('workforce_productivity', { p_days: 6, p_project: 'p1' })) as Row[])).toBe(2)
    expect(ok(await s.t.as(s.hr).rpc('workforce_productivity'))).toHaveLength(14)
    // employee (linked to emp1): only their own attendance
    const own = ok(await s.t.as(s.employee).rpc('workforce_productivity', { p_days: 6 })) as Row[]
    expect(own.reduce((a, r) => a + r.present, 0)).toBe(2)
    expect(own.reduce((a, r) => a + r.absent, 0)).toBe(0)
    // procurement has neither hr.view nor an employee record
    const proc = ok(await s.t.as(s.procurement).rpc('workforce_productivity', { p_days: 6 })) as Row[]
    expect(proc.every((r) => r.present === 0 && r.hours === 0)).toBe(true)
  })

  it('recent_activity: sanitised feed filtered by module permission and project access', async () => {
    const s = setup()
    const all = ok(await s.t.as(s.admin).rpc('recent_activity', { p_limit: 20 })) as Row[]
    expect(all.map((a) => a.id)).toEqual(['al7', 'al6', 'al3', 'al2', 'al1'])
    expect(all[0]).toEqual({ id: 'al7', table_name: 'clients', action: 'DELETE', label: 'Old client', project_id: null, actor: 'System', changed_at: '2026-11-17T08:00:00.000Z' })
    expect(all[2]).toMatchObject({ label: 'Later', project_id: 'p2', actor: 'Emp' })
    expect(all[3]).toMatchObject({ label: 'FT-f1', actor: 'Admin' })
    expect(all[4]).toMatchObject({ label: 'Alpha', project_id: null })

    const limited = ok(await s.t.as(s.admin).rpc('recent_activity', { p_limit: 2 })) as Row[]
    expect(limited.map((a) => a.id)).toEqual(['al7', 'al6'])
    const proj = ok(await s.t.as(s.admin).rpc('recent_activity', { p_project: 'p1' })) as Row[]
    expect(proj.map((a) => a.id)).toEqual(['al6', 'al2', 'al1'])

    // employee: no finance, not a member of p2
    const emp = ok(await s.t.as(s.employee).rpc('recent_activity', { p_limit: 20 })) as Row[]
    expect(emp.map((a) => a.id)).toEqual(['al7', 'al6', 'al1'])

    const inactive = s.t.addUser('employee', { active: false })
    expect(ok(await s.t.as(inactive).rpc('recent_activity'))).toEqual([])
  })
})
