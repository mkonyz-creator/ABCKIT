import { useQuery } from '@tanstack/react-query'
import { BellRing, Check, CheckCheck, ExternalLink, Radar } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/form'
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { db, IS_DEMO, unwrap } from '@/lib/backend'
import { ALERT_TYPES, PRIORITIES, type AiAlert } from '@/shared/ai/contract'
import { errorMessage, formatDateTime, humanize, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AiErrorNotice, PriorityBadge } from './parts'
import { C, useAiInvalidate, useAiStatus, useCallable } from './useAi'

const RANK = (p: string) => PRIORITIES.indexOf(p as never)

export function AlertsTab() {
  const { profile } = useAuth()
  const call = useCallable()
  const invalidate = useAiInvalidate()
  const status = useAiStatus()
  const alerts = useQuery({
    queryKey: [C.alerts, 'list'],
    queryFn: async () => unwrap(await db.from(C.alerts).select('*').order('last_seen_at', { ascending: false }).limit(500)) as AiAlert[],
  })
  const people = useQuery({
    queryKey: ['profiles', 'names'],
    queryFn: async () => new Map((unwrap(await db.from('profiles').select('id,full_name')) as Array<{ id: string; full_name: string }>).map((p) => [p.id, p.full_name])),
  })
  const [st, setSt] = useState('unresolved')
  const [prio, setPrio] = useState('')
  const [type, setType] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  const rows = useMemo(
    () =>
      (alerts.data ?? [])
        .filter((a) => (st === 'all' ? true : st === 'unresolved' ? a.status !== 'resolved' : a.status === st))
        .filter((a) => !prio || RANK(a.priority) >= RANK(prio))
        .filter((a) => !type || a.type === type)
        .filter((a) => !source || a.source === source)
        .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || RANK(b.priority) - RANK(a.priority) || b.last_seen_at.localeCompare(a.last_seen_at)),
    [alerts.data, st, prio, type, source],
  )

  const setStatus = async (a: AiAlert, next: 'acknowledged' | 'resolved') => {
    setBusy(a.id)
    const { error: err } = await db.from(C.alerts).update({ status: next }).eq('id', a.id)
    setBusy(null)
    if (err) return toast.error(errorMessage(err))
    toast.success(next === 'acknowledged' ? 'Alert acknowledged' : 'Alert resolved')
    await invalidate(C.alerts)
  }

  const runMonitor = async () => {
    setBusy('monitor')
    setError(null)
    try {
      const r = await call('aiRunMonitor', {})
      toast.success(`${IS_DEMO ? '[DEMO] ' : ''}Analysis complete: ${r.alerts_open} open alert(s), ${r.created} new, ${r.resolved} resolved`)
      await invalidate(C.alerts, C.status, C.activity)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  if (alerts.error) return <ErrorState error={alerts.error} onRetry={() => alerts.refetch()} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Select value={st} onChange={(e) => setSt(e.target.value)} className="w-40" aria-label="Status">
            <option value="unresolved">Unresolved</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </Select>
          <Select value={prio} onChange={(e) => setPrio(e.target.value)} className="w-36" aria-label="Minimum priority">
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {humanize(p)}+
              </option>
            ))}
          </Select>
          <Select value={type} onChange={(e) => setType(e.target.value)} className="w-48" aria-label="Type">
            <option value="">All types</option>
            {ALERT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
          <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-36" aria-label="Source">
            <option value="">All sources</option>
            <option value="monitor">Monitor</option>
            <option value="email">Email</option>
            <option value="ai">AI</option>
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted">
            {status.data?.last_monitor_at ? `Last analysis ${timeAgo(status.data.last_monitor_at)}${status.data.last_monitor_ok === false ? ' (failed)' : ''}` : 'Monitor has not run yet'}
          </p>
          <Button variant="primary" onClick={runMonitor} loading={busy === 'monitor'}>
            <Radar /> Run analysis now
          </Button>
        </div>
      </div>
      {error ? <AiErrorNotice error={error} title="The monitor could not run" /> : null}
      {status.data?.last_monitor_error && <AiErrorNotice error={{ message: status.data.last_monitor_error }} title="Last scheduled analysis failed" />}

      <Card>
        {alerts.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : !rows.length ? (
          <EmptyState icon={<BellRing className="size-6" />} title="No alerts" description={alerts.data?.length ? 'No alert matches these filters.' : 'Run the analysis to check projects, payments, deliveries, emails and stock.'} />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((a) => (
              <li key={a.id} className="grid gap-3 px-4 py-3 sm:px-5 md:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <PriorityBadge priority={a.priority} />
                    <Badge tone={a.status === 'open' ? 'danger' : a.status === 'acknowledged' ? 'warning' : 'success'}>{humanize(a.status)}</Badge>
                    <Badge>{humanize(a.type)}</Badge>
                    <Badge tone={a.source === 'email' ? 'info' : 'neutral'}>{a.source === 'email' ? 'From email' : a.source === 'ai' ? 'AI' : 'Monitor'}</Badge>
                  </div>
                  <p className="font-medium">{a.title}</p>
                  <p className="text-sm text-muted">{a.description}</p>
                  {a.recommended_action && (
                    <p className="text-sm">
                      <span className="font-semibold text-accent-ink">Recommended: </span>
                      {a.recommended_action}
                    </p>
                  )}
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
                    {a.record?.link && (
                      <Link to={a.record.link} className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">
                        <ExternalLink className="size-3" /> {a.record.label || 'Open record'}
                      </Link>
                    )}
                    {a.project && (
                      <Link to={`/projects/${a.project.id}`} className="hover:underline">
                        {a.project.name}
                      </Link>
                    )}
                    <span>First seen {formatDateTime(a.first_seen_at)}</span>
                    <span>Last seen {timeAgo(a.last_seen_at)}</span>
                    {a.acknowledged_by && (
                      <span>
                        Acknowledged by {people.data?.get(a.acknowledged_by) ?? (a.acknowledged_by === profile?.id ? 'you' : 'a user')} {a.acknowledged_at ? timeAgo(a.acknowledged_at) : ''}
                      </span>
                    )}
                    {a.resolved_at && <span>Resolved {formatDateTime(a.resolved_at)}</span>}
                  </p>
                </div>
                {a.status !== 'resolved' && (
                  <div className="flex items-start gap-2 md:flex-col md:items-stretch">
                    {a.status === 'open' && (
                      <Button size="sm" onClick={() => setStatus(a, 'acknowledged')} loading={busy === a.id}>
                        <Check /> Acknowledge
                      </Button>
                    )}
                    <Button size="sm" variant="dark" onClick={() => setStatus(a, 'resolved')} loading={busy === a.id}>
                      <CheckCheck /> Resolve
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
