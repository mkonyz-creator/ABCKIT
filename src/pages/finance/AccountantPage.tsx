/**
 * Accountant desk (Mhasibu): the accountant's working day on one page — what waits for their approval, which client
 * invoices are overdue, which supplier invoices fall due, this month's cash in / out and the latest entries.
 * Everything is read from the same finance tables and views as Finance & Payments, under the user's own permissions;
 * approve / reject use the same update as the Transactions screen (the backend stamps the approver and enforces rules).
 */
import { format, parseISO } from 'date-fns'
import { ArrowDownLeft, ArrowUpRight, CalendarClock, Calculator, CheckCircle2, Coins, FileText, HandCoins, Landmark, PieChart, Receipt, Users, Wallet, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/data/DataTable'
import { buttonVariants, Button } from '@/components/ui/button'
import { Card, CardHeader, PageHeader, StatCard, StatusBadge } from '@/components/ui/misc'
import { db, unwrap } from '@/lib/backend'
import { useInvalidate, useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { cn, errorMessage, formatDate, formatMoney, humanize } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { accountantDesk, daysOverdue, type InvoiceBalance, type Txn } from './accountantDesk'

const today = () => format(new Date(), 'yyyy-MM-dd')

export default function AccountantPage() {
  const { can, profile } = useAuth()
  const invalidate = useInvalidate()
  const [busy, setBusy] = useState<string | null>(null)
  const txns = useList<Txn>('financial_transactions', { select: 'id,number,direction,category,amount,amount_base,currency,transaction_date,payee_payer,description,project_id,status,created_by,created_at', order: { column: 'created_at', ascending: false }, limit: 2000, keyExtra: 'accountant' })
  const receivables = useList<InvoiceBalance>('client_invoice_balances')
  const payables = useList<InvoiceBalance>('supplier_invoice_balances', { enabled: can(P.procurementView) || can(P.financeView) })
  const projects = useList<{ id: string; name: string; code: string }>('projects', { select: 'id,name,code' })
  const suppliers = useList<{ id: string; name: string }>('suppliers', { select: 'id,name' })
  const projectName = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, `${p.code} · ${p.name}`])), [projects.data])
  const supplierName = useMemo(() => new Map((suppliers.data ?? []).map((s) => [s.id, s.name])), [suppliers.data])
  const day = today()
  const d = useMemo(
    () => accountantDesk({ txns: txns.data ?? [], receivables: receivables.data ?? [], payables: payables.data ?? [], today: day }),
    [txns.data, receivables.data, payables.data, day],
  )
  const canApprove = can(P.financeApprove)
  const isTop = ['super_admin', 'managing_director'].includes(profile?.role?.key ?? '')

  const decide = async (t: Txn, status: 'approved' | 'rejected') => {
    setBusy(t.id)
    try {
      unwrap(await db.from('financial_transactions').update({ status }).eq('id', t.id))
      toast.success(`${t.number} ${status === 'approved' ? 'approved' : 'rejected'}`)
      await invalidate('financial_transactions', 'project_financials', 'supplier_invoice_balances', 'client_invoice_balances')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const quick = [
    { to: '/finance?tab=transactions', label: 'Record receipt / payment', icon: Wallet, show: can(P.financeManage) },
    { to: '/finance?tab=invoices', label: 'Client invoices', icon: FileText, show: true },
    { to: '/finance?tab=petty', label: 'Petty cash', icon: Coins, show: true },
    { to: '/procurement', label: 'Supplier invoices', icon: Landmark, show: can(P.procurementView) },
    { to: '/workforce?tab=payroll', label: 'Payroll', icon: Users, show: can(P.hrPayroll) },
    { to: '/reports', label: 'Financial reports', icon: PieChart, show: can(P.reportsFinancial) || can(P.reportsView) },
  ].filter((q) => q.show)

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Calculator className="size-6 text-accent-ink" /> Accountant Desk
          </span>
        }
        description={`Mhasibu — approvals, collections, payments due and this month's cash, ${format(parseISO(day), 'EEEE d MMMM yyyy')}.`}
        actions={quick.slice(0, 2).map((q) => (
          <Link key={q.to} to={q.to} className={buttonVariants({ variant: q.to.includes('transactions') ? 'primary' : 'outline', size: 'sm' })}>
            <q.icon className="size-4" /> {q.label}
          </Link>
        ))}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard emphasis label="Cash in (this month)" value={formatMoney(d.cashIn, undefined, { compact: true })} icon={<ArrowDownLeft />} />
        <StatCard label="Cash out (this month)" value={formatMoney(d.cashOut, undefined, { compact: true })} icon={<ArrowUpRight />} />
        <StatCard label="Waiting for approval" value={String(d.pending.length)} hint={formatMoney(d.pendingAmount, undefined, { compact: true })} icon={<HandCoins />} />
        <StatCard label="Overdue from clients" value={formatMoney(d.overdueReceivableAmount, undefined, { compact: true })} hint={`${d.overdueReceivables.length} invoice(s)`} icon={<Receipt />} />
        <StatCard label="Supplier bills due (7 days)" value={formatMoney(d.payablesDueAmount, undefined, { compact: true })} hint={`${d.payablesDue.length} invoice(s)`} icon={<CalendarClock />} />
        <StatCard label="Petty cash (this month)" value={formatMoney(d.pettyCash, undefined, { compact: true })} icon={<Coins />} />
      </div>

      <Card>
        <CardHeader title="Waiting for approval" description="Receipts and payments recorded but not yet approved — oldest first" actions={<Link to="/finance?tab=transactions" className="text-xs font-semibold text-accent-ink hover:underline">All transactions</Link>} />
        <DataTable
          rows={d.pending}
          loading={txns.isLoading}
          error={txns.error}
          rowKey={(t) => t.id}
          compact
          pageSize={8}
          emptyTitle="Nothing waiting"
          emptyDescription="Every recorded receipt and payment has been decided."
          columns={[
            { key: 'number', header: 'No.', cell: (t) => <span className="font-mono font-semibold">{t.number}</span> },
            { key: 'transaction_date', header: 'Date', format: 'date' },
            { key: 'direction', header: 'Type', value: (t) => (t.direction === 'income' ? 'Receipt' : 'Payment'), hideOnMobile: true },
            { key: 'payee_payer', header: 'Payee / payer', value: (t) => t.payee_payer ?? humanize(t.category) },
            { key: 'project_id', header: 'Project', value: (t) => (t.project_id ? projectName.get(t.project_id) ?? '' : 'Company'), hideOnMobile: true },
            { key: 'amount', header: 'Amount', align: 'right', value: (t) => Number(t.amount), cell: (t) => <span className={cn('font-semibold', t.direction === 'income' && 'text-success')}>{formatMoney(t.amount, t.currency)}</span> },
          ]}
          rowActions={
            canApprove
              ? (t) => {
                  const own = t.created_by === profile?.id && !isTop
                  return (
                    <div className="flex gap-1">
                      <Button size="sm" variant="primary" disabled={busy === t.id || own} title={own ? 'Someone else must approve what you recorded' : undefined} onClick={() => void decide(t, 'approved')}>
                        <CheckCircle2 className="size-4" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => void decide(t, 'rejected')}>
                        <XCircle className="size-4" /> Reject
                      </Button>
                    </div>
                  )
                }
              : undefined
          }
        />
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Overdue client invoices" description="Money clients should already have paid — follow these up" actions={<Link to="/finance?tab=invoices" className="text-xs font-semibold text-accent-ink hover:underline">All invoices</Link>} />
          <DataTable
            rows={d.overdueReceivables}
            loading={receivables.isLoading}
            error={receivables.error}
            rowKey={(i) => i.id}
            compact
            pageSize={8}
            emptyTitle="No overdue invoices"
            emptyDescription="All client invoices are paid or not yet due."
            columns={[
              { key: 'number', header: 'Invoice', cell: (i) => <span className="font-mono font-semibold">{i.number}</span> },
              { key: 'project_id', header: 'Project', value: (i) => (i.project_id ? projectName.get(i.project_id) ?? '' : '') },
              { key: 'due_date', header: 'Due', format: 'date', hideOnMobile: true },
              { key: 'late', header: 'Days late', align: 'right', value: (i) => daysOverdue(i.due_date, day) ?? 0, cell: (i) => <span className="font-semibold text-danger">{daysOverdue(i.due_date, day)}</span> },
              { key: 'balance', header: 'Outstanding', align: 'right', format: 'money' },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Supplier invoices to pay" description="Overdue or due within 7 days" actions={can(P.procurementView) ? <Link to="/procurement" className="text-xs font-semibold text-accent-ink hover:underline">Procurement</Link> : undefined} />
          <DataTable
            rows={d.payablesDue}
            loading={payables.isLoading}
            error={payables.error}
            rowKey={(i) => i.id}
            compact
            pageSize={8}
            emptyTitle="Nothing due"
            emptyDescription="No supplier invoice is due in the next 7 days."
            columns={[
              { key: 'invoice_no', header: 'Invoice', cell: (i) => <span className="font-mono font-semibold">{i.invoice_no}</span> },
              { key: 'supplier_id', header: 'Supplier', value: (i) => (i.supplier_id ? supplierName.get(i.supplier_id) ?? '' : '') },
              {
                key: 'due_date',
                header: 'Due',
                value: (i) => i.due_date ?? '',
                cell: (i) => {
                  const late = daysOverdue(i.due_date, day)
                  return <span className={cn(late !== null && late > 0 && 'font-semibold text-danger')}>{i.due_date ? `${formatDate(i.due_date)}${late !== null && late > 0 ? ` (${late}d late)` : ''}` : 'No due date'}</span>
                },
              },
              { key: 'balance', header: 'To pay', align: 'right', format: 'money' },
            ]}
          />
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Latest entries" description="The 10 most recent receipts and payments" />
          <DataTable
            rows={d.recent}
            loading={txns.isLoading}
            rowKey={(t) => t.id}
            compact
            pageSize={10}
            emptyTitle="No transactions yet"
            columns={[
              { key: 'number', header: 'No.', cell: (t) => <span className="font-mono">{t.number}</span> },
              { key: 'transaction_date', header: 'Date', format: 'date' },
              { key: 'payee_payer', header: 'Payee / payer', value: (t) => t.payee_payer ?? humanize(t.category) },
              { key: 'amount', header: 'Amount', align: 'right', value: (t) => Number(t.amount), cell: (t) => <span className={cn(t.direction === 'income' ? 'text-success' : '', ['void', 'rejected'].includes(t.status) && 'text-subtle line-through')}>{t.direction === 'income' ? '+' : '−'}{formatMoney(t.amount, t.currency)}</span> },
              { key: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Quick links" />
          <ul className="divide-y divide-border">
            {quick.map((q) => (
              <li key={q.to}>
                <Link to={q.to} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-surface-2/60 sm:px-5">
                  <q.icon className="size-4 text-subtle" /> {q.label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
