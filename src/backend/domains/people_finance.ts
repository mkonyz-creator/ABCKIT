/**
 * Workforce/HR + finance domain — ported from legacy-supabase/migrations/…0400_hr_finance_docs_tasks.sql
 * (employees … financial_transactions, generate_payroll) and the matching RLS policies in …0500_roles_rls.sql.
 *
 * Security model (see firebase/rules/40_people_finance.rules):
 *  - "employee sees own records" policies use a denormalised `employee_profile_id` (copied from
 *    employees.profile_id) on employee_compensation / attendance / leave_requests / payroll_records,
 *    so a query `employee_profile_id == uid` is provable by Firestore rules without reading documents.
 *  - Pay data (employee_compensation, payroll_records) is readable only with hr.payroll
 *    (or by the employee themself; payslips only once paid).
 *  - Finance: numbering, segregation of duties, approved = locked (void with reason only), no deletes.
 * The hooks below mirror the rules so the in-memory test harness (no rules) enforces the same behaviour.
 */
import { cmp } from '../filters'
import {
  defineGenerated,
  defineHooks,
  defineInherit,
  defineRpc,
  defineScope,
  enableAudit,
  projectScope,
  round2,
  type Eq,
  type Me,
  type Row,
  type WriteCtx,
} from '../registry'

enableAudit(
  'employees',
  'employee_compensation',
  'employee_assignments',
  'attendance',
  'leave_requests',
  'payroll_records',
  'client_invoices',
  'financial_transactions',
)

// ============================================================================= helpers

const SENIOR_APPROVERS = ['super_admin', 'managing_director']
const isSenior = (me: Me) => me.active && SENIOR_APPROVERS.includes(me.roleKey ?? '')

function check(ctx: WriteCtx, cond: unknown, message: string): void {
  if (!cond) ctx.fail(message, '23514')
}
function deny(ctx: WriteCtx, cond: unknown, message: string): void {
  if (!cond) ctx.fail(message, '42501')
}
const num = (v: unknown) => Number(v ?? 0)
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** true when `row` differs from `old` only in `keys` (plus updated_at) */
function onlyChanged(row: Row, old: Row, keys: string[]): boolean {
  const allowed = new Set([...keys, 'updated_at'])
  const all = new Set([...Object.keys(row), ...Object.keys(old)])
  for (const k of all) {
    if (allowed.has(k)) continue
    if (JSON.stringify(row[k] ?? null) !== JSON.stringify(old[k] ?? null)) return false
  }
  return true
}

/** can the caller write rows of this project (project_id null = company level, open to anyone with the permission) */
function canAccessProject(me: Me, pid: unknown): boolean {
  return pid == null || me.viewAll || me.projectIds.includes(String(pid))
}

function daysBetween(start: unknown, end: unknown): number | null {
  if (!isDate(start) || !isDate(end)) return null
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
}

/** all dates from start to end inclusive ('YYYY-MM-DD') */
function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  const d = new Date(`${start}T00:00:00Z`)
  const stop = Date.parse(`${end}T00:00:00Z`)
  while (d.getTime() <= stop) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

const money = (n: unknown) => num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ============================================================================= read scopes
// Rules (40_people_finance.rules) accept exactly these query shapes.

const own = (me: Me): Eq[] => [{ field: 'employee_profile_id', value: me.uid }]

// employees: directory for hr.view, otherwise only the caller's own employee record
defineScope('employees', (me) => {
  if (!me.active) return []
  return me.can('hr.view') ? 'all' : [[{ field: 'profile_id', value: me.uid }]]
})
// confidential pay details: hr.payroll, or the employee themself
defineScope('employee_compensation', (me) => {
  if (!me.active) return []
  return me.can('hr.payroll') ? 'all' : [own(me)]
})
defineScope('employee_assignments', (me) => (me.active && me.can('hr.view') ? projectScope()(me) : []))
// attendance: hr.view within accessible projects (+ company-level rows), plus the caller's own attendance
defineScope('attendance', (me) => {
  if (!me.active) return []
  if (me.can('hr.view')) {
    const s = projectScope({ nullable: true })(me)
    return s === 'all' ? 'all' : [...s, own(me)]
  }
  return [own(me)]
})
defineScope('leave_requests', (me) => {
  if (!me.active) return []
  return me.can('hr.view') ? 'all' : [own(me)]
})
// payslips: hr.payroll sees all; an employee sees only their own *paid* payslips
defineScope('payroll_records', (me) => {
  if (!me.active) return []
  return me.can('hr.payroll') ? 'all' : [[...own(me), { field: 'status', value: 'paid' }]]
})
defineScope('client_invoices', (me) => (me.active && me.can('finance.view') ? projectScope()(me) : []))
defineScope('financial_transactions', (me) => (me.active && me.can('finance.view') ? projectScope({ nullable: true })(me) : []))

// ============================================================================= denormalised owner (employee_profile_id)

const OWNED = ['employee_compensation', 'attendance', 'leave_requests', 'payroll_records'] as const
for (const t of OWNED) {
  defineInherit(t, { via: 'employee_id', from: 'employees', fields: { employee_profile_id: 'profile_id' } })
  defineHooks(t, {
    // never trust a client-supplied value: re-derive it from the employee (keep the old one if the employee is not readable)
    async beforeUpdate(row, old, ctx) {
      const emp = await ctx.get('employees', String(row.employee_id))
      row.employee_profile_id = emp ? (emp.profile_id ?? null) : (old.employee_profile_id ?? null)
    },
  })
}

/** the engine re-syncing employee_profile_id after employees.profile_id changed (allowed for hr.manage) */
function isOwnerSync(row: Row, old: Row, ctx: WriteCtx) {
  return ctx.me.can('hr.manage') && onlyChanged(row, old, ['employee_profile_id'])
}

/** deterministic document id for tables with a natural unique key (Firestore-level uniqueness, cheap existence check) */
async function naturalId(ctx: WriteCtx, table: string, row: Row, key: string[]) {
  if (key.some((k) => row[k] == null || row[k] === '')) return
  const id = key.map((k) => String(row[k])).join('__')
  const hit = await ctx.get(table, id)
  // a row whose key columns were later edited keeps its old id; then fall back to the random id
  if (!hit || key.every((k) => hit[k] === row[k])) row.id = id
}

// ============================================================================= employees

const DEPARTMENTS = ['Management', 'Site Operations', 'Engineering', 'Quantity Surveying', 'Finance', 'Procurement', 'Stores', 'Human Resources', 'Plant & Equipment', 'Administration']

function validateEmployee(row: Row, ctx: WriteCtx) {
  const name = String(row.full_name ?? '')
  check(ctx, name.length >= 2 && name.length <= 200, 'Full name must be 2–200 characters')
  check(ctx, row.gender == null || ['male', 'female', 'other'].includes(row.gender), 'Invalid gender')
  check(ctx, row.email == null || row.email === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(String(row.email)), 'Invalid email address')
  if (row.email === '') row.email = null
  check(ctx, DEPARTMENTS.includes(row.department), 'Invalid department')
  check(ctx, ['permanent', 'contract', 'casual', 'intern'].includes(row.employment_type), 'Invalid employment type')
  check(ctx, ['active', 'on_leave', 'suspended', 'terminated'].includes(row.status), 'Invalid employee status')
}

defineHooks('employees', {
  async beforeInsert(row, ctx) {
    deny(ctx, ctx.me.can('hr.manage'), 'Not authorised to manage employees')
    validateEmployee(row, ctx)
    if (row.employee_no == null || row.employee_no === '') row.employee_no = await ctx.nextNumber('employee')
  },
  beforeUpdate(row, old, ctx) {
    deny(ctx, ctx.me.can('hr.manage'), 'Not authorised to manage employees')
    validateEmployee(row, ctx)
    if ((row.profile_id ?? null) !== (old.profile_id ?? null)) {
      // the engine re-points employee_profile_id on the employee's attendance, leave, pay details and payslips;
      // it can only find (and the rules only allow re-syncing) rows the caller can read
      deny(
        ctx,
        ctx.me.can('hr.payroll') && ctx.me.can('hr.view') && ctx.me.viewAll,
        'Linking a user account requires company-wide HR and payroll access (hr.view, hr.payroll, projects.view_all)',
      )
    }
  },
  beforeDelete(_old, ctx) {
    deny(ctx, ctx.me.can('hr.manage'), 'Not authorised to manage employees')
    // the delete cascades to pay details / attendance and must see payslips (restrict) — only possible with full visibility
    deny(ctx, ctx.me.can('hr.payroll') && ctx.me.viewAll, 'Deleting an employee requires payroll access and company-wide visibility')
  },
})

// ============================================================================= employee_compensation (confidential)

function validateComp(row: Row, ctx: WriteCtx) {
  check(ctx, ['monthly', 'daily', 'hourly'].includes(row.pay_basis), 'Invalid pay basis')
  for (const k of ['basic_salary', 'daily_rate', 'overtime_rate', 'allowances']) check(ctx, num(row[k]) >= 0, `${k.replace('_', ' ')} cannot be negative`)
}

defineHooks('employee_compensation', {
  beforeInsert(row, ctx) {
    deny(ctx, ctx.me.can('hr.payroll'), 'Not authorised to manage pay details')
    validateComp(row, ctx)
  },
  beforeUpdate(row, old, ctx) {
    if (isOwnerSync(row, old, ctx)) return
    deny(ctx, ctx.me.can('hr.payroll'), 'Not authorised to manage pay details')
    validateComp(row, ctx)
  },
  beforeDelete(_old, ctx) {
    deny(ctx, ctx.me.can('hr.payroll'), 'Not authorised to manage pay details')
  },
})

// ============================================================================= employee_assignments

defineHooks('employee_assignments', {
  beforeInsert(row, ctx) {
    deny(ctx, ctx.me.can('hr.manage') && canAccessProject(ctx.me, row.project_id), 'Not authorised to assign employees to this project')
    check(ctx, row.end_date == null || row.end_date >= row.start_date, 'End date must be on or after the start date')
  },
  beforeUpdate(row, old, ctx) {
    deny(
      ctx,
      ctx.me.can('hr.manage') && canAccessProject(ctx.me, old.project_id) && canAccessProject(ctx.me, row.project_id),
      'Not authorised to assign employees to this project',
    )
    check(ctx, row.end_date == null || row.end_date >= row.start_date, 'End date must be on or after the start date')
  },
  beforeDelete(old, ctx) {
    deny(ctx, ctx.me.can('hr.manage') && canAccessProject(ctx.me, old.project_id), 'Not authorised to remove this assignment')
  },
})

// ============================================================================= attendance

function validateAttendance(row: Row, ctx: WriteCtx) {
  check(ctx, ['present', 'absent', 'late', 'half_day', 'leave', 'sick', 'off'].includes(row.status), 'Invalid attendance status')
  check(ctx, num(row.hours_worked) >= 0 && num(row.hours_worked) <= 24, 'Hours worked must be between 0 and 24')
  check(ctx, num(row.overtime_hours) >= 0 && num(row.overtime_hours) <= 16, 'Overtime must be between 0 and 16 hours')
}

defineHooks('attendance', {
  async beforeInsert(row, ctx) {
    deny(ctx, ctx.me.can('hr.attendance') && canAccessProject(ctx.me, row.project_id), 'Not authorised to record attendance for this project')
    validateAttendance(row, ctx)
    // UNIQUE (employee_id, work_date) enforced by the document id, even for rows the caller cannot read
    await naturalId(ctx, 'attendance', row, ['employee_id', 'work_date'])
  },
  beforeUpdate(row, old, ctx) {
    if (isOwnerSync(row, old, ctx)) return
    deny(
      ctx,
      ctx.me.can('hr.attendance') && canAccessProject(ctx.me, old.project_id) && canAccessProject(ctx.me, row.project_id),
      'Not authorised to record attendance for this project',
    )
    validateAttendance(row, ctx)
  },
  beforeDelete(_old, ctx) {
    deny(ctx, ctx.me.can('hr.manage'), 'Not authorised to delete attendance')
  },
})

// ============================================================================= leave_requests (leave_before)

const LEAVE_TYPES = ['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'unpaid', 'other']

function validateLeave(row: Row, ctx: WriteCtx) {
  check(ctx, LEAVE_TYPES.includes(row.leave_type), 'Invalid leave type')
  check(ctx, ['pending', 'approved', 'rejected', 'cancelled'].includes(row.status), 'Invalid leave status')
  check(ctx, isDate(row.start_date) && isDate(row.end_date) && row.end_date >= row.start_date, 'The end date must be on or after the start date')
}

defineHooks('leave_requests', {
  beforeInsert(row, ctx) {
    const hr = ctx.me.can('hr.manage')
    deny(ctx, hr || (row.employee_profile_id != null && row.employee_profile_id === ctx.me.uid), 'You can only request leave for yourself')
    if (row.status !== 'pending' && !hr) ctx.fail('Leave requests must start as pending', '42501')
    validateLeave(row, ctx)
    if (!hr) {
      row.approved_by = null
      row.approved_at = null
      row.created_by = ctx.me.uid
    }
  },
  beforeUpdate(row, old, ctx) {
    if (isOwnerSync(row, old, ctx)) return
    const hr = ctx.me.can('hr.manage')
    if (['approved', 'rejected'].includes(row.status) && row.status !== old.status) {
      if (!hr) ctx.fail('Not authorised to approve leave', '42501')
      row.approved_by = ctx.me.uid
      row.approved_at = ctx.now
    }
    if (!hr) {
      // the employee may edit or cancel their own request while it is pending
      deny(ctx, old.status === 'pending' && old.employee_profile_id === ctx.me.uid && row.employee_profile_id === ctx.me.uid, 'You can only change your own pending leave requests')
      deny(ctx, ['pending', 'cancelled'].includes(row.status), 'Not authorised to approve leave')
      for (const k of ['approved_by', 'approved_at', 'created_by']) row[k] = old[k]
    }
    validateLeave(row, ctx)
  },
  beforeDelete(_old, ctx) {
    deny(ctx, ctx.me.can('hr.manage'), 'Leave requests cannot be deleted; cancel them instead')
  },
})

// ============================================================================= payroll_records (confidential)

function validatePayroll(row: Row, ctx: WriteCtx) {
  for (const k of ['basic_pay', 'overtime_pay', 'allowances', 'deductions']) check(ctx, num(row[k]) >= 0, `${k.replace('_', ' ')} cannot be negative`)
  check(ctx, isDate(row.period_start) && isDate(row.period_end) && row.period_end >= row.period_start, 'Period end must be on or after the period start')
  check(ctx, ['draft', 'approved', 'paid', 'void'].includes(row.status), 'Invalid payroll status')
}

defineHooks('payroll_records', {
  async beforeInsert(row, ctx) {
    deny(ctx, ctx.me.can('hr.payroll'), 'Not authorised to process payroll')
    validatePayroll(row, ctx)
    await naturalId(ctx, 'payroll_records', row, ['employee_id', 'period_start', 'period_end'])
  },
  beforeUpdate(row, old, ctx) {
    if (isOwnerSync(row, old, ctx)) return
    deny(ctx, ctx.me.can('hr.payroll'), 'Not authorised to process payroll')
    validatePayroll(row, ctx)
  },
  beforeDelete(_old, ctx) {
    deny(ctx, ctx.me.can('hr.payroll'), 'Not authorised to process payroll')
  },
})

/** Max new payslips per call: 2 writes each (record + audit log) stays under Firestore's 500 writes per transaction. */
export const PAYROLL_BATCH = 200

/**
 * generate_payroll(p_start, p_end[, p_limit]) → number of draft payslips created.
 * Same maths as the SQL function; existing payslips for the period are skipped (ON CONFLICT DO NOTHING).
 * Creates at most p_limit (≤ 200) payslips per call; call again until it returns less than the limit.
 */
defineRpc('generate_payroll', async (args, ctx) => {
  if (!ctx.me.can('hr.payroll')) ctx.fail('Not authorised to run payroll', '42501')
  const start = String(args.p_start ?? '').slice(0, 10)
  const end = String(args.p_end ?? '').slice(0, 10)
  if (!isDate(start) || !isDate(end)) ctx.fail('Period start and end dates are required', '22007')
  if (end < start) ctx.fail('Period end must be on or after the period start', '23514')
  const limit = Math.max(1, Math.min(PAYROLL_BATCH, Math.trunc(Number(args.p_limit ?? PAYROLL_BATCH)) || PAYROLL_BATCH))

  const [employees, comps, existing] = await Promise.all([
    ctx.select('employees', [cmp('status', 'in', ['active', 'on_leave'])]),
    ctx.select('employee_compensation'),
    ctx.select('payroll_records', [cmp('period_start', 'eq', start), cmp('period_end', 'eq', end)]),
  ])
  const compBy = new Map(comps.map((c) => [String(c.employee_id), c]))
  const done = new Set(existing.map((p) => String(p.employee_id)))
  const todo = employees
    .filter((e) => compBy.has(String(e.id)) && !done.has(String(e.id)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, limit)
  if (!todo.length) return 0

  // attendance of the period: equality pushdown on work_date (≤ 30 values per query) instead of scanning the collection
  const dates = dateRange(start, end)
  const attendance: Row[] = []
  if (dates.length <= 400) {
    for (let i = 0; i < dates.length; i += 30) attendance.push(...(await ctx.select('attendance', [cmp('work_date', 'in', dates.slice(i, i + 30))])))
  } else {
    attendance.push(...(await ctx.select('attendance', [cmp('work_date', 'gte', start), cmp('work_date', 'lte', end)])))
  }
  const agg = new Map<string, { days: number; ot: number; hours: number }>()
  for (const a of attendance) {
    const k = String(a.employee_id)
    const s = agg.get(k) ?? { days: 0, ot: 0, hours: 0 }
    s.days += a.status === 'half_day' ? 0.5 : a.status === 'present' || a.status === 'late' ? 1 : 0
    s.ot += num(a.overtime_hours)
    s.hours += num(a.hours_worked)
    agg.set(k, s)
  }

  let n = 0
  for (const e of todo) {
    const c = compBy.get(String(e.id))!
    const a = agg.get(String(e.id)) ?? { days: 0, ot: 0, hours: 0 }
    const basic =
      c.pay_basis === 'monthly' ? num(c.basic_salary) : c.pay_basis === 'daily' ? round2(num(c.daily_rate) * a.days) : round2((num(c.daily_rate) / 8) * a.hours)
    const id = `${e.id}__${start}__${end}`
    if (await ctx.get('payroll_records', id)) continue
    await ctx.insert('payroll_records', {
      employee_id: e.id,
      period_start: start,
      period_end: end,
      days_worked: Math.round(a.days * 10) / 10,
      overtime_hours: round2(a.ot),
      basic_pay: basic,
      overtime_pay: round2(num(c.overtime_rate) * a.ot),
      allowances: num(c.allowances),
    })
    n++
  }
  return n
})

// ============================================================================= client_invoices

const INVOICE_TYPES = ['advance', 'interim_certificate', 'final_account', 'variation', 'retention_release', 'other']

function validateClientInvoice(row: Row, ctx: WriteCtx) {
  check(ctx, num(row.amount) >= 0 && num(row.tax_amount) >= 0 && num(row.retention) >= 0, 'Amounts cannot be negative')
  check(ctx, INVOICE_TYPES.includes(row.invoice_type), 'Invalid invoice type')
  check(ctx, ['draft', 'issued', 'partially_paid', 'paid', 'void'].includes(row.status), 'Invalid invoice status')
}

defineHooks('client_invoices', {
  async beforeInsert(row, ctx) {
    deny(ctx, ctx.me.can('finance.manage'), 'Not authorised to raise client invoices')
    validateClientInvoice(row, ctx)
    if (row.number == null || row.number === '') row.number = await ctx.nextNumber('client_invoice')
    if (row.client_id == null && row.project_id != null) row.client_id = (await ctx.get('projects', String(row.project_id)))?.client_id ?? null
  },
  beforeUpdate(row, old, ctx) {
    // approvers (without finance.manage) may only move the payment status (fin_after)
    deny(ctx, ctx.me.can('finance.manage') || (ctx.me.can('finance.approve') && onlyChanged(row, old, ['status'])), 'Not authorised to edit client invoices')
    validateClientInvoice(row, ctx)
  },
  beforeDelete(_old, ctx) {
    deny(ctx, ctx.me.can('finance.manage'), 'Not authorised to delete client invoices')
  },
})

// ============================================================================= financial_transactions

const INCOME = ['client_payment', 'advance_payment', 'other_income']
const EXPENSE = ['material', 'labour', 'equipment', 'fuel', 'subcontractor', 'supplier_payment', 'petty_cash', 'transport', 'permits_fees', 'utilities', 'overhead', 'salaries', 'other_expense']
const METHODS = ['cash', 'bank_transfer', 'cheque', 'mobile_money', 'card', 'other']

function validateTxn(row: Row, ctx: WriteCtx) {
  check(ctx, row.direction === 'income' || row.direction === 'expense', 'Direction must be income or expense')
  check(ctx, (row.direction === 'income' ? INCOME : EXPENSE).includes(row.category), `Category ${row.category} is not valid for ${row.direction}`)
  check(ctx, num(row.amount) > 0, 'Amount must be greater than zero')
  check(ctx, /^[A-Z]{3}$/.test(String(row.currency ?? '')), 'Currency must be a 3-letter code')
  check(ctx, num(row.exchange_rate) > 0, 'Exchange rate must be greater than zero')
  const d = String(row.description ?? '')
  check(ctx, d.length >= 2 && d.length <= 1000, 'Description must be 2–1000 characters')
  check(ctx, METHODS.includes(row.payment_method), 'Invalid payment method')
  check(ctx, ['pending', 'approved', 'rejected', 'void'].includes(row.status), 'Invalid transaction status')
}

defineHooks('financial_transactions', {
  async beforeInsert(row, ctx) {
    deny(ctx, ctx.me.can('finance.manage') && canAccessProject(ctx.me, row.project_id), 'Not authorised to record transactions for this project')
    validateTxn(row, ctx)
    row.created_by = ctx.me.uid // the creator is what segregation of duties is checked against: never client-supplied
    if (row.number == null || row.number === '') row.number = await ctx.nextNumber(row.direction === 'income' ? 'receipt' : 'payment_voucher')
    // only senior approvers may record a transaction as already decided (segregation of duties)
    if (row.status !== 'pending' && !isSenior(ctx.me)) row.status = 'pending'
    if (row.status === 'approved' || row.status === 'rejected') {
      row.approved_by = ctx.me.uid
      row.approved_at = ctx.now
    } else {
      row.approved_by = null
      row.approved_at = null
    }
  },
  beforeUpdate(row, old, ctx) {
    deny(ctx, ctx.me.can('finance.manage') || ctx.me.can('finance.approve'), 'Not authorised to change transactions')
    for (const k of ['number', 'created_by', 'created_at']) row[k] = old[k]

    if (old.status === 'approved' || old.status === 'void') {
      // approved transactions may only be voided (with a reason), never edited
      if (row.status === 'void' && old.status === 'approved') {
        if (!ctx.me.can('finance.approve')) ctx.fail('Not authorised to void transactions', '42501')
        if (String(row.void_reason ?? '').trim() === '') ctx.fail('A reason is required to void a transaction')
        if (!onlyChanged(row, old, ['status', 'void_reason', 'amount_base'])) ctx.fail('Only the status and void reason can change when voiding', '42501')
        return
      }
      ctx.fail('Approved or void transactions cannot be edited', '42501')
    }

    if ((row.status === 'approved' || row.status === 'rejected') && row.status !== old.status) {
      if (!ctx.me.can('finance.approve')) ctx.fail('Not authorised to approve transactions', '42501')
      if (row.status === 'approved' && old.created_by === ctx.me.uid && !isSenior(ctx.me))
        ctx.fail('Segregation of duties: you cannot approve your own transaction', '42501')
      if (!onlyChanged(row, old, ['status', 'approved_by', 'approved_at', 'amount_base']))
        ctx.fail('Approve or reject the transaction as recorded; edit it first, then decide', '42501')
      row.approved_by = ctx.me.uid
      row.approved_at = ctx.now
      return
    }

    // plain edit of a pending / rejected transaction (or re-submit / void a pending one)
    deny(ctx, canAccessProject(ctx.me, row.project_id), 'Not authorised to record transactions for this project')
    row.approved_by = old.approved_by ?? null
    row.approved_at = old.approved_at ?? null
    validateTxn(row, ctx)
  },
  beforeDelete(_old, ctx) {
    ctx.fail('financial_transactions records cannot be deleted; void them instead', '42501')
  },
  async afterInsert(row, ctx) {
    await syncInvoices(row, ctx)
    if (row.status === 'pending' && (await ctx.notificationEnabled('approvals'))) {
      const dir = row.direction === 'income' ? 'Income' : 'Expense'
      await ctx.notifyPermission(
        'finance.approve',
        `Transaction ${row.number} awaiting approval`,
        `${dir} of ${row.currency} ${money(row.amount)}`,
        'approval',
        '/finance?tab=transactions',
      )
    }
  },
  async afterUpdate(row, _old, ctx) {
    await syncInvoices(row, ctx)
  },
})

/** fin_after: keep supplier / client invoice payment status in line with approved payments */
async function approvedPaid(ctx: WriteCtx, col: 'supplier_invoice_id' | 'client_invoice_id', invoiceId: string, row: Row) {
  const others = await ctx.select('financial_transactions', [cmp(col, 'eq', invoiceId), cmp('status', 'eq', 'approved')])
  // the store does not contain this transaction's new state yet: use the row being written instead
  let paid = others.filter((t) => t.id !== row.id).reduce((s, t) => s + num(t.amount_base), 0)
  if (row.status === 'approved') paid += num(row.amount_base)
  return round2(paid)
}

async function syncInvoices(row: Row, ctx: WriteCtx) {
  if (row.supplier_invoice_id != null) {
    const si = await ctx.get('supplier_invoices', String(row.supplier_invoice_id))
    if (si && !['void', 'disputed'].includes(si.status)) {
      const paid = await approvedPaid(ctx, 'supplier_invoice_id', String(si.id), row)
      const tot = round2(si.total ?? num(si.amount) + num(si.tax_amount))
      const status = paid >= tot ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid'
      if (status !== si.status) await ctx.update('supplier_invoices', String(si.id), { status })
    }
  }
  if (row.client_invoice_id != null) {
    const ci = await ctx.get('client_invoices', String(row.client_invoice_id))
    if (ci && !['void', 'draft'].includes(ci.status)) {
      const paid = await approvedPaid(ctx, 'client_invoice_id', String(ci.id), row)
      const tot = round2(ci.total)
      const status = paid >= tot ? 'paid' : paid > 0 ? 'partially_paid' : 'issued'
      if (status !== ci.status) await ctx.update('client_invoices', String(ci.id), { status })
    }
  }
}

// ============================================================================= generated columns

defineGenerated('leave_requests', { days: (r) => daysBetween(r.start_date, r.end_date) })
defineGenerated('payroll_records', {
  gross_pay: (r) => round2(num(r.basic_pay) + num(r.overtime_pay) + num(r.allowances)),
  net_pay: (r) => round2(num(r.basic_pay) + num(r.overtime_pay) + num(r.allowances) - num(r.deductions)),
})
defineGenerated('client_invoices', { total: (r) => round2(num(r.amount) + num(r.tax_amount) - num(r.retention)) })
defineGenerated('financial_transactions', { amount_base: (r) => round2(num(r.amount) * num(r.exchange_rate)) })
