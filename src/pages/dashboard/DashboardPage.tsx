import { differenceInCalendarDays, format, parseISO } from 'date-fns'
import {
  AlertTriangle,
  Banknote,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ClipboardPlus,
  Clock,
  FolderKanban,
  HardHat,
  Hourglass,
  Plus,
  Receipt,
  Users,
  Wallet,
} from 'lucide-react'
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisProps, ChartCard, ChartTooltip, compactMoney, GRID, SERIES } from '@/components/charts/ChartKit'
import { Button } from '@/components/ui/button'
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, Progress, Skeleton, StatCard, StatusBadge } from '@/components/ui/misc'
import { useList, useRpc } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import type { ActivityItem, DashboardSummary, ProjectFinancials } from '@/lib/types'
import { cn, formatDate, formatMoney, formatNumber, humanize, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { EmailActivityCard } from './EmailActivityCard'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const activityVerb: Record<string, string> = { INSERT: 'created', UPDATE: 'updated', DELETE: 'deleted' }
const tableNoun: Record<string, string> = {
  projects: 'project', boqs: 'BOQ', site_reports: 'site report', safety_incidents: 'safety incident', materials: 'material',
  inventory_transactions: 'stock movement', purchase_requests: 'purchase request', purchase_orders: 'purchase order',
  goods_received: 'GRN', equipment: 'equipment', maintenance_records: 'maintenance record', financial_transactions: 'transaction',
  client_invoices: 'client invoice', supplier_invoices: 'supplier invoice', documents: 'document', tasks: 'task', clients: 'client', suppliers: 'supplier',
}

export default function DashboardPage() {
  const { profile, can } = useAuth()
  const navigate = useNavigate()
  const summary = useRpc<DashboardSummary>('dashboard_summary', {}, { key: ['dashboard', 'summary'] })
  const finance = useRpc<Array<{ month: string; income: number; expense: number }>>('monthly_finance', { p_months: 12 }, { key: ['dashboard', 'monthly'], enabled: can(P.financeView) })
  const workforce = useRpc<Array<{ day: string; present: number; absent: number; hours: number; overtime: number }>>('workforce_productivity', { p_days: 14 }, { key: ['dashboard', 'workforce'], enabled: can(P.hrView) })
  const activity = useRpc<ActivityItem[]>('recent_activity', { p_limit: 12 }, { key: ['dashboard', 'activity'] })
  const projFin = useList<ProjectFinancials>('project_financials', { eq: { is_archived: false }, enabled: can(P.financeView), keyExtra: 'dash' })

  const s = summary.data

  const financeData = useMemo(
    () => (finance.data ?? []).map((r) => ({ month: format(parseISO(r.month), 'MMM yy'), Revenue: Number(r.income), Expenses: Number(r.expense) })),
    [finance.data],
  )
  const budgetData = useMemo(
    () =>
      (projFin.data ?? [])
        .filter((p) => p.status !== 'cancelled' && (p.budget > 0 || p.actual_cost > 0))
        .sort((a, b) => b.budget - a.budget)
        .slice(0, 8)
        .map((p) => ({ name: p.code, project: p.name, Budget: Number(p.budget), Actual: Number(p.actual_cost) })),
    [projFin.data],
  )
  const performanceData = useMemo(
    () =>
      (projFin.data ?? [])
        .filter((p) => p.status === 'active' && p.start_date && p.end_date)
        .slice(0, 8)
        .map((p) => {
          const total = Math.max(1, differenceInCalendarDays(parseISO(p.end_date!), parseISO(p.start_date!)))
          const elapsed = Math.min(100, Math.max(0, (differenceInCalendarDays(new Date(), parseISO(p.start_date!)) / total) * 100))
          return { name: p.code, project: p.name, Progress: Number(p.progress), 'Time elapsed': Math.round(elapsed) }
        }),
    [projFin.data],
  )
  const workforceData = useMemo(
    () => (workforce.data ?? []).map((r) => ({ day: format(parseISO(r.day), 'dd MMM'), 'Man-hours': Number(r.hours) + Number(r.overtime), Present: Number(r.present) })),
    [workforce.data],
  )

  if (summary.error) return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />

  return (
    <div>
      <PageHeader
        title={`${greeting()}, ${profile?.full_name?.split(' ')[0] ?? ''}`}
        description={`${format(new Date(), 'EEEE, dd MMMM yyyy')} · ${profile?.role?.name ?? ''}`}
        actions={
          <>
            {can(P.siteReport) && (
              <Button onClick={() => navigate('/site-reports/new')}>
                <ClipboardPlus /> Site report
              </Button>
            )}
            {can(P.projectsManage) && (
              <Button variant="primary" onClick={() => navigate('/projects?new=1')}>
                <Plus /> New project
              </Button>
            )}
          </>
        }
      />

      {/* KPI tiles */}
      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {!s ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[104px]" />)
        ) : (
          <>
            <StatCard emphasis label="Active projects" value={s.projects.active} hint={`Avg. progress ${formatNumber(s.projects.avg_progress, 1)}%`} icon={<FolderKanban />} onClick={() => navigate('/projects?status=active')} />
            <StatCard label="Completed" value={s.projects.completed} hint={`${s.projects.total} projects in total`} icon={<CheckCircle2 />} onClick={() => navigate('/projects?status=completed')} />
            <StatCard label="Pending" value={s.projects.pending} hint={`${s.projects.on_hold} on hold`} icon={<Hourglass />} onClick={() => navigate('/projects?status=planning')} />
            <StatCard label="Contract value" value={formatMoney(s.projects.contract_value, undefined, { compact: true })} hint={`Budget ${formatMoney(s.projects.budget, undefined, { compact: true })}`} icon={<Banknote />} />
            {s.finance ? (
              <>
                <StatCard label="Expenditure" value={formatMoney(s.finance.expenditure, undefined, { compact: true })} hint={`Remaining ${formatMoney(s.finance.remaining_budget, undefined, { compact: true })}`} icon={<Wallet />} onClick={() => navigate('/finance')} />
                <StatCard
                  label="Outstanding payments"
                  value={formatMoney(s.finance.receivable, undefined, { compact: true })}
                  hint={`Owed to suppliers ${formatMoney(s.finance.payable, undefined, { compact: true })}`}
                  icon={<Receipt />}
                  onClick={() => navigate('/finance?tab=invoices')}
                />
              </>
            ) : (
              <>
                <StatCard label="Open tasks" value={s.tasks.open} hint={`${s.tasks.overdue} overdue · ${s.tasks.mine} mine`} icon={<CalendarClock />} onClick={() => navigate('/tasks')} />
                <StatCard label="Site reports (7d)" value={s.site?.reports_7d ?? '—'} hint={s.site ? `${s.site.pending_reports} awaiting approval` : undefined} icon={<HardHat />} onClick={() => navigate('/site-reports')} />
              </>
            )}
          </>
        )}
      </section>

      {/* secondary strip */}
      {s && (
        <section aria-label="Operational alerts" className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {s.inventory && (
            <MiniStat
              icon={<Boxes />}
              label="Stock alerts"
              value={s.inventory.low_stock_count}
              alert={s.inventory.low_stock_count > 0}
              to="/inventory?filter=low"
              hint="materials at/below minimum"
            />
          )}
          {s.workforce && (
            <MiniStat
              icon={<Users />}
              label="Attendance today"
              value={`${s.workforce.present_today}/${s.workforce.employees}`}
              to="/workforce?tab=attendance"
              hint={`${s.workforce.absent_today} absent · ${s.workforce.on_leave} on leave`}
            />
          )}
          <MiniStat icon={<Clock />} label="Overdue tasks" value={s.tasks.overdue} alert={s.tasks.overdue > 0} to="/tasks?filter=overdue" hint={`${s.tasks.open} open tasks`} />
          {s.site ? (
            <MiniStat icon={<AlertTriangle />} label="Open safety incidents" value={s.site.open_incidents} alert={s.site.open_incidents > 0} to="/site?tab=safety" hint={`${s.site.pending_reports} reports to approve`} />
          ) : s.finance ? (
            <MiniStat icon={<Receipt />} label="Pending approvals" value={s.finance.pending_approvals} to="/finance?tab=transactions" hint="financial transactions" />
          ) : null}
        </section>
      )}

      {/* charts */}
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        {can(P.aiEmail) && <EmailActivityCard />}
        {can(P.financeView) && (
          <ChartCard
            title="Revenue and expenses"
            description="Approved transactions, last 12 months"
            legend={[
              { label: 'Revenue', color: SERIES[0] },
              { label: 'Expenses', color: SERIES[1] },
            ]}
            loading={finance.isLoading}
            empty={!financeData.some((d) => d.Revenue || d.Expenses)}
            data={financeData}
            tableCols={[
              { key: 'month', label: 'Month' },
              { key: 'Revenue', label: 'Revenue', format: 'money' },
              { key: 'Expenses', label: 'Expenses', format: 'money' },
            ]}
          >
            <ResponsiveContainer>
              <LineChart data={financeData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="month" {...axisProps} />
                <YAxis {...axisProps} tickFormatter={compactMoney} width={56} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--border-strong)' }} />
                <Line type="monotone" dataKey="Revenue" stroke={SERIES[0]} strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
                <Line type="monotone" dataKey="Expenses" stroke={SERIES[1]} strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {can(P.financeView) && (
          <ChartCard
            title="Monthly expenditure"
            description="Approved expenses per month"
            loading={finance.isLoading}
            empty={!financeData.some((d) => d.Expenses)}
            data={financeData}
            tableCols={[
              { key: 'month', label: 'Month' },
              { key: 'Expenses', label: 'Expenditure', format: 'money' },
            ]}
          >
            <ResponsiveContainer>
              <BarChart data={financeData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="month" {...axisProps} />
                <YAxis {...axisProps} tickFormatter={compactMoney} width={56} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-2)' }} />
                <Bar dataKey="Expenses" name="Expenditure" fill={SERIES[1]} radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {can(P.financeView) && (
          <ChartCard
            title="Budget vs actual cost"
            description="Largest projects by budget"
            legend={[
              { label: 'Budget', color: SERIES[0] },
              { label: 'Actual cost', color: SERIES[1] },
            ]}
            loading={projFin.isLoading}
            empty={budgetData.length === 0}
            data={budgetData}
            tableCols={[
              { key: 'project', label: 'Project' },
              { key: 'Budget', label: 'Budget', format: 'money' },
              { key: 'Actual', label: 'Actual', format: 'money' },
            ]}
          >
            <ResponsiveContainer>
              <BarChart data={budgetData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barGap={2}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="name" {...axisProps} />
                <YAxis {...axisProps} tickFormatter={compactMoney} width={56} />
                <Tooltip content={<ChartTooltip labelFormat={(l) => budgetData.find((b) => b.name === l)?.project ?? l} />} cursor={{ fill: 'var(--surface-2)' }} />
                <Bar dataKey="Budget" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="Actual" name="Actual cost" fill={SERIES[1]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {can(P.financeView) && (
          <ChartCard
            title="Project performance"
            description="Physical progress vs. share of contract time elapsed (active projects)"
            legend={[
              { label: 'Progress', color: SERIES[0] },
              { label: 'Time elapsed', color: SERIES[2] },
            ]}
            loading={projFin.isLoading}
            empty={performanceData.length === 0}
            data={performanceData}
            tableCols={[
              { key: 'project', label: 'Project' },
              { key: 'Progress', label: 'Progress', format: 'percent' },
              { key: 'Time elapsed', label: 'Time elapsed', format: 'percent' },
            ]}
          >
            <ResponsiveContainer>
              <BarChart data={performanceData} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barGap={2}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" domain={[0, 100]} {...axisProps} tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="name" {...axisProps} width={84} />
                <Tooltip content={<ChartTooltip valueFormat="percent" labelFormat={(l) => performanceData.find((b) => b.name === l)?.project ?? l} />} cursor={{ fill: 'var(--surface-2)' }} />
                <Bar dataKey="Progress" fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={14} />
                <Bar dataKey="Time elapsed" fill={SERIES[2]} radius={[0, 4, 4, 0]} maxBarSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {can(P.hrView) && (
          <ChartCard
            title="Workforce productivity"
            description="Man-hours logged per day incl. overtime, last 14 days"
            loading={workforce.isLoading}
            empty={!workforceData.some((d) => d['Man-hours'] > 0)}
            data={workforceData}
            tableCols={[
              { key: 'day', label: 'Day' },
              { key: 'Present', label: 'Workers present', format: 'number' },
              { key: 'Man-hours', label: 'Man-hours', format: 'number' },
            ]}
          >
            <ResponsiveContainer>
              <BarChart data={workforceData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="day" {...axisProps} />
                <YAxis {...axisProps} width={44} />
                <Tooltip content={<ChartTooltip valueFormat="number" />} cursor={{ fill: 'var(--surface-2)' }} />
                <Bar dataKey="Man-hours" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* project progress list */}
        <Card>
          <CardHeader title="Project progress" description="Active and upcoming projects" actions={<Link to="/projects" className="text-xs font-semibold text-accent-ink hover:underline">All projects</Link>} />
          <div className="divide-y divide-border">
            {!s ? (
              <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : s.progress.length === 0 ? (
              <EmptyState title="No active projects" description="Create a project to start tracking progress." />
            ) : (
              s.progress.map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="block px-4 py-3 hover:bg-surface-2/60 sm:px-5">
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium">
                      <span className="font-mono text-xs text-subtle">{p.code}</span> {p.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={p.status} />
                      <span className="w-10 text-right font-semibold tabular">{Math.round(p.progress)}%</span>
                    </span>
                  </div>
                  <Progress value={p.progress} label={`${p.name} progress`} />
                </Link>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* lists */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Upcoming deadlines" description="Next 3–6 weeks" />
          {!s ? (
            <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
          ) : s.deadlines.length === 0 ? (
            <EmptyState title="Nothing due soon" />
          ) : (
            <ul className="divide-y divide-border">
              {s.deadlines.map((d) => {
                const days = differenceInCalendarDays(parseISO(d.due), new Date())
                return (
                  <li key={`${d.kind}-${d.id}`}>
                    <Link to={d.kind === 'task' ? `/tasks?task=${d.id}` : `/projects/${d.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/60 sm:px-5">
                      <div className={cn('flex w-12 shrink-0 flex-col items-center rounded-md border py-1 text-center', days < 0 ? 'border-danger/40 bg-danger-soft text-danger' : days <= 3 ? 'border-accent/40 bg-accent-soft text-accent-ink' : 'border-border')}>
                        <span className="text-[10px] font-semibold uppercase">{format(parseISO(d.due), 'MMM')}</span>
                        <span className="text-base font-bold leading-none tabular">{format(parseISO(d.due), 'dd')}</span>
                      </div>
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="truncate font-medium">{d.label}</p>
                        <p className="truncate text-xs text-muted">
                          {d.kind === 'project' ? 'Project completion' : d.project ?? 'Task'} · {days < 0 ? `${-days}d overdue` : days === 0 ? 'today' : `in ${days}d`}
                        </p>
                      </div>
                      {d.kind === 'task' && <StatusBadge status={d.priority} />}
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          {activity.isLoading ? (
            <div className="space-y-2 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : (activity.data ?? []).length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="divide-y divide-border">
              {activity.data!.map((a) => (
                <li key={a.id} className="flex gap-3 px-4 py-2.5 text-sm sm:px-5">
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', a.action === 'INSERT' ? 'bg-accent' : a.action === 'DELETE' ? 'bg-danger' : 'bg-border-strong')} />
                  <div className="min-w-0">
                    <p className="truncate">
                      <span className="font-medium">{a.actor}</span> {activityVerb[a.action]} {tableNoun[a.table_name] ?? humanize(a.table_name)}
                      {a.label && <span className="text-muted"> · {a.label}</span>}
                    </p>
                    <p className="text-xs text-subtle">{timeAgo(a.changed_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Materials stock alerts" actions={can(P.inventoryView) ? <Link to="/inventory" className="text-xs font-semibold text-accent-ink hover:underline">Inventory</Link> : undefined} />
          {!s?.inventory ? (
            <EmptyState title={s ? 'Inventory not in your role' : 'Loading…'} />
          ) : s.inventory.low_stock.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="size-6 text-success" />} title="All stock above minimum" />
          ) : (
            <ul className="divide-y divide-border">
              {s.inventory.low_stock.map((m) => (
                <li key={m.id} className="px-4 py-2.5 text-sm sm:px-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{m.name}</span>
                    <Badge tone={Number(m.current_stock) <= 0 ? 'danger' : 'warning'}>
                      <AlertTriangle className="size-3" /> {Number(m.current_stock) <= 0 ? 'Out of stock' : 'Low'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted tabular">
                    {formatNumber(m.current_stock)} {m.unit} in stock · min {formatNumber(m.min_stock)} {m.unit}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {s?.inventory && <p className="border-t border-border px-5 py-2.5 text-xs text-muted">Stock value: {formatMoney(s.inventory.stock_value)} · as of {formatDate(new Date())}</p>}
        </Card>
      </div>
    </div>
  )
}

function MiniStat({ icon, label, value, hint, to, alert }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string; to: string; alert?: boolean }) {
  return (
    <Link to={to} className={cn('flex items-center gap-3 rounded-xl border bg-surface p-3 transition-colors hover:border-accent', alert ? 'border-accent/50' : 'border-border')}>
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4', alert ? 'bg-accent text-black' : 'bg-surface-2 text-muted')}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs text-muted">{label}</span>
        <span className="block text-lg font-bold leading-tight tabular">{value}</span>
        {hint && <span className="block truncate text-[11px] text-subtle">{hint}</span>}
      </span>
    </Link>
  )
}
