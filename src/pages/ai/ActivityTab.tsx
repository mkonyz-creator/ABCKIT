import { useQuery } from '@tanstack/react-query'
import { Activity, Coins, Cpu, MessageSquare } from 'lucide-react'
import { useMemo } from 'react'
import { DataTable, type Column } from '@/components/data/DataTable'
import { Badge, Card, CardHeader, StatCard } from '@/components/ui/misc'
import { db, unwrap } from '@/lib/backend'
import type { AiActivity, AiUsage } from '@/shared/ai/contract'
import { formatDateTime, formatNumber, humanize } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { C } from './useAi'

const ACTIONS = ['chat', 'report', 'email_sync', 'email_analyzed', 'reply_generated', 'draft_approved', 'email_sent', 'account_connected', 'account_disconnected', 'alert_created', 'monitor_run', 'settings_changed']

export function useAiActivity(limit = 1000) {
  return useQuery({
    queryKey: [C.activity, 'list', limit],
    queryFn: async () => unwrap(await db.from(C.activity).select('*').order('at', { ascending: false }).limit(limit)) as AiActivity[],
  })
}

export function ActivityTable({ limit = 1000, compact }: { limit?: number; compact?: boolean }) {
  const q = useAiActivity(limit)
  const people = useQuery({
    queryKey: ['profiles', 'names'],
    queryFn: async () => new Map((unwrap(await db.from('profiles').select('id,full_name')) as Array<{ id: string; full_name: string }>).map((p) => [p.id, p.full_name])),
  })
  const who = (id: string) => (id === 'system' ? 'System (scheduled)' : (people.data?.get(id) ?? id))
  const columns: Column<AiActivity>[] = [
    { key: 'at', header: 'When', value: (r) => r.at, cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.at)}</span>, sortable: true },
    { key: 'actor', header: 'Who', value: (r) => who(r.actor_id), sortable: true },
    { key: 'action', header: 'Action', value: (r) => humanize(r.action), cell: (r) => <Badge tone={r.action === 'email_sent' ? 'accent' : 'neutral'}>{humanize(r.action)}</Badge>, sortable: true },
    { key: 'detail', header: 'Detail', value: (r) => r.detail, cell: (r) => <span className="line-clamp-2 text-xs">{r.detail}</span>, hideOnMobile: false },
    { key: 'ok', header: 'Result', value: (r) => (r.ok ? 'OK' : 'Failed'), cell: (r) => <Badge tone={r.ok ? 'success' : 'danger'}>{r.ok ? 'OK' : 'Failed'}</Badge> },
  ]
  return (
    <DataTable
      rows={q.data}
      loading={q.isLoading}
      error={q.error}
      onRetry={() => q.refetch()}
      columns={columns}
      rowKey={(r) => r.id}
      searchPlaceholder="Search activity"
      exportTitle="AI audit log"
      pageSize={compact ? 10 : 25}
      compact={compact}
      initialSort={{ key: 'at', dir: 'desc' }}
      isDemo={(r) => r.is_demo}
      filters={[
        { key: 'action', label: 'Action', options: ACTIONS.map((a) => ({ value: a, label: humanize(a) })), predicate: (r, v) => r.action === v },
        { key: 'ok', label: 'Result', options: [{ value: 'ok', label: 'OK' }, { value: 'failed', label: 'Failed' }], predicate: (r, v) => (v === 'ok' ? r.ok : !r.ok) },
      ]}
      emptyTitle="No AI activity yet"
    />
  )
}

export function ActivityTab() {
  const { can } = useAuth()
  return (
    <div className="space-y-4">
      {can('ai.manage') ? <UsageStats /> : <p className="text-xs text-muted">You see your own AI activity. Usage statistics and everyone’s activity are visible with the ai.manage permission.</p>}
      <Card>
        <CardHeader title="AI activity history" description="Every chat question, report, email sync, analysis, reply and send — the AI audit trail." />
        <div className="p-3 sm:p-4">
          <ActivityTable />
        </div>
      </Card>
    </div>
  )
}

function UsageStats() {
  const since = useMemo(() => new Date(Date.now() - 30 * 86_400_000).toISOString(), [])
  const q = useQuery({
    queryKey: [C.usage, 'list', since.slice(0, 10)],
    // newest first with a limit (pushed down to Firestore as one ordered query), then the 30-day window here
    queryFn: async () => (unwrap(await db.from(C.usage).select('*').order('at', { ascending: false }).limit(5000)) as AiUsage[]).filter((u) => u.at >= since),
  })
  const rows = useMemo(() => q.data ?? [], [q.data])
  const sum = (f: (u: AiUsage) => number, list = rows) => list.reduce((a, u) => a + (Number(f(u)) || 0), 0)
  const byDay = useMemo(() => {
    const m = new Map<string, { day: string; calls: number; input: number; output: number; cost: number }>()
    for (const u of rows) {
      const d = u.at.slice(0, 10)
      const cur = m.get(d) ?? { day: d, calls: 0, input: 0, output: 0, cost: 0 }
      cur.calls++
      cur.input += Number(u.input_tokens) || 0
      cur.output += Number(u.output_tokens) || 0
      cur.cost += Number(u.cost_usd) || 0
      m.set(d, cur)
    }
    return [...m.values()].sort((a, b) => b.day.localeCompare(a.day))
  }, [rows])
  const byPurpose = useMemo(() => {
    const m = new Map<string, { purpose: string; calls: number; tokens: number; cost: number }>()
    for (const u of rows) {
      const cur = m.get(u.purpose) ?? { purpose: u.purpose, calls: 0, tokens: 0, cost: 0 }
      cur.calls++
      cur.tokens += (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
      cur.cost += Number(u.cost_usd) || 0
      m.set(u.purpose, cur)
    }
    return [...m.values()].sort((a, b) => b.calls - a.calls)
  }, [rows])
  const maxCalls = Math.max(1, ...byDay.map((d) => d.calls))

  return (
    <div className="space-y-4">
      <section aria-label="AI usage, last 30 days" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard emphasis label="Model calls (30 d)" value={formatNumber(rows.length, 0)} icon={<Activity />} />
        <StatCard label="Input tokens" value={formatNumber(sum((u) => u.input_tokens), 0)} hint={`${formatNumber(sum((u) => u.cache_read_tokens), 0)} from cache`} icon={<Cpu />} />
        <StatCard label="Output tokens" value={formatNumber(sum((u) => u.output_tokens), 0)} icon={<MessageSquare />} />
        <StatCard label="Estimated cost" value={`USD ${formatNumber(sum((u) => u.cost_usd), 2)}`} icon={<Coins />} />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="By day" description="Last 30 days" />
          <div className="scrollbar-thin max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-semibold">Day</th>
                  <th className="px-4 py-2 font-semibold">Calls</th>
                  <th className="px-4 py-2 text-right font-semibold">Tokens</th>
                  <th className="px-4 py-2 text-right font-semibold">Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {byDay.map((d) => (
                  <tr key={d.day} className="border-t border-border">
                    <td className="px-4 py-1.5 whitespace-nowrap">{d.day}</td>
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-6 text-right tabular">{d.calls}</span>
                        <span className="h-2 rounded-full bg-accent" style={{ width: `${(d.calls / maxCalls) * 80}px` }} aria-hidden />
                      </div>
                    </td>
                    <td className="px-4 py-1.5 text-right tabular">{formatNumber(d.input + d.output, 0)}</td>
                    <td className="px-4 py-1.5 text-right tabular">{formatNumber(d.cost, 4)}</td>
                  </tr>
                ))}
                {!byDay.length && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-muted">
                      {q.isLoading ? 'Loading…' : 'No model calls in the last 30 days'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHeader title="By purpose" />
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-semibold">Purpose</th>
                <th className="px-4 py-2 text-right font-semibold">Calls</th>
                <th className="px-4 py-2 text-right font-semibold">Tokens</th>
                <th className="px-4 py-2 text-right font-semibold">Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {byPurpose.map((p) => (
                <tr key={p.purpose} className="border-t border-border">
                  <td className="px-4 py-1.5">{humanize(p.purpose)}</td>
                  <td className="px-4 py-1.5 text-right tabular">{p.calls}</td>
                  <td className="px-4 py-1.5 text-right tabular">{formatNumber(p.tokens, 0)}</td>
                  <td className="px-4 py-1.5 text-right tabular">{formatNumber(p.cost, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  )
}
