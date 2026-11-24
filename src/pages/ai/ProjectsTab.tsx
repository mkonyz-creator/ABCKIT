import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CalendarClock, FileSignature, HardHat, Mail, Search, Sparkles, Wallet } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Markdown } from '@/components/ai/Markdown'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Select } from '@/components/ui/form'
import { Badge, Card, EmptyState, ErrorState, Progress, Skeleton, StatusBadge } from '@/components/ui/misc'
import { db, IS_DEMO } from '@/lib/backend'
import type { LoopStep } from '@/lib/ai/loop'
import { aiSettingsOf, alertsOf, createToolEnv, emailsOf, pendingApprovals, readRows, scheduleOf, siteIssues, tasksOf } from '@/lib/ai/tools'
import type { AiReport } from '@/shared/ai/contract'
import { cn, formatDate, formatMoney } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AiErrorNotice, WorkingIndicator } from './parts'
import { AI_KEY, generateReport, projectPrompt, useAiInvalidate } from './useAi'

function useProjectIntel() {
  const { session } = useAuth()
  return useQuery({
    queryKey: [AI_KEY, 'projects', session?.user.id],
    enabled: !!session,
    queryFn: async () => {
      const env = await createToolEnv(db)
      const [projects, fin, tasks, approvals, issues, emails, alerts, settings] = await Promise.all([
        readRows(env, 'projects', (q) => q.eq('is_archived', false)),
        readRows(env, 'project_financials'),
        tasksOf(env),
        pendingApprovals(env),
        siteIssues(env, 30),
        emailsOf(env),
        alertsOf(env),
        aiSettingsOf(env),
      ])
      const thr = Number(settings.schedule_slip_threshold_pct) || 10
      const finBy = new Map(fin.map((f) => [String(f.project_id), f]))
      return projects
        .filter((p) => p.status !== 'cancelled')
        .map((p) => {
          const id = String(p.id)
          const open = tasks.filter((t) => String(t.project_id) === id && t.status !== 'done')
          const f = finBy.get(id)
          return {
            p,
            schedule: scheduleOf(p, env.today, thr),
            finance: f ? { budget: Number(f.budget) || 0, actual: Number(f.actual_cost) || 0, used: Number(f.budget_used_pct) || 0 } : null,
            openTasks: open.length,
            overdueTasks: open.filter((t) => t.due_date && String(t.due_date) < env.today).length,
            approvals: approvals.items.filter((a) => a.project_id === id).length,
            issues: issues ? issues.open_incidents.filter((i) => String(i.project_id) === id).length + issues.reported_problems.filter((x) => String(x.project_id) === id).length : null,
            emails: emails ? emails.rows.filter((e) => e.ai?.related_project_id === id).length : null,
            alerts: alerts.filter((a) => a.status !== 'resolved' && a.project?.id === id),
          }
        })
        .sort((a, b) => Number(b.schedule.behind) - Number(a.schedule.behind) || (b.schedule.slip_pct ?? -99) - (a.schedule.slip_pct ?? -99))
    },
  })
}

export function ProjectsTab() {
  const { profile } = useAuth()
  const q = useProjectIntel()
  const invalidate = useAiInvalidate()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('active')
  const [analysis, setAnalysis] = useState<{ name: string; busy: boolean; steps: LoopStep[]; report?: AiReport; error?: unknown } | null>(null)

  const rows = useMemo(
    () =>
      (q.data ?? []).filter(
        (r) => (!status || (status === 'behind' ? r.schedule.behind : r.p.status === status)) && (!search || `${r.p.code} ${r.p.name} ${r.p.location ?? ''}`.toLowerCase().includes(search.toLowerCase())),
      ),
    [q.data, status, search],
  )

  const analyse = async (p: { id: string; name: string }) => {
    setAnalysis({ name: p.name, busy: true, steps: [] })
    try {
      const { report } = await generateReport({
        kind: 'project',
        title: `Project analysis: ${p.name}`,
        prompt: projectPrompt(p),
        userName: profile?.full_name ?? '',
        role: profile?.role?.name ?? '',
        onStep: (s) => setAnalysis((a) => (a ? { ...a, steps: [...a.steps.filter((x) => x.round !== s.round), s] } : a)),
      })
      setAnalysis({ name: p.name, busy: false, steps: [], report })
      await invalidate('ai_reports', 'ai_activity')
    } catch (e) {
      setAnalysis({ name: p.name, busy: false, steps: [], error: e })
    }
  }

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects" className="pl-9" aria-label="Search projects" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" aria-label="Status">
          <option value="active">Active</option>
          <option value="behind">Behind schedule</option>
          <option value="planning">Planning</option>
          <option value="on_hold">On hold</option>
          <option value="completed">Completed</option>
          <option value="">All</option>
        </Select>
        <p className="text-xs text-muted">Progress vs. time elapsed, budget, tasks, approvals, site issues, emails and alerts — for the projects your role can see.</p>
      </div>

      {q.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-60" />
          ))}
        </div>
      ) : !rows.length ? (
        <Card>
          <EmptyState title="No projects" description="No project matches this filter, or your role has no project access." />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <Card key={r.p.id} className={cn('flex flex-col', r.schedule.behind && 'border-warning/50')}>
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/projects/${r.p.id}`} className="min-w-0 font-semibold hover:text-accent-ink">
                    <span className="mr-1 font-mono text-xs text-subtle">{r.p.code}</span>
                    {r.p.name}
                  </Link>
                  <StatusBadge status={r.p.status} />
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {formatDate(r.p.start_date)} → {formatDate(r.p.end_date)}
                  {r.schedule.behind && (
                    <Badge tone="warning" className="ml-2">
                      {r.schedule.overdue ? 'Past end date' : 'Behind schedule'}
                    </Badge>
                  )}
                </p>
              </div>
              <div className="flex-1 space-y-3 px-4 py-3">
                <div>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-muted">Progress</span>
                    <span className="font-semibold tabular">{r.schedule.progress_pct}%</span>
                  </div>
                  <Progress value={r.schedule.progress_pct} tone={r.schedule.behind ? 'danger' : 'accent'} label="Progress" />
                  <div className="mb-1 mt-2 flex justify-between text-xs">
                    <span className="text-muted">Time elapsed</span>
                    <span className="font-semibold tabular">{r.schedule.elapsed_pct ?? '—'}%</span>
                  </div>
                  <Progress value={r.schedule.elapsed_pct ?? 0} tone="success" label="Time elapsed" />
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <Metric icon={<Wallet />} label="Budget used" value={r.finance ? `${r.finance.used}%` : '—'} hint={r.finance ? `${formatMoney(r.finance.actual, undefined, { compact: true })} of ${formatMoney(r.finance.budget, undefined, { compact: true })}` : 'No finance access'} alert={!!r.finance && r.finance.used > 100} />
                  <Metric icon={<CalendarClock />} label="Open / overdue tasks" value={`${r.openTasks} / ${r.overdueTasks}`} alert={r.overdueTasks > 0} />
                  <Metric icon={<FileSignature />} label="Pending approvals" value={String(r.approvals)} alert={r.approvals > 0} />
                  <Metric icon={<HardHat />} label="Site issues (30 d)" value={r.issues === null ? '—' : String(r.issues)} hint={r.issues === null ? 'No site access' : undefined} alert={!!r.issues} />
                  <Metric icon={<Mail />} label="Related emails" value={r.emails === null ? '—' : String(r.emails)} hint={r.emails === null ? 'No email access' : undefined} />
                  <Metric icon={<AlertTriangle />} label="Open alerts" value={String(r.alerts.length)} alert={r.alerts.length > 0} />
                </dl>
                {r.alerts.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {r.alerts.slice(0, 2).map((a) => (
                      <li key={a.id} className="line-clamp-2 text-warning">
                        • {a.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
                <Link to={`/projects/${r.p.id}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  Open project
                </Link>
                <Button size="sm" variant="primary" onClick={() => analyse({ id: String(r.p.id), name: String(r.p.name) })} disabled={!!analysis?.busy}>
                  <Sparkles /> Analyse with AI
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!analysis} onOpenChange={(o) => !o && !analysis?.busy && setAnalysis(null)} title={`Project analysis — ${analysis?.name ?? ''}`} size="lg" description={IS_DEMO ? '[DEMO] rule-based analysis — no AI model is called' : 'Generated from the records your role can see; saved to AI Reports'}>
        {analysis?.busy && <WorkingIndicator steps={analysis.steps} label="Analysing project" />}
        {analysis?.error ? <AiErrorNotice error={analysis.error} title="Could not analyse the project" /> : null}
        {analysis?.report && (
          <div className="space-y-3">
            <Markdown text={analysis.report.content_md} />
            <Link to={`/ai?tab=reports&report=${analysis.report.id}`} className="text-sm font-medium text-accent-ink hover:underline" onClick={() => setAnalysis(null)}>
              Open in AI Reports →
            </Link>
          </div>
        )}
      </Dialog>
    </div>
  )
}

function Metric({ icon, label, value, hint, alert }: { icon: ReactNode; label: string; value: string; hint?: string; alert?: boolean }) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5">
      <dt className="flex items-center gap-1 text-[11px] text-muted [&_svg]:size-3">
        {icon} {label}
      </dt>
      <dd className={cn('mt-0.5 font-semibold tabular', alert && 'text-danger')}>{value}</dd>
      {hint && <dd className="truncate text-[10px] text-subtle">{hint}</dd>}
    </div>
  )
}
