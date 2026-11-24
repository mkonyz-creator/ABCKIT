/**
 * Workforce/HR + finance scenarios (ported from legacy-supabase/tests/db/run.mjs).
 * Runs the real engine + hooks on the in-memory store; read confidentiality is checked through the
 * table scopes (Firestore rules themselves are exercised by the emulator suite).
 */
import { describe, expect, it } from 'vitest'
import { createTestDb, ok } from '../testing'

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function setup() {
  const t = createTestDb()
  const U = {
    admin: t.addUser('super_admin'),
    md: t.addUser('managing_director'),
    pm: t.addUser('project_manager'),
    eng: t.addUser('site_engineer'),
    eng2: t.addUser('site_engineer'),
    acc: t.addUser('accountant'),
    acc2: t.addUser('accountant'),
    hr: t.addUser('hr_officer'),
    emp: t.addUser('employee'),
    emp2: t.addUser('employee'),
  }
    const client = ok(await t.as(U.admin).from('clients').insert({ name: 'Ministry of Works' }).select().single())
  const p1 = ok(await t.as(U.admin).from('projects').insert({ name: 'Office Block A', client_id: client.id, project_manager_id: U.pm }).select().single())
  const p2 = ok(await t.as(U.admin).from('projects').insert({ name: 'Warehouse B' }).select().single())
  ok(await t.as(U.admin).from('project_members').insert({ project_id: p1.id, user_id: U.eng }))
  return { t, U, P1: p1.id as string, P2: p2.id as string, CLIENT: client.id as string }
}

async function hrEmployee(ctx: Awaited<ReturnType<typeof setup>>, comp = { pay_basis: 'daily', daily_rate: 25000, overtime_rate: 4000 }) {
  const e = ok(await ctx.t.as(ctx.U.hr).from('employees').insert({ full_name: 'Juma Mason', position: 'Mason' }).select().single())
  ok(await ctx.t.as(ctx.U.hr).from('employee_compensation').insert({ employee_id: e.id, ...comp }))
  return e
}

describe('workforce / HR', () => {
  it('employees are numbered; pay data is confidential to payroll roles', async () => {
    const c = await setup()
    const e = await hrEmployee(c)
    expect(e.employee_no).toMatch(/^EMP-/)
    expect(c.t.raw.all('audit_logs').some((l) => l.table_name === 'employee_compensation')).toBe(true)
    expect(ok(await c.t.as(c.U.eng).from('employees').select('*'))).toHaveLength(1)
    expect(ok(await c.t.as(c.U.eng).from('employee_compensation').select('*'))).toHaveLength(0)
    expect(ok(await c.t.as(c.U.pm).from('employee_compensation').select('*'))).toHaveLength(0)
    expect(ok(await c.t.as(c.U.md).from('employee_compensation').select('*'))).toHaveLength(1) // MD has hr.payroll
    // an unlinked employee sees nobody's record
    expect(ok(await c.t.as(c.U.emp).from('employees').select('*'))).toHaveLength(0)
    // only payroll roles write pay data
    const w = await c.t.as(c.U.pm).from('employee_compensation').update({ daily_rate: 1 }).eq('employee_id', e.id).select()
    expect(ok(w)).toHaveLength(0) // not even visible
    const ins = await c.t.as(c.U.eng).from('employee_compensation').upsert({ employee_id: e.id, daily_rate: 1 })
    expect(ins.error?.code).toBe('42501')
  })

  it('attendance recorded on site feeds payroll generation', async () => {
    const c = await setup()
    const e = await hrEmployee(c)
    for (let d = 1; d <= 5; d++)
      ok(await c.t.as(c.U.eng).from('attendance').insert({ employee_id: e.id, project_id: c.P1, work_date: daysAgo(d), status: 'present', hours_worked: 8, overtime_hours: 2 }))
    // one record per employee and day
    const dup = await c.t.as(c.U.eng).from('attendance').insert({ employee_id: e.id, project_id: c.P1, work_date: daysAgo(1), status: 'absent' })
    expect(dup.error?.code).toBe('23505')
    // the attendance sheet upserts on (employee_id, work_date)
    ok(await c.t.as(c.U.eng).from('attendance').upsert({ employee_id: e.id, project_id: c.P1, work_date: daysAgo(1), status: 'present', hours_worked: 8, overtime_hours: 2 }, { onConflict: 'employee_id,work_date' }))
    expect(c.t.raw.all('attendance')).toHaveLength(5)
    // not on a project the engineer is not assigned to
    const other = await c.t.as(c.U.eng).from('attendance').insert({ employee_id: e.id, project_id: c.P2, work_date: daysAgo(9), status: 'present' })
    expect(other.error?.code).toBe('42501')
    // a site engineer only sees attendance of their projects
    expect(ok(await c.t.as(c.U.eng2).from('attendance').select('*'))).toHaveLength(0)
    expect(ok(await c.t.as(c.U.eng).from('attendance').select('*'))).toHaveLength(5)

    const denied = await c.t.as(c.U.eng).rpc('generate_payroll', { p_start: daysAgo(30), p_end: daysAgo(0) })
    expect(denied.error?.message).toMatch(/Not authorised/)
    expect(ok(await c.t.as(c.U.hr).rpc('generate_payroll', { p_start: daysAgo(30), p_end: daysAgo(0) }))).toBe(1)
    const p = ok(await c.t.as(c.U.hr).from('payroll_records').select('*').eq('employee_id', e.id).single())
    expect(p).toMatchObject({ days_worked: 5, overtime_hours: 10, basic_pay: 125000, overtime_pay: 40000, gross_pay: 165000, net_pay: 165000, status: 'draft' })
    // ON CONFLICT DO NOTHING
    expect(ok(await c.t.as(c.U.hr).rpc('generate_payroll', { p_start: daysAgo(30), p_end: daysAgo(0) }))).toBe(0)
    const dupPay = await c.t.as(c.U.hr).from('payroll_records').insert({ employee_id: e.id, period_start: daysAgo(30), period_end: daysAgo(0), basic_pay: 1 })
    expect(dupPay.error?.code).toBe('23505')
    // net pay follows deductions
    const upd = ok(await c.t.as(c.U.hr).from('payroll_records').update({ deductions: 15000 }).eq('id', p.id).select().single())
    expect(upd.net_pay).toBe(150000)
    // payslips are invisible to non-payroll roles
    expect(ok(await c.t.as(c.U.pm).from('payroll_records').select('*'))).toHaveLength(0)
    expect(ok(await c.t.as(c.U.eng).from('payroll_records').select('*'))).toHaveLength(0)
  })

  it('payroll: monthly / hourly bases, terminated staff skipped, batches of at most p_limit', async () => {
    const c = await setup()
    const mk = async (name: string, comp: Record<string, unknown>, status = 'active') => {
      const e = ok(await c.t.as(c.U.hr).from('employees').insert({ full_name: name, status }).select().single())
      ok(await c.t.as(c.U.hr).from('employee_compensation').insert({ employee_id: e.id, ...comp }))
      return e
    }
    const monthly = await mk('Mary Monthly', { pay_basis: 'monthly', basic_salary: 900000, allowances: 50000 })
    const hourly = await mk('Harry Hourly', { pay_basis: 'hourly', daily_rate: 16000 })
    await mk('Terry Gone', { pay_basis: 'monthly', basic_salary: 1 }, 'terminated')
    ok(await c.t.as(c.U.hr).from('employees').insert({ full_name: 'No Pay Details' }))
    ok(await c.t.as(c.U.hr).from('attendance').insert([
      { employee_id: hourly.id, work_date: daysAgo(2), status: 'half_day', hours_worked: 4 },
      { employee_id: hourly.id, work_date: daysAgo(3), status: 'late', hours_worked: 7 },
      { employee_id: hourly.id, work_date: daysAgo(40), status: 'present', hours_worked: 8 }, // outside the period
    ]))
    const args = { p_start: daysAgo(10), p_end: daysAgo(0), p_limit: 1 }
    expect(ok(await c.t.as(c.U.hr).rpc('generate_payroll', args))).toBe(1)
    expect(ok(await c.t.as(c.U.hr).rpc('generate_payroll', args))).toBe(1)
    expect(ok(await c.t.as(c.U.hr).rpc('generate_payroll', args))).toBe(0)
    const rows = ok(await c.t.as(c.U.hr).from('payroll_records').select('*'))
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.employee_id === monthly.id)).toMatchObject({ basic_pay: 900000, allowances: 50000, net_pay: 950000 })
    expect(rows.find((r) => r.employee_id === hourly.id)).toMatchObject({ days_worked: 1.5, basic_pay: 22000 }) // 16000/8 × 11h
  })

  it('self-service: a linked employee sees own attendance, leave, pay details and only paid payslips', async () => {
    const c = await setup()
    const e = await hrEmployee(c)
    ok(await c.t.as(c.U.eng).from('attendance').insert({ employee_id: e.id, project_id: c.P1, work_date: daysAgo(1), status: 'present', hours_worked: 8 }))
    ok(await c.t.as(c.U.hr).rpc('generate_payroll', { p_start: daysAgo(30), p_end: daysAgo(0) }))
    // link the user account afterwards: existing rows are re-pointed to the employee's profile
    ok(await c.t.as(c.U.hr).from('employees').update({ profile_id: c.U.emp }).eq('id', e.id))
    expect(c.t.raw.all('attendance')[0].employee_profile_id).toBe(c.U.emp)
    expect(c.t.raw.all('payroll_records')[0].employee_profile_id).toBe(c.U.emp)
    expect(c.t.raw.get('employee_compensation', e.id)!.employee_profile_id).toBe(c.U.emp)
    const emp = ok(await c.t.as(c.U.emp).from('employees').select('*').eq('profile_id', c.U.emp).maybeSingle())
    expect(emp?.id).toBe(e.id)
    expect(ok(await c.t.as(c.U.emp).from('attendance').select('work_date,status').eq('employee_id', e.id))).toHaveLength(1)
    expect(ok(await c.t.as(c.U.emp).from('employee_compensation').select('*'))).toHaveLength(1)
    expect(ok(await c.t.as(c.U.emp).from('payroll_records').select('*').eq('employee_id', e.id))).toHaveLength(0) // draft
    ok(await c.t.as(c.U.hr).from('payroll_records').update({ status: 'paid', paid_on: daysAgo(0) }).eq('employee_id', e.id))
    expect(ok(await c.t.as(c.U.emp).from('payroll_records').select('id,net_pay,status').eq('employee_id', e.id))).toHaveLength(1)

    // someone else sees none of it
    for (const tbl of ['employees', 'attendance', 'employee_compensation', 'payroll_records', 'leave_requests'])
      expect(ok(await c.t.as(c.U.emp2).from(tbl).select('*'))).toHaveLength(0)

    // an HR user without payroll/company-wide access cannot re-link (could not re-sync confidential rows)
    ok(await c.t.as(c.U.admin).from('role_permissions').insert({ role_id: 'project_manager', permission_id: 'hr.manage' }))
    const relink = await c.t.as(c.U.pm).from('employees').update({ profile_id: c.U.emp2 }).eq('id', e.id)
    expect(relink.error?.code).toBe('42501')
    // a client-supplied owner is ignored
    ok(await c.t.as(c.U.eng).from('attendance').update({ employee_profile_id: c.U.eng, notes: 'x' }).eq('employee_id', e.id))
    expect(c.t.raw.all('attendance')[0].employee_profile_id).toBe(c.U.emp)
  })

  it('leave: employees request own pending leave; only HR approves; days are computed', async () => {
    const c = await setup()
    const e = await hrEmployee(c)
    const other = ok(await c.t.as(c.U.hr).from('employees').insert({ full_name: 'Someone Else' }).select().single())
    ok(await c.t.as(c.U.hr).from('employees').update({ profile_id: c.U.emp }).eq('id', e.id))
    const early = await c.t.as(c.U.emp).from('leave_requests').insert({ employee_id: e.id, start_date: '2026-12-01', end_date: '2026-12-05', status: 'approved' })
    expect(early.error?.message).toMatch(/must start as pending/)
    const forOther = await c.t.as(c.U.emp).from('leave_requests').insert({ employee_id: other.id, start_date: '2026-12-01', end_date: '2026-12-05' })
    expect(forOther.error?.code).toBe('42501')
    const backwards = await c.t.as(c.U.emp).from('leave_requests').insert({ employee_id: e.id, start_date: '2026-12-05', end_date: '2026-12-01' })
    expect(backwards.error?.code).toBe('23514')
    const l = ok(await c.t.as(c.U.emp).from('leave_requests').insert({ employee_id: e.id, start_date: '2026-12-01', end_date: '2026-12-05' }).select().single())
    expect(l).toMatchObject({ status: 'pending', days: 5, employee_profile_id: c.U.emp })
    const self = await c.t.as(c.U.emp).from('leave_requests').update({ status: 'approved' }).eq('id', l.id)
    expect(self.error?.message).toMatch(/Not authorised to approve leave/)
    ok(await c.t.as(c.U.emp).from('leave_requests').update({ end_date: '2026-12-02' }).eq('id', l.id))
    const approved = ok(await c.t.as(c.U.hr).from('leave_requests').update({ status: 'approved' }).eq('id', l.id).select().single())
    expect(approved).toMatchObject({ status: 'approved', approved_by: c.U.hr, days: 2 })
    expect(approved.approved_at).toBeTruthy()
    // once decided, the employee can no longer change it
    const late = await c.t.as(c.U.emp).from('leave_requests').update({ status: 'cancelled' }).eq('id', l.id)
    expect(late.error?.code).toBe('42501')
    expect(ok(await c.t.as(c.U.emp).from('leave_requests').select('*'))).toHaveLength(1)
  })

  it('assignments are project-scoped', async () => {
    const c = await setup()
    const e = await hrEmployee(c)
    ok(await c.t.as(c.U.hr).from('employee_assignments').insert([{ employee_id: e.id, project_id: c.P1, role: 'Mason' }, { employee_id: e.id, project_id: c.P2 }]))
    expect(ok(await c.t.as(c.U.eng).from('employee_assignments').select('*, employee:employees(full_name)'))).toHaveLength(1)
    const bad = await c.t.as(c.U.hr).from('employee_assignments').insert({ employee_id: e.id, project_id: c.P1, start_date: '2026-05-02', end_date: '2026-05-01' })
    expect(bad.error?.code).toBe('23514')
  })
})

describe('finance', () => {
  async function financeSetup() {
    const c = await setup()
    const sup = ok(await c.t.as(c.U.admin).from('suppliers').insert({ name: 'Twiga Cement Ltd' }).select().single())
    const inv = ok(await c.t.as(c.U.admin).from('supplier_invoices').insert({ supplier_id: sup.id, invoice_no: 'TW-881', amount: 3400000, tax_amount: 0 }).select().single())
    return { ...c, SUP: sup.id as string, INV: inv.id as string }
  }

  it('accountants cannot self-approve (segregation of duties); another accountant can', async () => {
    const c = await financeSetup()
    const t = ok(
      await c.t.as(c.U.acc)
        .from('financial_transactions')
        .insert({ project_id: c.P1, direction: 'expense', category: 'supplier_payment', amount: 3400000, description: 'Cement payment', supplier_id: c.SUP, supplier_invoice_id: c.INV, status: 'approved', created_by: c.U.acc2 })
        .select()
        .single(),
    )
    expect(t.status).toBe('pending') // forced to pending
    expect(t.created_by).toBe(c.U.acc) // creator cannot be spoofed
    expect(t.approved_by).toBeNull()
    expect(t.number).toMatch(/^PV-/)
    expect(t.amount_base).toBe(3400000)
    // approvers were notified
    const notes = c.t.raw.all('notifications').filter((n) => n.type === 'approval' && n.title.includes(t.number))
    expect(notes.map((n) => n.user_id)).toEqual(expect.arrayContaining([c.U.acc2, c.U.md]))
    expect(notes.some((n) => n.user_id === c.U.acc)).toBe(false)
    expect(notes[0].body).toBe('Expense of TZS 3,400,000.00')

    const self = await c.t.as(c.U.acc).from('financial_transactions').update({ status: 'approved' }).eq('id', t.id)
    expect(self.error?.message).toMatch(/Segregation of duties/)
    // a project manager (no finance permissions) cannot approve either
    const pm = await c.t.as(c.U.pm).from('financial_transactions').update({ status: 'approved' }).eq('id', t.id).select()
    expect(pm.error?.code).toBe('42501') // PM of P1 can read it (finance.view) but not decide
    // approving must not change anything else at the same time
    const sneaky = await c.t.as(c.U.acc2).from('financial_transactions').update({ status: 'approved', amount: 1 }).eq('id', t.id)
    expect(sneaky.error?.code).toBe('42501')

    const ap = ok(await c.t.as(c.U.acc2).from('financial_transactions').update({ status: 'approved' }).eq('id', t.id).select().single())
    expect(ap).toMatchObject({ status: 'approved', approved_by: c.U.acc2 })
    expect(c.t.raw.get('supplier_invoices', c.INV)!.status).toBe('paid')
  })

  it('approved transactions cannot be edited or deleted; void requires a reason', async () => {
    const c = await financeSetup()
    const t = ok(
      await c.t
        .as(c.U.acc)
        .from('financial_transactions')
        .insert({ project_id: c.P1, direction: 'expense', category: 'supplier_payment', amount: 3400000, description: 'Cement payment', supplier_invoice_id: c.INV })
        .select()
        .single(),
    )
    ok(await c.t.as(c.U.acc2).from('financial_transactions').update({ status: 'approved' }).eq('id', t.id))
    const edit = await c.t.as(c.U.acc2).from('financial_transactions').update({ amount: 1 }).eq('id', t.id)
    expect(edit.error?.message).toMatch(/cannot be edited/)
    const del = await c.t.as(c.U.admin).from('financial_transactions').delete().eq('id', t.id)
    expect(del.error?.message).toMatch(/cannot be deleted/)
    expect(c.t.raw.get('financial_transactions', t.id)).toBeTruthy()
    const noReason = await c.t.as(c.U.acc2).from('financial_transactions').update({ status: 'void' }).eq('id', t.id)
    expect(noReason.error?.message).toMatch(/reason is required/)
    const extra = await c.t.as(c.U.acc2).from('financial_transactions').update({ status: 'void', void_reason: 'Duplicate', description: 'changed' }).eq('id', t.id)
    expect(extra.error?.message).toMatch(/Only the status and void reason/)
    // a finance.manage user without finance.approve cannot void
    ok(await c.t.as(c.U.admin).from('role_permissions').delete().match({ role_id: 'accountant', permission_id: 'finance.approve' }))
    const noPerm = await c.t.as(c.U.acc).from('financial_transactions').update({ status: 'void', void_reason: 'x' }).eq('id', t.id)
    expect(noPerm.error?.message).toMatch(/Not authorised to void/)
    ok(await c.t.as(c.U.md).from('financial_transactions').update({ status: 'void', void_reason: 'Duplicate entry' }).eq('id', t.id))
    expect(c.t.raw.get('financial_transactions', t.id)).toMatchObject({ status: 'void', void_reason: 'Duplicate entry' })
    expect(c.t.raw.get('supplier_invoices', c.INV)!.status).toBe('unpaid')
    const again = await c.t.as(c.U.md).from('financial_transactions').update({ status: 'pending' }).eq('id', t.id)
    expect(again.error?.message).toMatch(/cannot be edited/)
    // every change is in the audit log
    expect(c.t.raw.all('audit_logs').filter((l) => l.table_name === 'financial_transactions' && l.record_id === t.id).length).toBeGreaterThanOrEqual(3)
  })

  it('pending transactions can be edited; finance is invisible to site engineers', async () => {
    const c = await financeSetup()
    const t = ok(await c.t.as(c.U.acc).from('financial_transactions').insert({ direction: 'income', category: 'client_payment', amount: 100, currency: 'USD', exchange_rate: 2500, description: 'IPC 1' }).select().single())
    expect(t.number).toMatch(/^RCT-/)
    expect(t.amount_base).toBe(250000)
    const e = ok(await c.t.as(c.U.acc).from('financial_transactions').update({ amount: 200, approved_by: c.U.acc }).eq('id', t.id).select().single())
    expect(e.amount_base).toBe(500000)
    expect(e.approved_by).toBeNull() // cannot fake an approval
    const badCat = await c.t.as(c.U.acc).from('financial_transactions').insert({ direction: 'income', category: 'material', amount: 5, description: 'oops' })
    expect(badCat.error?.code).toBe('23514')
    const zero = await c.t.as(c.U.acc).from('financial_transactions').insert({ direction: 'expense', category: 'material', amount: 0, description: 'zero' })
    expect(zero.error?.code).toBe('23514')
    expect(ok(await c.t.as(c.U.eng).from('financial_transactions').select('*'))).toHaveLength(0)
    expect(ok(await c.t.as(c.U.eng).from('client_invoices').select('*'))).toHaveLength(0)
    expect(ok(await c.t.as(c.U.md).from('financial_transactions').select('*'))).toHaveLength(1)
  })

  it('client invoices: numbering, client from project, payment status follows approved receipts', async () => {
    const c = await financeSetup()
    const inv = ok(await c.t.as(c.U.acc).from('client_invoices').insert({ project_id: c.P1, amount: 1000000, tax_amount: 180000, retention: 50000 }).select().single())
    expect(inv.number).toMatch(/^INV-/)
    expect(inv.client_id).toBe(c.CLIENT)
    expect(inv.total).toBe(1130000)
    expect(inv.status).toBe('issued')
    const receipt = (amount: number) =>
      c.t.as(c.U.acc).from('financial_transactions').insert({ project_id: c.P1, direction: 'income', category: 'client_payment', amount, description: 'Receipt', client_invoice_id: inv.id }).select().single()
    const r1 = ok(await receipt(500000))
    expect(c.t.raw.get('client_invoices', inv.id)!.status).toBe('issued') // pending receipts do not count
    // MD approves (finance.approve without finance.manage may move the invoice status)
    ok(await c.t.as(c.U.md).from('financial_transactions').update({ status: 'approved' }).eq('id', r1.id))
    expect(c.t.raw.get('client_invoices', inv.id)!.status).toBe('partially_paid')
    const r2 = ok(await receipt(630000))
    ok(await c.t.as(c.U.md).from('financial_transactions').update({ status: 'approved' }).eq('id', r2.id))
    expect(c.t.raw.get('client_invoices', inv.id)!.status).toBe('paid')
    ok(await c.t.as(c.U.md).from('financial_transactions').update({ status: 'void', void_reason: 'Bounced cheque' }).eq('id', r2.id))
    expect(c.t.raw.get('client_invoices', inv.id)!.status).toBe('partially_paid')
    // MD cannot otherwise edit invoices
    const mdEdit = await c.t.as(c.U.md).from('client_invoices').update({ amount: 1 }).eq('id', inv.id)
    expect(mdEdit.error?.code).toBe('42501')
    // a rejected receipt does not count; rejecting your own is allowed
    const r3 = ok(await receipt(10))
    ok(await c.t.as(c.U.acc).from('financial_transactions').update({ status: 'rejected' }).eq('id', r3.id))
    expect(c.t.raw.get('financial_transactions', r3.id)!.approved_by).toBe(c.U.acc)
  })

  it('senior approvers may record a transaction as already approved', async () => {
    const c = await financeSetup()
    const t = ok(
      await c.t
        .as(c.U.admin)
        .from('financial_transactions')
        .insert({ project_id: c.P1, direction: 'expense', category: 'fuel', amount: 50000, description: 'Diesel', status: 'approved' })
        .select()
        .single(),
    )
    expect(t).toMatchObject({ status: 'approved', approved_by: c.U.admin })
  })
})
