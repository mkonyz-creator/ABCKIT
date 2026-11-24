/** The accountant desk's lists, computed from finance rows (pure, so it can be tested). */
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns'

export interface Txn {
  id: string
  number: string
  direction: 'income' | 'expense'
  category: string
  amount: number
  amount_base: number
  currency: string
  transaction_date: string
  payee_payer: string | null
  description: string | null
  project_id: string | null
  status: 'pending' | 'approved' | 'rejected' | 'void'
  created_by: string | null
  created_at: string
}
export interface InvoiceBalance {
  id: string
  number?: string
  invoice_no?: string
  project_id: string | null
  supplier_id?: string | null
  due_date: string | null
  invoice_date: string
  total: number
  balance: number
  status: string
}

/** days past due (negative = not yet due) */
export function daysOverdue(due: string | null, today: string): number | null {
  if (!due) return null
  return differenceInCalendarDays(parseISO(today), parseISO(due.slice(0, 10)))
}

/** still to be paid / collected: positive balance and not void, paid or draft */
export const isOpenInvoice = (i: Pick<InvoiceBalance, 'balance' | 'status'>) => Number(i.balance) > 0 && !['void', 'paid', 'draft', 'cancelled'].includes(i.status)

/** the accountant's lists from the raw rows (pure, so it can be tested) */
export function accountantDesk(input: { txns: Txn[]; receivables: InvoiceBalance[]; payables: InvoiceBalance[]; today: string; dueWithinDays?: number }) {
  const { txns, today } = input
  const month = today.slice(0, 7)
  const soon = format(addDays(parseISO(today), input.dueWithinDays ?? 7), 'yyyy-MM-dd')
  const approvedThisMonth = txns.filter((t) => t.status === 'approved' && t.transaction_date?.slice(0, 7) === month)
  const sum = (rows: Txn[]) => rows.reduce((s, t) => s + Number(t.amount_base ?? t.amount ?? 0), 0)
  const pending = txns.filter((t) => t.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const overdueReceivables = input.receivables
    .filter((i) => isOpenInvoice(i) && i.due_date && i.due_date.slice(0, 10) < today)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
  const payablesDue = input.payables
    .filter((i) => isOpenInvoice(i) && (!i.due_date || i.due_date.slice(0, 10) <= soon))
    .sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')))
  return {
    cashIn: sum(approvedThisMonth.filter((t) => t.direction === 'income')),
    cashOut: sum(approvedThisMonth.filter((t) => t.direction === 'expense')),
    pettyCash: sum(approvedThisMonth.filter((t) => t.direction === 'expense' && t.category === 'petty_cash')),
    pending,
    pendingAmount: sum(pending),
    overdueReceivables,
    overdueReceivableAmount: overdueReceivables.reduce((s, i) => s + Number(i.balance), 0),
    payablesDue,
    payablesDueAmount: payablesDue.reduce((s, i) => s + Number(i.balance), 0),
    recent: [...txns].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10),
  }
}

