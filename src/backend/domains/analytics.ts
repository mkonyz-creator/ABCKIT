/**
 * Analytics domain — ported from legacy-supabase/migrations/…0600_analytics_storage.sql:
 *   views: client_invoice_balances, supplier_invoice_balances, project_financials, project_cost_breakdown,
 *          material_consumption, supplier_performance, equipment_utilization
 *   rpcs:  dashboard_summary, monthly_finance, workforce_productivity, recent_activity
 *
 * The SQL views were `security_invoker`: every underlying table was filtered by the caller's RLS.
 * Here every read goes through ctx.select (scopes + Firestore rules), and the permission part of each
 * table's old RLS read policy is mirrored explicitly (see `READ`) so a table the caller may not read
 * contributes no rows — exactly what RLS did — without issuing a query the rules would reject anyway.
 */
import type { Filter } from '../filters'
import { defineRpc, defineView, type ReadCtx, type Row } from '../registry'

// ----------------------------------------------------------------------------- helpers

const F = (col: string, op: Extract<Filter, { kind: 'cmp' }>['op'], value: unknown): Filter => ({ kind: 'cmp', col, op, value })
const num = (v: unknown) => Number(v) || 0

/** PostgreSQL round(): half away from zero, tolerant of binary float noise. */
export function roundTo(v: unknown, digits: number) {
  const n = num(v)
  const f = 10 ** digits
  const r = Math.round(Number((Math.abs(n) * f).toPrecision(15))) / f
  return n < 0 ? -r || 0 : r
}
const money = (v: unknown) => roundTo(v, 2)

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 'YYYY-MM-DD' + n days (calendar arithmetic, no time zone drift) */
function addDays(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
/** first day of the month `n` months after the month of `date` */
function addMonths(date: string, n: number) {
  const [y, m] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10)
}
const monthOf = (date: unknown) => (typeof date === 'string' && date.length >= 7 ? `${date.slice(0, 7)}-01` : null)

function sumBy(rows: Row[], key: string, val: string | ((r: Row) => number)) {
  const out = new Map<string, number>()
  for (const r of rows) {
    const k = r[key]
    if (k == null) continue
    const v = typeof val === 'string' ? num(r[val]) : val(r)
    out.set(String(k), (out.get(String(k)) ?? 0) + v)
  }
  return out
}

/** Permission part of each table's old RLS select policy (project access is enforced by the scopes). */
const READ: Record<string, string[]> = {
  projects: ['projects.view'],
  financial_transactions: ['finance.view'],
  client_invoices: ['finance.view'],
  supplier_invoices: ['procurement.view', 'finance.view'],
  boqs: ['boq.view'],
  boq_totals: ['boq.view'],
  materials: ['inventory.view', 'procurement.view', 'site.report'],
  inventory_transactions: ['inventory.view'],
  suppliers: ['procurement.view', 'finance.view'],
  purchase_orders: ['procurement.view', 'finance.view', 'inventory.manage'],
  purchase_order_totals: ['procurement.view', 'finance.view', 'inventory.manage'],
  goods_received: ['procurement.view', 'inventory.view'],
  equipment: ['equipment.view'],
  equipment_usage_logs: ['equipment.view'],
  maintenance_records: ['equipment.view'],
  employees: ['hr.view'],
  attendance: ['hr.view'],
  tasks: ['tasks.view'],
  site_reports: ['site.view'],
  safety_incidents: ['site.view'],
}

function can(ctx: ReadCtx, ...perms: string[]) {
  const me = ctx.me
  return !!me?.active && perms.some((p) => me.can(p))
}
const canRead = (ctx: ReadCtx, table: string) => can(ctx, ...(READ[table] ?? []))

/** Tables whose old RLS policy also required can_access_project(project_id) (projects: its own id). */
const PROJECT_GATED = new Set([
  'financial_transactions', 'client_invoices', 'boqs', 'boq_totals', 'inventory_transactions', 'purchase_orders',
  'goods_received', 'equipment_usage_logs', 'attendance', 'tasks', 'site_reports', 'safety_incidents',
])

/**
 * ctx.select, or no rows when the caller's role may not read the table at all.
 * Project access is re-checked here (the scopes already do this; it keeps the view correct even if a scope is wider).
 */
async function read(ctx: ReadCtx, table: string, filters: Filter[] = [], select?: string): Promise<Row[]> {
  if (!canRead(ctx, table)) return []
  const projectCol = table === 'projects' ? 'id' : PROJECT_GATED.has(table) ? 'project_id' : null
  // the projection must keep the column the access check needs
  const sel = select && projectCol && !select.split(',').map((c) => c.trim()).includes(projectCol) ? `${select},${projectCol}` : select
  const rows = await ctx.select(table, filters, sel ? { select: sel } : {})
  return projectCol ? rows.filter((r) => canAccessProject(ctx, r[projectCol])) : rows
}

/** rows whose `col` is one of `ids` (Firestore `in` queries take at most 30 values) */
async function readIn(ctx: ReadCtx, table: string, col: string, ids: unknown[], extra: Filter[] = []): Promise<Row[]> {
  const uniq = [...new Set(ids.filter((v) => v != null))]
  const chunks: unknown[][] = []
  for (let i = 0; i < uniq.length; i += 30) chunks.push(uniq.slice(i, i + 30))
  const parts = await Promise.all(chunks.map((c) => ctx.select(table, [F(col, 'in', c), ...extra])))
  return parts.flat()
}

function canAccessProject(ctx: ReadCtx, pid: unknown) {
  const me = ctx.me
  if (pid == null || pid === '') return true
  return !!me && (me.viewAll || me.projectIds.includes(String(pid)))
}

const approvedTxns = (ctx: ReadCtx) => read(ctx, 'financial_transactions', [F('status', 'eq', 'approved')])

// ----------------------------------------------------------------------------- invoice balances

async function clientInvoiceBalances(ctx: ReadCtx, txns?: Promise<Row[]>): Promise<Row[]> {
  const [invoices, fts] = await Promise.all([read(ctx, 'client_invoices'), txns ?? approvedTxns(ctx)])
  const paid = sumBy(fts, 'client_invoice_id', 'amount_base')
  return invoices.map((ci) => {
    const p = paid.get(String(ci.id)) ?? 0
    return { ...ci, paid: money(p), balance: money(num(ci.total) - p) }
  })
}

async function supplierInvoiceBalances(ctx: ReadCtx, txns?: Promise<Row[]>): Promise<Row[]> {
  const [invoices, fts] = await Promise.all([read(ctx, 'supplier_invoices'), txns ?? approvedTxns(ctx)])
  const paid = sumBy(fts, 'supplier_invoice_id', 'amount_base')
  return invoices.map((si) => {
    const p = paid.get(String(si.id)) ?? 0
    return { ...si, paid: money(p), balance: money(num(si.total) - p) }
  })
}

defineView('client_invoice_balances', (ctx) => clientInvoiceBalances(ctx))
defineView('supplier_invoice_balances', (ctx) => supplierInvoiceBalances(ctx))

// ----------------------------------------------------------------------------- project financials

async function projectFinancials(ctx: ReadCtx, pre: { projects?: Promise<Row[]>; txns?: Promise<Row[]>; withBoq?: boolean } = {}): Promise<Row[]> {
  const txnsP = pre.txns ?? approvedTxns(ctx)
  const withBoq = pre.withBoq ?? true
  const [projects, txns, invoices, boqs, boqTotals] = await Promise.all([
    pre.projects ?? read(ctx, 'projects'),
    txnsP,
    clientInvoiceBalances(ctx, txnsP),
    withBoq ? read(ctx, 'boqs', [], 'id,project_id,status,updated_at') : Promise.resolve([]),
    withBoq ? read(ctx, 'boq_totals', [], 'boq_id,project_id,grand_total') : Promise.resolve([]),
  ])
  const expense = sumBy(txns.filter((f) => f.direction === 'expense'), 'project_id', 'amount_base')
  const income = sumBy(txns.filter((f) => f.direction === 'income'), 'project_id', 'amount_base')
  const live = invoices.filter((c) => c.status !== 'void')
  const invoiced = sumBy(live, 'project_id', 'total')
  const invPaid = sumBy(live, 'project_id', 'paid')

  // latest non-superseded BOQ per project, an approved one first
  const boqById = new Map(boqs.map((b) => [String(b.id), b]))
  const boqTotal = new Map<string, { approved: boolean; updated: string; total: number }>()
  for (const t of boqTotals) {
    const b = boqById.get(String(t.boq_id))
    if (!b || b.status === 'superseded' || t.project_id == null) continue
    const cand = { approved: b.status === 'approved', updated: String(b.updated_at ?? ''), total: num(t.grand_total) }
    const cur = boqTotal.get(String(t.project_id))
    if (!cur || (cand.approved && !cur.approved) || (cand.approved === cur.approved && cand.updated > cur.updated))
      boqTotal.set(String(t.project_id), cand)
  }

  return projects.map((p) => {
    const id = String(p.id)
    const exp = expense.get(id) ?? 0
    const inc = income.get(id) ?? 0
    const inv = invoiced.get(id) ?? 0
    const budget = num(p.budget)
    return {
      project_id: p.id,
      code: p.code ?? null,
      name: p.name,
      status: p.status,
      progress: p.progress,
      contract_value: p.contract_value,
      budget: p.budget,
      start_date: p.start_date ?? null,
      end_date: p.end_date ?? null,
      is_archived: p.is_archived,
      is_demo: p.is_demo,
      actual_cost: money(exp),
      income_received: money(inc),
      invoiced: money(inv),
      outstanding_receivable: money(inv - (invPaid.get(id) ?? 0)),
      remaining_budget: money(budget - exp),
      budget_used_pct: budget > 0 ? roundTo((exp / budget) * 100, 1) : 0,
      boq_total: money(boqTotal.get(id)?.total ?? 0),
      net_cash: money(inc - exp),
    }
  })
}

defineView('project_financials', (ctx) => projectFinancials(ctx))

defineView('project_cost_breakdown', async (ctx) => {
  const txns = await read(ctx, 'financial_transactions', [F('status', 'eq', 'approved'), F('direction', 'eq', 'expense')])
  const groups = new Map<string, Row>()
  for (const f of txns) {
    const k = JSON.stringify([f.project_id ?? null, f.category ?? null])
    const g = groups.get(k) ?? { project_id: f.project_id ?? null, category: f.category ?? null, amount: 0, txn_count: 0 }
    g.amount += num(f.amount_base)
    g.txn_count++
    groups.set(k, g)
  }
  return [...groups.values()].map((g) => ({ ...g, amount: money(g.amount) }))
})

// ----------------------------------------------------------------------------- inventory / procurement / equipment

defineView('material_consumption', async (ctx) => {
  const txns = (await read(ctx, 'inventory_transactions')).filter((t) => t.project_id != null)
  if (!txns.length) return []
  const materials = canRead(ctx, 'materials') ? await readIn(ctx, 'materials', 'id', txns.map((t) => t.material_id)) : []
  const mat = new Map(materials.map((m) => [String(m.id), m]))
  const groups = new Map<string, Row>()
  for (const t of txns) {
    const m = mat.get(String(t.material_id))
    if (!m) continue // inner join
    const sign = t.txn_type === 'issue' ? 1 : t.txn_type === 'return' ? -1 : 0
    const k = `${t.project_id}|${t.material_id}`
    const g = groups.get(k) ?? { project_id: t.project_id, material_id: t.material_id, material_name: m.name, unit: m.unit, qty_consumed: 0, value_consumed: 0 }
    g.qty_consumed += sign * num(t.quantity)
    g.value_consumed += sign * num(t.quantity) * num(t.unit_price)
    groups.set(k, g)
  }
  return [...groups.values()].map((g) => ({ ...g, qty_consumed: roundTo(g.qty_consumed, 3), value_consumed: money(g.value_consumed) }))
})

defineView('supplier_performance', async (ctx) => {
  const [suppliers, pos, totals, grns, balances] = await Promise.all([
    read(ctx, 'suppliers'),
    read(ctx, 'purchase_orders', [], 'id,supplier_id,status,expected_date'),
    read(ctx, 'purchase_order_totals', [], 'po_id,total'),
    read(ctx, 'goods_received', [], 'po_id,received_date'),
    supplierInvoiceBalances(ctx),
  ])
  if (!suppliers.length) return []
  const total = new Map(totals.map((t) => [String(t.po_id), num(t.total)]))
  const firstReceived = new Map<string, string>()
  for (const g of grns) {
    if (g.po_id == null || g.received_date == null) continue
    const cur = firstReceived.get(String(g.po_id))
    if (!cur || g.received_date < cur) firstReceived.set(String(g.po_id), g.received_date)
  }
  const outstanding = sumBy(balances.filter((b) => b.status !== 'void'), 'supplier_id', 'balance')
  const bySupplier = new Map<string, Row[]>()
  for (const po of pos) if (po.supplier_id != null) bySupplier.set(String(po.supplier_id), [...(bySupplier.get(String(po.supplier_id)) ?? []), po])

  return suppliers.map((s) => {
    const list = bySupplier.get(String(s.id)) ?? []
    const placed = list.filter((po) => po.status !== 'draft' && po.status !== 'cancelled')
    const withGrn = list.filter((po) => po.expected_date != null && firstReceived.has(String(po.id)))
    return {
      supplier_id: s.id,
      name: s.name,
      category: s.category ?? null,
      rating: s.rating ?? null,
      is_active: s.is_active,
      orders: placed.length,
      order_value: money(placed.reduce((a, po) => a + (total.get(String(po.id)) ?? 0), 0)),
      orders_completed: list.filter((po) => po.status === 'received').length,
      on_time_orders: withGrn.filter((po) => firstReceived.get(String(po.id))! <= po.expected_date).length,
      orders_with_due_date: withGrn.length,
      outstanding_balance: money(outstanding.get(String(s.id)) ?? 0),
    }
  })
})

defineView('equipment_utilization', async (ctx) => {
  const since = addDays(localToday(), -30)
  const [equipment, logs, maint] = await Promise.all([
    read(ctx, 'equipment'),
    read(ctx, 'equipment_usage_logs', [F('usage_date', 'gt', since)]),
    read(ctx, 'maintenance_records', [F('status', 'neq', 'cancelled')]),
  ])
  type U = { hours: number; idle: number; fuel: number; fuelCost: number; days: Set<string> }
  const usage = new Map<string, U>()
  for (const l of logs) {
    const k = String(l.equipment_id)
    const u = usage.get(k) ?? { hours: 0, idle: 0, fuel: 0, fuelCost: 0, days: new Set<string>() }
    u.hours += num(l.hours_operated)
    u.idle += num(l.idle_hours)
    u.fuel += num(l.fuel_litres)
    u.fuelCost += num(l.fuel_cost)
    if (l.usage_date) u.days.add(l.usage_date)
    usage.set(k, u)
  }
  type M = { cost: number; downtime: number; breakdowns: number }
  const mt = new Map<string, M>()
  for (const r of maint) {
    const k = String(r.equipment_id)
    const m = mt.get(k) ?? { cost: 0, downtime: 0, breakdowns: 0 }
    m.cost += num(r.cost)
    m.downtime += num(r.downtime_hours)
    if (r.maintenance_type === 'breakdown') m.breakdowns++
    mt.set(k, m)
  }
  return equipment.map((e) => {
    const u = usage.get(String(e.id))
    const m = mt.get(String(e.id))
    const hours = money(u?.hours ?? 0)
    return {
      equipment_id: e.id,
      code: e.code ?? null,
      name: e.name,
      category: e.category ?? null,
      status: e.status,
      ownership: e.ownership ?? null,
      current_project_id: e.current_project_id ?? null,
      hourly_rate: e.hourly_rate ?? null,
      hours_30d: hours,
      idle_hours_30d: money(u?.idle ?? 0),
      fuel_litres_30d: money(u?.fuel ?? 0),
      fuel_cost_30d: money(u?.fuelCost ?? 0),
      days_logged_30d: u?.days.size ?? 0,
      utilization_pct: roundTo((hours / (30 * 8)) * 100, 1),
      maintenance_cost_total: money(m?.cost ?? 0),
      downtime_hours_total: roundTo(m?.downtime ?? 0, 1),
      breakdowns_total: m?.breakdowns ?? 0,
    }
  })
})

// ----------------------------------------------------------------------------- dashboard

const DASH_PROGRESS_STATUSES = ['active', 'on_hold', 'planning']

/** tasks the caller can see: tasks.view (+ project scope) or tasks assigned to them */
async function visibleTasks(ctx: ReadCtx): Promise<Row[]> {
  const me = ctx.me
  if (!me?.active) return []
  if (!canRead(ctx, 'tasks')) return ctx.select('tasks', [F('assigned_to', 'eq', me.uid)])
  const rows = await ctx.select('tasks')
  return rows.filter((t) => t.assigned_to === me.uid || canAccessProject(ctx, t.project_id))
}

const count = (rows: Row[], pred: (r: Row) => boolean) => rows.reduce((n, r) => n + (pred(r) ? 1 : 0), 0)

async function dashboardSummary(ctx: ReadCtx) {
  const today = localToday()
  const uid = ctx.me?.uid
  const isActive = (s: unknown) => s === 'active'
  const projectsP = read(ctx, 'projects')
  const canFinance = can(ctx, 'finance.view')
  const canInventory = can(ctx, 'inventory.view')
  const canHr = can(ctx, 'hr.view')
  const canSite = can(ctx, 'site.view')

  const financeP = (async () => {
    if (!canFinance) return null
    const txnsP = approvedTxns(ctx)
    const [fin, payables, pending] = await Promise.all([
      projectFinancials(ctx, { projects: projectsP, txns: txnsP, withBoq: false }),
      supplierInvoiceBalances(ctx, txnsP),
      read(ctx, 'financial_transactions', [F('status', 'eq', 'pending')], 'id'),
    ])
    const live = fin.filter((p) => !p.is_archived)
    const sum = (rows: Row[], k: string) => money(rows.reduce((a, r) => a + num(r[k]), 0))
    return {
      expenditure: sum(live, 'actual_cost'),
      income: sum(live, 'income_received'),
      remaining_budget: sum(live.filter((p) => p.status !== 'cancelled'), 'remaining_budget'),
      receivable: sum(live, 'outstanding_receivable'),
      payable: sum(payables.filter((b) => b.status !== 'void' && b.status !== 'paid'), 'balance'),
      pending_approvals: pending.length,
    }
  })()

  const inventoryP = (async () => {
    if (!canInventory) return null
    const materials = canRead(ctx, 'materials') ? await ctx.select('materials', [F('is_active', 'eq', true)]) : []
    const low = materials.filter((m) => num(m.min_stock) > 0 && num(m.current_stock) <= num(m.min_stock))
    low.sort((a, b) => num(a.current_stock) / num(a.min_stock) - num(b.current_stock) / num(b.min_stock))
    return {
      low_stock_count: low.length,
      low_stock: low.slice(0, 6).map((m) => ({ id: m.id, name: m.name, unit: m.unit, current_stock: m.current_stock, min_stock: m.min_stock })),
      stock_value: roundTo(
        materials.reduce((a, m) => a + num(m.current_stock) * num(m.unit_price), 0),
        5,
      ),
    }
  })()

  const workforceP = (async () => {
    if (!canHr) return null
    const [employees, attendance] = await Promise.all([
      read(ctx, 'employees', [F('status', 'in', ['active', 'on_leave'])], 'id,status'),
      read(ctx, 'attendance', [F('work_date', 'eq', today)], 'id,status'),
    ])
    return {
      employees: employees.length,
      present_today: count(attendance, (a) => ['present', 'late', 'half_day'].includes(a.status)),
      absent_today: count(attendance, (a) => ['absent', 'sick'].includes(a.status)),
      on_leave: count(employees, (e) => e.status === 'on_leave'),
    }
  })()

  const siteP = (async () => {
    if (!canSite) return null
    const [pending, recent, incidents] = await Promise.all([
      read(ctx, 'site_reports', [F('status', 'eq', 'submitted')], 'id'),
      read(ctx, 'site_reports', [F('report_date', 'gt', addDays(today, -7))], 'id'),
      read(ctx, 'safety_incidents', [F('status', 'neq', 'closed')], 'id'),
    ])
    return { pending_reports: pending.length, reports_7d: recent.length, open_incidents: incidents.length }
  })()

  const [projects, tasks, finance, inventory, workforce, site] = await Promise.all([projectsP, visibleTasks(ctx), financeP, inventoryP, workforceP, siteP])

  const live = projects.filter((p) => !p.is_archived)
  const notCancelled = live.filter((p) => p.status !== 'cancelled')
  const active = live.filter((p) => isActive(p.status))
  const projectName = new Map(projects.map((p) => [String(p.id), p.name]))

  const progress = live
    .filter((p) => DASH_PROGRESS_STATUSES.includes(p.status))
    .sort((a, b) => Number(isActive(b.status)) - Number(isActive(a.status)) || String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    .slice(0, 8)
    .map((p) => ({ id: p.id, code: p.code ?? null, name: p.name, progress: p.progress, status: p.status, end_date: p.end_date ?? null }))

  const taskHorizon = addDays(today, 21)
  const projectHorizon = addDays(today, 45)
  const deadlines = [
    ...tasks
      .filter((t) => t.status !== 'done' && t.due_date != null && t.due_date <= taskHorizon)
      .map((t) => ({
        kind: 'task' as const,
        id: t.id,
        label: t.title,
        due: t.due_date,
        priority: t.priority ?? null,
        project: t.project_id == null ? null : (projectName.get(String(t.project_id)) ?? null),
        status: t.status,
      })),
    ...live
      .filter((p) => DASH_PROGRESS_STATUSES.includes(p.status) && p.end_date != null && p.end_date <= projectHorizon)
      .map((p) => ({ kind: 'project' as const, id: p.id, label: p.name, due: p.end_date, priority: 'high', project: p.code ?? null, status: p.status })),
  ]
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .slice(0, 10)

  const open = tasks.filter((t) => t.status !== 'done')
  return {
    projects: {
      active: active.length,
      completed: count(live, (p) => p.status === 'completed'),
      pending: count(live, (p) => p.status === 'planning' || p.status === 'on_hold'),
      on_hold: count(live, (p) => p.status === 'on_hold'),
      total: live.length,
      contract_value: money(notCancelled.reduce((a, p) => a + num(p.contract_value), 0)),
      budget: money(notCancelled.reduce((a, p) => a + num(p.budget), 0)),
      avg_progress: active.length ? roundTo(active.reduce((a, p) => a + num(p.progress), 0) / active.length, 1) : 0,
    },
    finance,
    inventory,
    workforce,
    progress,
    deadlines,
    tasks: {
      open: open.length,
      overdue: count(open, (t) => t.due_date != null && t.due_date < today),
      mine: count(open, (t) => uid != null && t.assigned_to === uid),
    },
    site,
  }
}

defineRpc('dashboard_summary', async (_args, ctx) => dashboardSummary(ctx))

// ----------------------------------------------------------------------------- time series

function intArg(v: unknown, dflt: number) {
  const n = v === undefined || v === null || v === '' ? dflt : Math.trunc(Number(v))
  return Number.isFinite(n) ? n : dflt
}

defineRpc('monthly_finance', async (args, ctx) => {
  const months = Math.max(intArg(args.p_months, 12), 1)
  const project = args.p_project ?? null
  const current = monthOf(localToday())!
  const list = Array.from({ length: months }, (_, i) => addMonths(current, i - (months - 1)))
  const txns = await read(ctx, 'financial_transactions', [F('status', 'eq', 'approved'), ...(project ? [F('project_id', 'eq', project)] : [])])
  const acc = new Map(list.map((m) => [m, { income: 0, expense: 0 }]))
  for (const f of txns) {
    const a = acc.get(monthOf(f.transaction_date) ?? '')
    if (!a) continue
    if (f.direction === 'income') a.income += num(f.amount_base)
    else if (f.direction === 'expense') a.expense += num(f.amount_base)
  }
  return list.map((month) => ({ month, income: money(acc.get(month)!.income), expense: money(acc.get(month)!.expense) }))
})

/**
 * attendance the caller may read: hr.view within accessible projects, plus their own rows
 * (attendance.employee_profile_id is the employee's profile, denormalised by the people/finance domain)
 */
async function visibleAttendance(ctx: ReadCtx, filters: Filter[]): Promise<Row[]> {
  const me = ctx.me
  if (!me?.active) return []
  if (!canRead(ctx, 'attendance')) return ctx.select('attendance', [F('employee_profile_id', 'eq', me.uid), ...filters])
  const rows = await ctx.select('attendance', filters)
  return rows.filter((a) => a.employee_profile_id === me.uid || canAccessProject(ctx, a.project_id))
}

defineRpc('workforce_productivity', async (args, ctx) => {
  const days = Math.max(intArg(args.p_days, 14), 1)
  const project = args.p_project ?? null
  const today = localToday()
  const list = Array.from({ length: days }, (_, i) => addDays(today, i - (days - 1)))
  const filters: Filter[] = [F('work_date', 'gte', list[0]), F('work_date', 'lte', today)]
  if (project) filters.push(F('project_id', 'eq', project))
  const rows = await visibleAttendance(ctx, filters)
  const acc = new Map(list.map((d) => [d, { present: 0, absent: 0, hours: 0, overtime: 0 }]))
  for (const a of rows) {
    const d = acc.get(a.work_date)
    if (!d) continue
    if (['present', 'late', 'half_day'].includes(a.status)) d.present++
    else if (['absent', 'sick'].includes(a.status)) d.absent++
    d.hours += num(a.hours_worked)
    d.overtime += num(a.overtime_hours)
  }
  return list.map((day) => {
    const d = acc.get(day)!
    return { day, present: d.present, absent: d.absent, hours: money(d.hours), overtime: money(d.overtime) }
  })
})

// ----------------------------------------------------------------------------- recent activity

/** audited tables shown in the feed and the permission(s) needed to see each (confidential tables excluded) */
const ACTIVITY_TABLES: Record<string, string[]> = {
  projects: ['projects.view'],
  clients: ['projects.view'],
  boqs: ['boq.view'],
  site_reports: ['site.view'],
  safety_incidents: ['site.view'],
  materials: ['inventory.view'],
  inventory_transactions: ['inventory.view'],
  purchase_requests: ['procurement.view'],
  purchase_orders: ['procurement.view'],
  goods_received: ['procurement.view'],
  equipment: ['equipment.view'],
  maintenance_records: ['equipment.view'],
  financial_transactions: ['finance.view'],
  client_invoices: ['finance.view'],
  supplier_invoices: ['finance.view', 'procurement.view'],
  documents: ['documents.view'],
  tasks: ['tasks.view'],
  suppliers: ['procurement.view'],
}

const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))

defineRpc('recent_activity', async (args, ctx) => {
  if (!ctx.me?.active) return []
  const limit = Math.min(Math.max(intArg(args.p_limit, 15), 1), 100)
  const project = args.p_project ? String(args.p_project) : null
  const tables = Object.keys(ACTIVITY_TABLES).filter((t) => can(ctx, ...ACTIVITY_TABLES[t]))
  if (!tables.length) return []
  const logs = await ctx.select('audit_logs', [F('table_name', 'in', tables)])
  const picked: Array<{ a: Row; d: Row }> = []
  for (const a of logs) {
    const d: Row = a.new_data ?? a.old_data ?? {}
    if (a.table_name === 'documents' && (d.access_level ?? 'project') !== 'project') continue
    if (!canAccessProject(ctx, a.table_name === 'projects' ? d.id : d.project_id)) continue
    if (project && !(String(d.project_id ?? '') === project || (a.table_name === 'projects' && String(d.id ?? '') === project))) continue
    picked.push({ a, d })
  }
  picked.sort((x, y) => String(y.a.changed_at ?? '').localeCompare(String(x.a.changed_at ?? '')))
  const top = picked.slice(0, limit)
  const actors = await readIn(ctx, 'profiles', 'id', top.map((x) => x.a.changed_by), [])
  const actorName = new Map(actors.map((p) => [String(p.id), p.full_name as string]))
  return top.map(({ a, d }) => ({
    id: a.id,
    table_name: a.table_name,
    action: a.action,
    label: text(d.number) ?? text(d.title) ?? text(d.name) ?? text(d.code) ?? text(d.description) ?? text(d.full_name) ?? '',
    project_id: d.project_id == null || d.project_id === '' ? null : String(d.project_id),
    actor: (a.changed_by && actorName.get(String(a.changed_by))) || 'System',
    changed_at: a.changed_at,
  }))
})
