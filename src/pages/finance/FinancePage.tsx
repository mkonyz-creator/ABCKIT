import { format, parseISO } from 'date-fns'
import { ArrowDownLeft, ArrowUpRight, Coins, FileText, Landmark, LineChart as LineIcon, Receipt, Scale, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisProps, ChartCard, ChartTooltip, compactMoney, GRID, SERIES } from '@/components/charts/ChartKit'
import { ResourcePage } from '@/components/crud/ResourcePage'
import { DataTable } from '@/components/data/DataTable'
import { Field, Select } from '@/components/ui/form'
import { Card, PageHeader, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useList, useRpc } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import type { ProjectFinancials } from '@/lib/types'
import { cn, formatMoney, formatNumber, humanize } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { Transactions } from './Transactions'

export function CashFlow({ projectId }: { projectId?: string }) {
  const [months, setMonths] = useState(12)
  const q = useRpc<Array<{ month: string; income: number; expense: number }>>('monthly_finance', { p_months: months, p_project: projectId ?? null })
  const rows = useMemo(() => {
    let running = 0
    return (q.data ?? []).map((r) => {
      const net = Number(r.income) - Number(r.expense)
      running += net
      return { month: format(parseISO(r.month), 'MMM yyyy'), short: format(parseISO(r.month), 'MMM yy'), Inflow: Number(r.income), Outflow: Number(r.expense), net, cumulative: running }
    })
  }, [q.data])
  return (
    <div className="space-y-4">
      <ChartCard
        title="Cash flow"
        description="Approved receipts vs payments per month"
        legend={[
          { label: 'Inflow', color: SERIES[0] },
          { label: 'Outflow', color: SERIES[1] },
        ]}
        loading={q.isLoading}
        empty={!rows.some((r) => r.Inflow || r.Outflow)}
        data={rows}
        tableCols={[
          { key: 'month', label: 'Month' },
          { key: 'Inflow', label: 'Inflow', format: 'money' },
          { key: 'Outflow', label: 'Outflow', format: 'money' },
          { key: 'net', label: 'Net', format: 'money' },
        ]}
        actions={
          <Select className="h-8 w-32 text-xs" value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Period">
            <option value={6}>6 months</option>
            <option value={12}>12 months</option>
            <option value={24}>24 months</option>
          </Select>
        }
      >
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="short" {...axisProps} />
            <YAxis {...axisProps} tickFormatter={compactMoney} width={56} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-2)' }} />
            <Bar dataKey="Inflow" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Bar dataKey="Outflow" fill={SERIES[1]} radius={[4, 4, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <Card>
        <DataTable
          rows={rows}
          loading={q.isLoading}
          rowKey={(r) => r.month}
          exportTitle="Cash flow statement"
          compact
          columns={[
            { key: 'month', header: 'Month', sortable: false },
            { key: 'Inflow', header: 'Cash in', format: 'money', sortable: false },
            { key: 'Outflow', header: 'Cash out', format: 'money', sortable: false },
            { key: 'net', header: 'Net cash flow', format: 'money', sortable: false, cell: (r) => <span className={cn('font-semibold', r.net < 0 ? 'text-danger' : 'text-success')}>{formatMoney(r.net)}</span> },
            { key: 'cumulative', header: 'Cumulative', format: 'money', sortable: false },
          ]}
        />
      </Card>
    </div>
  )
}

export function ProfitAndLoss() {
  const q = useList<ProjectFinancials>('project_financials', { order: { column: 'name' } })
  const breakdown = useList<{ project_id: string; category: string; amount: number }>('project_cost_breakdown')
  const [status, setStatus] = useState('')
  const rows = (q.data ?? []).filter((p) => !p.is_archived && (!status || p.status === status))
  const totals = rows.reduce((t, p) => ({ income: t.income + Number(p.income_received), cost: t.cost + Number(p.actual_cost), contract: t.contract + Number(p.contract_value) }), { income: 0, cost: 0, contract: 0 })
  const cats = useMemo(() => {
    const m = new Map<string, number>()
    const ids = new Set(rows.map((r) => r.project_id))
    for (const b of breakdown.data ?? []) if (ids.has(b.project_id)) m.set(b.category, (m.get(b.category) ?? 0) + Number(b.amount))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [breakdown.data, rows])
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard emphasis label="Revenue received" value={formatMoney(totals.income, undefined, { compact: true })} />
        <StatCard label="Costs incurred" value={formatMoney(totals.cost, undefined, { compact: true })} />
        <StatCard label="Gross profit (cash)" value={formatMoney(totals.income - totals.cost, undefined, { compact: true })} hint={totals.income ? `${formatNumber(((totals.income - totals.cost) / totals.income) * 100, 1)}% margin` : undefined} />
        <StatCard label="Contract value" value={formatMoney(totals.contract, undefined, { compact: true })} />
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
          <Field label="Project status" className="w-48">
            <Select className="h-9" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {['planning', 'active', 'on_hold', 'completed', 'cancelled'].map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <DataTable
          rows={rows}
          loading={q.isLoading}
          error={q.error}
          rowKey={(r) => r.project_id}
          isDemo={(r) => r.is_demo}
          exportTitle="Profit and loss by project"
          initialSort={{ key: 'net_cash', dir: 'desc' }}
          columns={[
            { key: 'name', header: 'Project', value: (r) => `${r.code} ${r.name}`, cell: (r) => <div><p className="font-medium">{r.name}</p><p className="font-mono text-xs text-subtle">{r.code}</p></div> },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { key: 'contract_value', header: 'Contract', format: 'money', hideOnMobile: true },
            { key: 'income_received', header: 'Revenue', format: 'money' },
            { key: 'actual_cost', header: 'Cost', format: 'money' },
            { key: 'net_cash', header: 'Profit / (loss)', format: 'money', cell: (r) => <strong className={Number(r.net_cash) < 0 ? 'text-danger' : 'text-success'}>{formatMoney(r.net_cash)}</strong> },
            { key: 'margin', header: 'Margin', format: 'percent', value: (r) => (Number(r.income_received) ? ((Number(r.income_received) - Number(r.actual_cost)) / Number(r.income_received)) * 100 : null) },
            { key: 'budget_used_pct', header: 'Budget used', format: 'percent', cell: (r) => <span className={Number(r.budget_used_pct) > 100 ? 'font-semibold text-danger' : ''}>{formatNumber(r.budget_used_pct, 1)}%</span> },
            { key: 'outstanding_receivable', header: 'Receivable', format: 'money', hideOnMobile: true },
          ]}
        />
      </Card>
      {cats.length > 0 && (
        <Card className="p-4 sm:p-5">
          <p className="mb-3 text-sm font-semibold">Cost by category</p>
          <ul className="space-y-2">
            {cats.map(([c, v]) => (
              <li key={c} className="text-sm">
                <div className="mb-1 flex justify-between">
                  <span>{humanize(c)}</span>
                  <span className="tabular">
                    {formatMoney(v)} · {formatNumber((v / (totals.cost || 1)) * 100, 1)}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full" style={{ width: `${(v / (cats[0][1] || 1)) * 100}%`, background: SERIES[1] }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

export function ClientInvoices({ projectId }: { projectId?: string }) {
  return (
    <ResourcePage<any>
      config={{
        table: 'client_invoices',
        readFrom: 'client_invoice_balances',
        singular: 'Client invoice',
        plural: 'Client invoices & certificates',
        eq: projectId ? { project_id: projectId } : undefined,
        createDefaults: projectId ? { project_id: projectId } : undefined,
        order: { column: 'invoice_date', ascending: false },
        perms: { create: P.financeManage, edit: P.financeManage },
        canEditRow: (r) => ['draft', 'issued'].includes(r.status) && Number(r.paid) === 0,
        invalidate: ['project_financials'],
        filters: [{ key: 'status', label: 'Status', options: ['draft', 'issued', 'partially_paid', 'paid', 'void'].map((s) => ({ value: s, label: humanize(s) })) }],
        fields: [
          ...(projectId ? [] : [{ name: 'project_id', label: 'Project', type: 'relation' as const, required: true, relation: { table: 'projects', select: 'id,name,code', label: (p: any) => `${p.code} · ${p.name}`, order: 'name' } }]),
          { name: 'invoice_type', label: 'Type', type: 'select', required: true, defaultValue: 'interim_certificate', options: ['advance', 'interim_certificate', 'final_account', 'variation', 'retention_release', 'other'].map((s) => ({ value: s, label: humanize(s) })) },
          { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true, defaultValue: () => new Date().toISOString().slice(0, 10) },
          { name: 'due_date', label: 'Due date', type: 'date' },
          { name: 'amount', label: 'Certified amount (excl. tax)', type: 'money', required: true },
          { name: 'tax_amount', label: 'VAT / tax', type: 'money', defaultValue: 0 },
          { name: 'retention', label: 'Retention withheld', type: 'money', defaultValue: 0 },
          { name: 'currency', label: 'Currency', type: 'currency', defaultValue: 'TZS' },
          { name: 'status', label: 'Status', type: 'select', defaultValue: 'issued', options: [{ value: 'draft', label: 'Draft' }, { value: 'issued', label: 'Issued' }, { value: 'void', label: 'Void' }] },
          { name: 'description', label: 'Description', type: 'textarea' },
        ],
        beforeSave: (v) => {
          const o = { ...v }
          for (const k of ['paid', 'balance', 'total', 'number']) delete o[k]
          return o
        },
        columns: [
          { key: 'number', header: 'Invoice', cell: (r) => <span className="font-mono font-semibold">{r.number}</span> },
          { key: 'invoice_type', header: 'Type', value: (r) => humanize(r.invoice_type), hideOnMobile: true },
          { key: 'invoice_date', header: 'Date', format: 'date' },
          { key: 'total', header: 'Net due', format: 'money' },
          { key: 'paid', header: 'Received', format: 'money' },
          { key: 'balance', header: 'Outstanding', format: 'money', cell: (r) => <strong className={Number(r.balance) > 0 ? 'text-danger' : ''}>{formatMoney(r.balance)}</strong> },
          { key: 'due_date', header: 'Due', format: 'date', hideOnMobile: true },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        ],
        emptyDescription: 'Raise interim payment certificates/invoices to clients; receipts posted against them update the balance.',
      }}
    />
  )
}

function Overview() {
  const fin = useList<ProjectFinancials>('project_financials', { eq: { is_archived: false } })
  const payables = useList<{ balance: number; status: string }>('supplier_invoice_balances', { select: 'balance,status' })
  const pending = useList<{ id: string }>('financial_transactions', { select: 'id', eq: { status: 'pending' }, keyExtra: 'pending' })
  const t = (fin.data ?? []).reduce(
    (a, p) => ({ income: a.income + Number(p.income_received), cost: a.cost + Number(p.actual_cost), rec: a.rec + Number(p.outstanding_receivable), budget: a.budget + Number(p.budget) }),
    { income: 0, cost: 0, rec: 0, budget: 0 },
  )
  const payable = (payables.data ?? []).filter((x) => !['void', 'paid'].includes(x.status)).reduce((s, x) => s + Number(x.balance), 0)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard emphasis label="Income received" value={formatMoney(t.income, undefined, { compact: true })} icon={<ArrowDownLeft />} />
        <StatCard label="Expenditure" value={formatMoney(t.cost, undefined, { compact: true })} icon={<ArrowUpRight />} />
        <StatCard label="Net cash" value={formatMoney(t.income - t.cost, undefined, { compact: true })} icon={<Scale />} />
        <StatCard label="Remaining budget" value={formatMoney(t.budget - t.cost, undefined, { compact: true })} icon={<Wallet />} />
        <StatCard label="Owed by clients" value={formatMoney(t.rec, undefined, { compact: true })} icon={<Receipt />} />
        <StatCard label="Owed to suppliers" value={formatMoney(payable, undefined, { compact: true })} hint={`${pending.data?.length ?? 0} transactions pending approval`} icon={<Landmark />} />
      </div>
      <CashFlow />
    </div>
  )
}

export default function FinancePage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'overview'
  const { settings } = useAuth()
  return (
    <div>
      <PageHeader title="Finance & Payments" description={`Project budgets, receipts, payments, petty cash, invoices, cash flow and profit & loss. Base currency: ${settings?.default_currency ?? 'TZS'}.`} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="overview">
            <LineIcon /> Overview
          </TabsTrigger>
          <TabsTrigger value="transactions">
            <Wallet /> Transactions
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <FileText /> Client invoices
          </TabsTrigger>
          <TabsTrigger value="petty">
            <Coins /> Petty cash
          </TabsTrigger>
          <TabsTrigger value="pnl">
            <Scale /> Profit & loss
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview />
        </TabsContent>
        <TabsContent value="transactions">
          <Transactions />
        </TabsContent>
        <TabsContent value="invoices">
          <ClientInvoices />
        </TabsContent>
        <TabsContent value="petty">
          <Transactions preset={{ direction: 'expense', category: 'petty_cash' }} title="Petty cash" />
        </TabsContent>
        <TabsContent value="pnl">
          <ProfitAndLoss />
        </TabsContent>
      </Tabs>
    </div>
  )
}
