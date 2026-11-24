import { useQuery } from '@tanstack/react-query'
import {
  AlarmClock,
  AlertTriangle,
  CalendarClock,
  FileSignature,
  FolderKanban,
  HardHat,
  Mail,
  MessagesSquare,
  Receipt,
  Sparkles,
  Truck,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, EmptyState, ErrorState, Skeleton, StatCard } from '@/components/ui/misc'
import { db, IS_DEMO } from '@/lib/backend'
import type { LoopStep } from '@/lib/ai/loop'
import { computeOverview, createToolEnv } from '@/lib/ai/tools'
import { cn, formatDateTime, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AiErrorNotice, PriorityBadge, WorkingIndicator } from './parts'
import { AI_KEY, generateReport, REPORT_PROMPTS, useAiInvalidate, useAiStatus } from './useAi'

const TILES: Array<{ key: string; label: string; icon: ReactNode; emphasis?: boolean }> = [
  { key: 'active_projects', label: 'Active projects', icon: <FolderKanban />, emphasis: true },
  { key: 'behind_schedule', label: 'Behind schedule', icon: <AlarmClock /> },
  { key: 'overdue_tasks', label: 'Overdue tasks', icon: <CalendarClock /> },
  { key: 'pending_approvals', label: 'Pending approvals', icon: <FileSignature /> },
  { key: 'outstanding_payments', label: 'Overdue payments', icon: <Receipt /> },
  { key: 'important_emails', label: 'New important emails', icon: <Mail /> },
  { key: 'pending_deliveries', label: 'Pending deliveries', icon: <Truck /> },
  { key: 'client_communications', label: 'Client communications', icon: <MessagesSquare /> },
  { key: 'site_issues', label: 'Unresolved site issues', icon: <HardHat /> },
  { key: 'critical_alerts', label: 'Critical alerts', icon: <AlertTriangle /> },
]

export function useOverview() {
  const { session } = useAuth()
  return useQuery({
    queryKey: [AI_KEY, 'overview', session?.user.id],
    enabled: !!session,
    // live updates come from the realtime listener (useAiLive); this is only a slow safety net
    refetchInterval: 10 * 60_000,
    queryFn: async () => computeOverview(await createToolEnv(db)),
  })
}

export function OverviewTab() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const q = useOverview()
  const status = useAiStatus()
  const invalidate = useAiInvalidate()
  const [steps, setSteps] = useState<LoopStep[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const dailyBrief = async () => {
    setBusy(true)
    setError(null)
    setSteps([])
    try {
      const { report } = await generateReport({
        kind: 'daily_brief',
        title: REPORT_PROMPTS.daily_brief.title,
        prompt: REPORT_PROMPTS.daily_brief.prompt,
        userName: profile?.full_name ?? '',
        role: profile?.role?.name ?? '',
        onStep: (s) => setSteps((prev) => [...prev.filter((p) => p.round !== s.round), s]),
      })
      await invalidate('ai_reports', 'ai_activity')
      toast.success('Daily brief saved to AI Reports')
      navigate(`/ai?tab=reports&report=${report.id}`)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const o = q.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Figures are computed live from ABCkit records <strong>your role can see</strong>
          {q.dataUpdatedAt ? ` · updated ${timeAgo(new Date(q.dataUpdatedAt).toISOString())}` : ''}
          {status.data?.last_monitor_at ? ` · monitor ran ${timeAgo(status.data.last_monitor_at)}` : ''}
        </p>
        <Button variant="primary" onClick={dailyBrief} loading={busy}>
          <Sparkles /> Daily brief
        </Button>
      </div>
      {busy && <WorkingIndicator steps={steps} label={IS_DEMO ? 'Composing the [DEMO] daily brief' : 'Writing the daily brief'} />}
      {error ? <AiErrorNotice error={error} title="Could not generate the daily brief" /> : null}

      <section aria-label="Executive KPIs" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {!o
          ? TILES.map((t) => <Skeleton key={t.key} className="h-[104px]" />)
          : TILES.map((t) => {
              const k = o.kpis[t.key as keyof typeof o.kpis]
              const noAccess = k.value === null
              return (
                <StatCard
                  key={t.key}
                  emphasis={t.emphasis}
                  label={t.label}
                  value={noAccess ? '—' : k.value}
                  hint={noAccess ? 'No access for your role' : k.hint}
                  icon={t.icon}
                  onClick={noAccess ? undefined : () => navigate(k.link)}
                />
              )
            })}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Needs attention" description="Unresolved alerts, highest priority first" actions={<Link className="text-xs font-medium text-accent-ink hover:underline" to="/ai?tab=alerts">All alerts</Link>} />
          {!o ? (
            <Skeleton className="m-4 h-32" />
          ) : o.openAlerts.length === 0 ? (
            <EmptyState title="No open alerts" description="Run the monitor from the Alerts tab to check again." />
          ) : (
            <ul className="divide-y divide-border">
              {[...o.openAlerts]
                .sort((a, b) => ['urgent', 'high', 'medium', 'low'].indexOf(a.priority) - ['urgent', 'high', 'medium', 'low'].indexOf(b.priority))
                .slice(0, 7)
                .map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <PriorityBadge priority={a.priority} />
                    <div className="min-w-0 flex-1">
                      <Link to={a.record?.link ?? '/ai?tab=alerts'} className="text-sm font-medium hover:text-accent-ink">
                        {a.title}
                      </Link>
                      <p className="line-clamp-2 text-xs text-muted">{a.recommended_action || a.description}</p>
                    </div>
                    <span className="shrink-0 text-[11px] text-subtle">{timeAgo(a.first_seen_at)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Important new emails" description="Analysed, unanswered, last 48 hours" actions={<Link className="text-xs font-medium text-accent-ink hover:underline" to="/ai?tab=email&important=1">Email Intelligence</Link>} />
          {!o ? (
            <Skeleton className="m-4 h-32" />
          ) : o.kpis.important_emails.value === null ? (
            <EmptyState title="No email access" description="Your role does not include Email Intelligence (ai.email)." />
          ) : o.importantNew.length === 0 ? (
            <EmptyState title="Nothing important waiting" />
          ) : (
            <ul className="divide-y divide-border">
              {o.importantNew.slice(0, 7).map((e) => (
                <li key={e.id} className="px-4 py-3 sm:px-5">
                  <div className="flex items-start justify-between gap-3">
                    <Link to={`/ai?tab=email&email=${encodeURIComponent(e.id)}`} className={cn('min-w-0 text-sm font-medium hover:text-accent-ink', e.ai?.flags?.suspicious_instructions && 'text-danger')}>
                      {e.subject}
                    </Link>
                    <PriorityBadge priority={e.ai?.priority} />
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{e.ai?.summary}</p>
                  <p className="mt-0.5 text-[11px] text-subtle">
                    {e.from?.name ?? e.from?.address} · {formatDateTime(e.date)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Projects behind schedule" description="Progress lagging time elapsed beyond the AI settings threshold" />
          {!o ? (
            <Skeleton className="m-4 h-24" />
          ) : o.behind.length === 0 ? (
            <EmptyState title="All active projects on track" />
          ) : (
            <ul className="divide-y divide-border">
              {o.behind.map(({ p, s }) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <Link to={`/projects/${p.id}`} className="min-w-0 truncate text-sm font-medium hover:text-accent-ink">
                    {p.name}
                  </Link>
                  <span className="shrink-0 text-xs text-muted tabular">
                    {s.progress_pct}% done · {s.elapsed_pct ?? '—'}% time{s.overdue ? ' · past end date' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Oldest pending approvals" />
          {!o ? (
            <Skeleton className="m-4 h-24" />
          ) : !o.approvals.items.length ? (
            <EmptyState title={o.approvals.checked.length ? 'Nothing waiting for approval' : 'No approval modules in your role'} />
          ) : (
            <ul className="divide-y divide-border">
              {o.approvals.items.slice(0, 6).map((a) => (
                <li key={`${a.kind}-${a.id}`} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <Link to={a.link} className="block truncate text-sm font-medium hover:text-accent-ink">
                      {a.label}
                    </Link>
                    <p className="text-xs text-muted">
                      {a.kind}
                      {a.project ? ` · ${a.project}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-subtle">{a.age_days ?? 0} d</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
