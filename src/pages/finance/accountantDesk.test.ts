import { describe, expect, it } from 'vitest'
import { NAV } from '@/components/layout/nav'
import { accountantDesk, daysOverdue, isOpenInvoice, type InvoiceBalance, type Txn } from './accountantDesk'

const TODAY = '2026-11-17'
const txn = (over: Partial<Txn>): Txn => ({
  id: Math.random().toString(36).slice(2),
  number: 'PV-2026-0001',
  direction: 'expense',
  category: 'materials',
  amount: 100,
  amount_base: 100,
  currency: 'TZS',
  transaction_date: TODAY,
  payee_payer: null,
  description: null,
  project_id: null,
  status: 'approved',
  created_by: 'u1',
  created_at: `${TODAY}T08:00:00Z`,
  ...over,
})
const inv = (over: Partial<InvoiceBalance>): InvoiceBalance => ({ id: Math.random().toString(36).slice(2), project_id: null, due_date: null, invoice_date: '2026-10-01', total: 1000, balance: 1000, status: 'issued', ...over })

describe('accountant desk', () => {
  it('is in the menu for finance users', () => {
    expect(NAV.find((n) => n.to === '/accountant')).toMatchObject({ label: 'Accountant Desk', perm: 'finance.view', group: 'Business' })
  })

  it("adds up this month's approved cash in, cash out and petty cash only", () => {
    const d = accountantDesk({
      today: TODAY,
      receivables: [],
      payables: [],
      txns: [
        txn({ direction: 'income', amount_base: 5000 }),
        txn({ direction: 'expense', amount_base: 1200 }),
        txn({ direction: 'expense', category: 'petty_cash', amount_base: 300 }),
        txn({ direction: 'income', amount_base: 999, transaction_date: '2026-10-31' }),
        txn({ direction: 'income', amount_base: 777, status: 'pending' }),
        txn({ direction: 'expense', amount_base: 888, status: 'void' }),
      ],
    })
    expect(d).toMatchObject({ cashIn: 5000, cashOut: 1500, pettyCash: 300, pendingAmount: 777 })
    expect(d.pending).toHaveLength(1)
    expect(d.recent).toHaveLength(6)
  })

  it('lists pending approvals oldest first', () => {
    const d = accountantDesk({
      today: TODAY,
      receivables: [],
      payables: [],
      txns: [txn({ number: 'B', status: 'pending', created_at: '2026-11-16T10:00:00Z' }), txn({ number: 'A', status: 'pending', created_at: '2026-11-10T10:00:00Z' })],
    })
    expect(d.pending.map((t) => t.number)).toEqual(['A', 'B'])
  })

  it('overdue client invoices: open, past due, oldest first', () => {
    const d = accountantDesk({
      today: TODAY,
      txns: [],
      payables: [],
      receivables: [
        inv({ number: 'late-2', due_date: '2026-11-01', balance: 400 }),
        inv({ number: 'late-1', due_date: '2026-10-01', balance: 600 }),
        inv({ number: 'not-due', due_date: '2026-12-01' }),
        inv({ number: 'paid', due_date: '2026-10-01', balance: 0, status: 'paid' }),
        inv({ number: 'void', due_date: '2026-10-01', status: 'void' }),
        inv({ number: 'draft', due_date: '2026-10-01', status: 'draft' }),
      ],
    })
    expect(d.overdueReceivables.map((i) => i.number)).toEqual(['late-1', 'late-2'])
    expect(d.overdueReceivableAmount).toBe(1000)
    expect(daysOverdue('2026-11-01', TODAY)).toBe(16)
    expect(daysOverdue('2026-11-20', TODAY)).toBe(-3)
    expect(daysOverdue(null, TODAY)).toBeNull()
  })

  it('supplier invoices to pay: overdue, due within 7 days or without a due date', () => {
    const d = accountantDesk({
      today: TODAY,
      txns: [],
      receivables: [],
      payables: [
        inv({ invoice_no: 'in-7-days', due_date: '2026-11-24', balance: 50 }),
        inv({ invoice_no: 'later', due_date: '2026-11-25' }),
        inv({ invoice_no: 'overdue', due_date: '2026-11-01', balance: 70 }),
        inv({ invoice_no: 'no-date', balance: 30 }),
        inv({ invoice_no: 'paid', due_date: '2026-11-01', status: 'paid', balance: 0 }),
      ],
    })
    expect(d.payablesDue.map((i) => i.invoice_no)).toEqual(['overdue', 'in-7-days', 'no-date'])
    expect(d.payablesDueAmount).toBe(150)
    expect(isOpenInvoice({ balance: 10, status: 'partially_paid' })).toBe(true)
  })
})
