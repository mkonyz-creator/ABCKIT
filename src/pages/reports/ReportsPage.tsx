import { differenceInCalendarDays, parseISO } from 'date-fns'
import { BarChart3, BookOpenCheck, Boxes, CalendarCheck, Coins, FolderKanban, Gauge, LineChart, Scale, ShoppingCart, TrendingUp, Users, type LucideIcon } from 'lucide-react'
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable } from '@/components/data/DataTable'
import { Card, PageHeader, Progress, StatusBadge } from '@/components/ui/misc'
import { variance } from '@/lib/calc'
import { useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import type { Material, ProjectFinancials } from '@/lib/types'
import { cn, formatMoney, formatNumber } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { Utilization } from '../equipment/EquipmentPage'
import { CashFlow, ProfitAndLoss } from '../finance/FinancePage'
import { Transactions } from '../finance/Transactions'
import { MaterialConsumption } from '../inventory/InventoryPage'
import { PurchaseOrders } from '../procurement/PurchaseDocs'
import { EmployeePerformance } from '../workforce/Attendance'

interface ReportDef {
  key: string
  title: string
  description: string
  icon: LucideIcon
  perm: string
  render: () => React.ReactNode
}

function ProjectProgressReport() {
  const q = useList<any>('projects', { select: 'id,code,name,status,progress,start_date,end_date,location,is_archived,is_demo,client:clients(name),manager:profiles!projects_project_manager_id_fkey(full_name)', eq: { is_archived: false }, order: { column: 'name' } })
  const rows = useMemo(
    () =>
      (q.data ?? []).map((p) => {
        let elapsed: number | null = null
        if (p.start_date && p.end_date) {
          const total = Math.max(1, differenceInCalendarDays(parseISO(p.end_date), parseISO(p.start_date)))
          elapsed = Math.min(100, Math.max(0, (differenceInCalendarDays(new Date(), parseISO(p.start_date)) / total) * 100))
        }
        const days_left = p.end_date ? differenceInCalendarDays(parseISO(p.end_date), new Date()) : null
        return { ...p, elapsed, days_left, schedule_variance: elapsed === null ? null : Number(p.progress) - elapsed }
      }),
    [q.data],
  )
  return (
    <Card>
      <DataTable
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.id}
        isDemo={(r) => r.is_demo}
        exportTitle="Project progress report"
        exportSubtitle="Schedule variance = physical progress − share of contract time elapsed"
        columns={[
          { key: 'name', header: 'Project', value: (r) => `${r.code} ${r.name}` },
          { key: 'client', header: 'Client', value: (r) => r.client?.name ?? null, hideOnMobile: true },
          { key: 'manager', header: 'PM', value: (r) => r.manager?.full_name ?? null, hideOnMobile: true },
          { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'start_date', header: 'Start', format: 'date', hideOnMobile: true },
          { key: 'end_date', header: 'Completion', format: 'date' },
          { key: 'progress', header: 'Progress', format: 'percent', cell: (r) => <div className="ml-auto flex w-28 items-center gap-2"><Progress value={r.progress} /><span className="w-9 text-right text-xs tabular">{Math.round(r.progress)}%</span></div> },
          { key: 'elapsed', header: 'Time elapsed', format: 'percent' },
          { key: 'schedule_variance', header: 'Schedule var.', format: 'percent', cell: (r) => (r.schedule_variance === null ? '—' : <span className={cn('font-semibold', r.schedule_variance < -10 ? 'text-danger' : r.schedule_variance < 0 ? 'text-warning' : 'text-success')}>{r.schedule_variance > 0 ? '+' : ''}{formatNumber(r.schedule_variance, 1)}%</span>) },
          { key: 'days_left', header: 'Days left', format: 'number' },
        ]}
      />
    </Card>
  )
}

function CostVarianceReport({ mode }: { mode: 'cost' | 'variance' }) {
  const q = useList<ProjectFinancials>('project_financials', { eq: { is_archived: false }, order: { column: 'name' } })
  const rows = useMemo(() => (q.data ?? []).map((p) => ({ ...p, ...variance(Number(p.budget), Number(p.actual_cost)), boq_variance: Number(p.boq_total) - Number(p.actual_cost) })), [q.data])
  return (
    <Card>
      <DataTable
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.project_id}
        isDemo={(r) => r.is_demo}
        exportTitle={mode === 'cost' ? 'Project cost report' : 'Budget variance report'}
        exportSubtitle="Approved expenditure only. Variance = Budget − Actual (negative = over budget)"
        initialSort={{ key: 'variance', dir: 'asc' }}
        columns={[
          { key: 'name', header: 'Project', value: (r) => `${r.code} ${r.name}` },
          { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
          ...(mode === 'cost'
            ? [
                { key: 'contract_value', header: 'Contract value', format: 'money' as const },
                { key: 'boq_total', header: 'BOQ estimate', format: 'money' as const },
                { key: 'actual_cost', header: 'Actual cost', format: 'money' as const },
                { key: 'income_received', header: 'Received', format: 'money' as const },
                { key: 'outstanding_receivable', header: 'Receivable', format: 'money' as const },
              ]
            : [
                { key: 'budget', header: 'Budget', format: 'money' as const },
                { key: 'actual_cost', header: 'Actual', format: 'money' as const },
                { key: 'variance', header: 'Variance', format: 'money' as const, cell: (r: any) => <strong className={r.overBudget ? 'text-danger' : 'text-success'}>{formatMoney(r.variance)}</strong> },
                { key: 'percent', header: 'Var. %', format: 'percent' as const },
                { key: 'budget_used_pct', header: 'Budget used', format: 'percent' as const },
                { key: 'progress', header: 'Progress', format: 'percent' as const },
                { key: 'boq_variance', header: 'BOQ − actual', format: 'money' as const },
              ]),
        ]}
      />
    </Card>
  )
}

function BoqReport() {
  const boqs = useList<any>('boqs', { select: 'id,number,title,status,currency,updated_at,is_demo,project:projects(name,code)', order: { column: 'updated_at', ascending: false } })
  const totals = useList<any>('boq_totals')
  const rows = useMemo(() => {
    const t = new Map((totals.data ?? []).map((x: any) => [x.boq_id, x]))
    return (boqs.data ?? []).map((b) => ({ ...b, ...(t.get(b.id) ?? {}) }))
  }, [boqs.data, totals.data])
  return (
    <Card>
      <DataTable
        rows={rows}
        loading={boqs.isLoading}
        error={boqs.error}
        rowKey={(r) => r.id}
        isDemo={(r) => r.is_demo}
        exportTitle="BOQ summary report"
        columns={[
          { key: 'number', header: 'BOQ no.' },
          { key: 'title', header: 'Title' },
          { key: 'project', header: 'Project', value: (r) => r.project?.name ?? null },
          { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'item_count', header: 'Items', format: 'number' },
          { key: 'subtotal', header: 'Subtotal', format: 'money' },
          { key: 'tax_amount', header: 'Taxes', format: 'money' },
          { key: 'grand_total', header: 'Grand total', format: 'money' },
        ]}
      />
    </Card>
  )
}

function InventoryReport() {
  const q = useList<Material>('materials', { select: '*, category:material_categories(name)', eq: { is_active: true }, order: { column: 'name' } })
  const total = (q.data ?? []).reduce((s, m) => s + Number(m.current_stock) * Number(m.unit_price), 0)
  return (
    <Card>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.id}
        isDemo={(r) => r.is_demo}
        exportTitle="Inventory valuation report"
        exportSubtitle={`Total stock value ${formatMoney(total)}`}
        filters={[{ key: 'low', label: 'Stock level', options: [{ value: 'low', label: 'At / below minimum' }], predicate: (m) => m.min_stock > 0 && m.current_stock <= m.min_stock }]}
        columns={[
          { key: 'code', header: 'Code' },
          { key: 'name', header: 'Material' },
          { key: 'category', header: 'Category', value: (m) => m.category?.name ?? null },
          { key: 'unit', header: 'Unit' },
          { key: 'current_stock', header: 'In stock', format: 'number' },
          { key: 'min_stock', header: 'Minimum', format: 'number' },
          { key: 'unit_price', header: 'Unit price', format: 'money' },
          { key: 'value', header: 'Value', format: 'money', value: (m) => Number(m.current_stock) * Number(m.unit_price) },
          { key: 'flag', header: 'Alert', value: (m) => (m.current_stock <= 0 ? 'OUT' : m.min_stock > 0 && m.current_stock <= m.min_stock ? 'LOW' : ''), cell: (m) => (m.current_stock <= 0 ? <StatusBadge status="critical" /> : m.min_stock > 0 && m.current_stock <= m.min_stock ? <StatusBadge status="high" /> : null) },
        ]}
      />
      <div className="mt-2 px-4 pb-4"><MaterialConsumption /></div>
    </Card>
  )
}

function WorkforceReport() {
  const q = useList<any>('employees', { select: 'id,department,position,employment_type,status', order: { column: 'department' } })
  const rows = useMemo(() => {
    const m = new Map<string, any>()
    for (const e of q.data ?? []) {
      const r = m.get(e.department) ?? { department: e.department, total: 0, active: 0, on_leave: 0, permanent: 0, contract: 0, casual: 0 }
      r.total++
      if (e.status === 'active') r.active++
      if (e.status === 'on_leave') r.on_leave++
      if (e.employment_type in r) r[e.employment_type]++
      m.set(e.department, r)
    }
    return [...m.values()]
  }, [q.data])
  return (
    <div className="space-y-4">
      <Card>
        <DataTable
          rows={rows}
          loading={q.isLoading}
          error={q.error}
          rowKey={(r) => r.department}
          exportTitle="Workforce summary by department"
          columns={[
            { key: 'department', header: 'Department' },
            { key: 'total', header: 'Headcount', format: 'number' },
            { key: 'active', header: 'Active', format: 'number' },
            { key: 'on_leave', header: 'On leave', format: 'number' },
            { key: 'permanent', header: 'Permanent', format: 'number' },
            { key: 'contract', header: 'Contract', format: 'number' },
            { key: 'casual', header: 'Casual', format: 'number' },
          ]}
        />
      </Card>
    </div>
  )
}

export default function ReportsPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()

  const reports: ReportDef[] = [
    { key: 'progress', title: 'Project progress', description: 'Progress vs. time elapsed, days remaining', icon: FolderKanban, perm: P.reportsView, render: () => <ProjectProgressReport /> },
    { key: 'cost', title: 'Project cost', description: 'Contract, BOQ, actual cost, receipts', icon: Coins, perm: P.reportsFinancial, render: () => <CostVarianceReport mode="cost" /> },
    { key: 'variance', title: 'Budget variance', description: 'Budget vs actual per project', icon: Scale, perm: P.reportsFinancial, render: () => <CostVarianceReport mode="variance" /> },
    { key: 'boq', title: 'BOQ summary', description: 'All BOQs with totals and status', icon: BookOpenCheck, perm: P.reportsView, render: () => <BoqReport /> },
    { key: 'inventory', title: 'Inventory', description: 'Stock valuation, alerts and consumption', icon: Boxes, perm: P.reportsView, render: () => <InventoryReport /> },
    { key: 'procurement', title: 'Procurement', description: 'Purchase orders and delivery status', icon: ShoppingCart, perm: P.reportsView, render: () => <PurchaseOrders /> },
    { key: 'workforce', title: 'Workforce', description: 'Headcount by department & type', icon: Users, perm: P.reportsView, render: () => <WorkforceReport /> },
    { key: 'attendance', title: 'Attendance', description: 'Attendance, hours and overtime by employee', icon: CalendarCheck, perm: P.reportsView, render: () => <EmployeePerformance /> },
    { key: 'equipment', title: 'Equipment utilisation', description: 'Hours, fuel, maintenance, downtime', icon: Gauge, perm: P.reportsView, render: () => <Utilization /> },
    { key: 'cashflow', title: 'Cash flow', description: 'Monthly inflows and outflows', icon: LineChart, perm: P.reportsFinancial, render: () => <CashFlow /> },
    { key: 'financial', title: 'Financial transactions', description: 'Full ledger with filters', icon: BarChart3, perm: P.reportsFinancial, render: () => <Transactions title="Financial transactions" /> },
    { key: 'profitability', title: 'Profitability', description: 'Profit & loss by project', icon: TrendingUp, perm: P.reportsFinancial, render: () => <ProfitAndLoss /> },
  ].filter((r) => can(r.perm) && (r.key !== 'workforce' && r.key !== 'attendance' ? true : can(P.hrView)) && (r.key !== 'inventory' || can(P.inventoryView)) && (r.key !== 'procurement' || can(P.procurementView)) && (r.key !== 'equipment' || can(P.equipmentView)) && (!['cashflow', 'financial', 'profitability', 'cost', 'variance'].includes(r.key) || can(P.financeView)))

  const active = reports.find((r) => r.key === params.get('report')) ?? reports[0]

  return (
    <div>
      <PageHeader title="Reports & Analytics" description="Every report can be filtered and exported to PDF, Excel or CSV." />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <nav aria-label="Reports" className="lg:sticky lg:top-20 lg:self-start">
          <ul className="scrollbar-thin flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible">
            {reports.map((r) => (
              <li key={r.key} className="shrink-0">
                <button
                  onClick={() => setParams({ report: r.key })}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                    active?.key === r.key ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2',
                  )}
                  aria-current={active?.key === r.key ? 'page' : undefined}
                >
                  <r.icon className={cn('mt-0.5 size-4 shrink-0', active?.key === r.key ? 'text-accent-ink' : 'text-subtle')} />
                  <span>
                    <span className="block text-sm font-medium">{r.title}</span>
                    <span className="hidden text-xs text-muted lg:block">{r.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <section className="min-w-0" aria-live="polite">
          {active ? (
            <>
              <h2 className="mb-3 text-lg font-semibold">{active.title}</h2>
              {active.render()}
            </>
          ) : (
            <p className="text-sm text-muted">No reports are available for your role.</p>
          )}
        </section>
      </div>
    </div>
  )
}
