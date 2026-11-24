/**
 * Report to Admin (Ripoti kwa Admin): every user sends a problem, request, complaint, safety issue or idea to the
 * administrators and follows the answer; administrators (users.manage) get an inbox to reply and set the status.
 * Rules: firebase/rules/10_core.rules (user_reports) · logic: src/backend/domains/userReports.ts.
 */
import { CheckCircle2, Inbox, Megaphone, Send, ShieldAlert, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, Spinner, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { db, unwrap } from '@/lib/backend'
import { useInvalidate, useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { cn, errorMessage, formatDateTime, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import {
  CATEGORY_LABEL,
  PRIORITY_LABEL,
  REPORT_CATEGORIES,
  REPORT_LIMITS,
  REPORT_PRIORITIES,
  REPORT_STATUSES,
  STATUS_LABEL,
  USER_REPORTS,
  type ReportCategory,
  type ReportPriority,
  type ReportStatus,
  type UserReport,
} from '@/shared/userReports'

const both = (l: { en: string; sw: string }) => `${l.en} · ${l.sw}`
const priorityTone = { low: 'neutral', normal: 'info', high: 'warning', urgent: 'danger' } as const

export default function ReportToAdminPage() {
  const { can, profile } = useAuth()
  const isAdmin = can(P.usersManage)
  const [params, setParams] = useSearchParams()
  const tab = isAdmin && params.get('tab') === 'inbox' ? 'inbox' : 'send'
  const focusId = params.get('id')
  const reports = useList<UserReport>(USER_REPORTS, { order: { column: 'created_at', ascending: false }, limit: 1000 })
  const people = useList<{ id: string; full_name: string | null; email: string | null }>('profiles', { select: 'id,full_name,email', enabled: isAdmin })
  const nameOf = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p.full_name || p.email || 'User'])), [people.data])
  const all = reports.data ?? []
  const mine = all.filter((r) => r.reporter_id === profile?.id)
  const openCount = all.filter((r) => r.status === 'open').length

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Megaphone className="size-6 text-accent-ink" /> Report to Admin
          </span>
        }
        description="Ripoti kwa Admin — tuma tatizo, ombi, lalamiko, suala la usalama au wazo. The administrators are notified and their answer appears here."
      />
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'inbox' ? { tab: 'inbox' } : {})}>
        {isAdmin && (
          <TabsList>
            <TabsTrigger value="send">Send a report · Tuma ripoti</TabsTrigger>
            <TabsTrigger value="inbox">
              Inbox · Ripoti zilizoingia{openCount > 0 ? ` (${openCount})` : ''}
            </TabsTrigger>
          </TabsList>
        )}
        <TabsContent value="send" className="space-y-5">
          <SendForm from={params.get('from')} />
          <Card>
            <CardHeader title="My reports · Ripoti zangu" description="What you sent and the admin's answer" />
            <ReportList query={reports} rows={mine} focusId={focusId} empty="You have not sent any report yet." render={(r) => <MineActions r={r} />} />
          </Card>
        </TabsContent>
        {isAdmin && (
          <TabsContent value="inbox">
            <AdminInbox query={reports} rows={all} nameOf={nameOf} focusId={focusId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}

function SendForm({ from }: { from: string | null }) {
  const invalidate = useInvalidate()
  const blank = { category: 'problem' as ReportCategory, priority: 'normal' as ReportPriority, subject: '', body: '', page: from ?? '' }
  const [f, setF] = useState(blank)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (!f.subject.trim() || !f.body.trim()) return toast.error('Write the subject and the details · Andika kichwa na maelezo')
    setBusy(true)
    try {
      unwrap(await db.from(USER_REPORTS).insert({ category: f.category, priority: f.priority, subject: f.subject, body: f.body, page: f.page.trim() || null }))
      toast.success('Report sent to the admin · Ripoti imetumwa kwa admin')
      setF({ ...blank, page: '' })
      await invalidate(USER_REPORTS)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader title="Send a report · Tuma ripoti" description="Only the administrators and you can see it" />
      <form onSubmit={send} className="grid gap-4 px-4 pb-5 sm:grid-cols-2 sm:px-5">
        <Field label="Type · Aina" htmlFor="rep-cat">
          <Select id="rep-cat" value={f.category} onChange={(e) => set('category', e.target.value as ReportCategory)}>
            {REPORT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {both(CATEGORY_LABEL[c])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority · Uzito" htmlFor="rep-pri">
          <Select id="rep-pri" value={f.priority} onChange={(e) => set('priority', e.target.value as ReportPriority)}>
            {REPORT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {both(PRIORITY_LABEL[p])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Subject · Kichwa" htmlFor="rep-sub" required className="sm:col-span-2">
          <Input id="rep-sub" value={f.subject} maxLength={REPORT_LIMITS.subject} onChange={(e) => set('subject', e.target.value)} placeholder="e.g. Cement delivery at Mbezi is short · Saruji iliyoletwa Mbezi imepungua" />
        </Field>
        <Field label="Details · Maelezo" htmlFor="rep-body" required className="sm:col-span-2" hint={`${f.body.length}/${REPORT_LIMITS.body}`}>
          <Textarea id="rep-body" rows={6} value={f.body} maxLength={REPORT_LIMITS.body} onChange={(e) => set('body', e.target.value)} placeholder="What happened, where, when and what you need · Nini kimetokea, wapi, lini na unahitaji nini" />
        </Field>
        <Field label="Where (page, project or site) · Wapi" htmlFor="rep-page" hint="Optional · Si lazima" className="sm:col-span-2">
          <Input id="rep-page" value={f.page} maxLength={REPORT_LIMITS.page} onChange={(e) => set('page', e.target.value)} placeholder="/site-reports, Mradi wa Mbezi…" />
        </Field>
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" variant="primary" disabled={busy}>
            <Send className="size-4" /> {busy ? 'Sending…' : 'Send to admin · Tuma kwa admin'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function ReportList({
  query,
  rows,
  focusId,
  empty,
  nameOf,
  render,
}: {
  query: { isLoading: boolean; error: unknown; refetch: () => unknown }
  rows: UserReport[]
  focusId: string | null
  empty: string
  nameOf?: Map<string, string>
  render: (r: UserReport) => ReactNode
}) {
  useEffect(() => {
    if (focusId) document.getElementById(`report-${focusId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusId, rows.length])
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  if (query.isLoading) return <Spinner />
  if (!rows.length) return <EmptyState icon={<Inbox className="size-6" />} title={empty} />
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.id} id={`report-${r.id}`} className={cn('space-y-2 px-4 py-4 sm:px-5', r.id === focusId && 'bg-accent-soft/40')}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 font-semibold">{r.subject}</p>
            <Badge tone={priorityTone[r.priority] ?? 'neutral'}>{both(PRIORITY_LABEL[r.priority] ?? { en: r.priority, sw: r.priority })}</Badge>
            <StatusBadge status={r.status} />
          </div>
          <p className="text-xs text-subtle">
            {both(CATEGORY_LABEL[r.category] ?? { en: r.category, sw: r.category })}
            {nameOf && ` · ${nameOf.get(r.reporter_id) ?? 'User'}`} · <span title={formatDateTime(r.created_at)}>{timeAgo(r.created_at)}</span>
            {r.page && (
              <>
                {' · '}
                {r.page.startsWith('/') ? (
                  <Link to={r.page} className="text-accent-ink hover:underline">
                    {r.page}
                  </Link>
                ) : (
                  r.page
                )}
              </>
            )}
          </p>
          <p className="whitespace-pre-wrap text-sm text-muted">{r.body}</p>
          {r.admin_reply && (
            <div className="rounded-lg border border-success/25 bg-success-soft/50 px-3 py-2 text-sm">
              <p className="mb-0.5 text-xs font-semibold text-success">
                Admin reply · Jibu la admin{nameOf && r.handled_by ? ` — ${nameOf.get(r.handled_by) ?? ''}` : ''}
                {r.handled_at ? ` · ${timeAgo(r.handled_at)}` : ''}
              </p>
              <p className="whitespace-pre-wrap">{r.admin_reply}</p>
            </div>
          )}
          {render(r)}
        </li>
      ))}
    </ul>
  )
}

function MineActions({ r }: { r: UserReport }) {
  const invalidate = useInvalidate()
  const [busy, setBusy] = useState(false)
  if (r.status === 'closed' || r.status === 'resolved') return null
  const withdraw = async () => {
    setBusy(true)
    try {
      unwrap(await db.from(USER_REPORTS).update({ status: 'closed' }).eq('id', r.id))
      toast.success('Report closed · Ripoti imefungwa')
      await invalidate(USER_REPORTS)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex justify-end">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void withdraw()}>
        <Undo2 className="size-4" /> Withdraw · Futa ombi
      </Button>
    </div>
  )
}

function AdminInbox({ query, rows, nameOf, focusId }: { query: Parameters<typeof ReportList>[0]['query']; rows: UserReport[]; nameOf: Map<string, string>; focusId: string | null }) {
  const [status, setStatus] = useState<ReportStatus | 'all'>('all')
  const count = (s: ReportStatus) => rows.filter((r) => r.status === s).length
  const urgent = rows.filter((r) => r.status !== 'closed' && r.status !== 'resolved' && (r.priority === 'urgent' || r.category === 'safety')).length
  const shown = status === 'all' ? rows : rows.filter((r) => r.status === status)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard emphasis label="New · Mpya" value={String(count('open'))} icon={<Inbox />} />
        <StatCard label="In review · Inashughulikiwa" value={String(count('in_review'))} icon={<Megaphone />} />
        <StatCard label="Urgent / safety · Dharura" value={String(urgent)} icon={<ShieldAlert />} />
        <StatCard label="Resolved · Zimetatuliwa" value={String(count('resolved'))} icon={<CheckCircle2 />} />
      </div>
      <Card>
        <CardHeader
          title="Reports from users · Ripoti za watumiaji"
          actions={
            <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as ReportStatus | 'all')} className="h-8 w-auto text-xs">
              <option value="all">All · Zote ({rows.length})</option>
              {REPORT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {both(STATUS_LABEL[s])} ({count(s)})
                </option>
              ))}
            </Select>
          }
        />
        <ReportList query={query} rows={shown} focusId={focusId} nameOf={nameOf} empty="No reports here." render={(r) => <AdminActions key={r.id + (r.admin_reply ?? '')} r={r} />} />
      </Card>
    </div>
  )
}

function AdminActions({ r }: { r: UserReport }) {
  const invalidate = useInvalidate()
  const [reply, setReply] = useState(r.admin_reply ?? '')
  const [busy, setBusy] = useState(false)
  const save = async (status: ReportStatus) => {
    setBusy(true)
    try {
      unwrap(await db.from(USER_REPORTS).update({ status, admin_reply: reply.trim() || null }).eq('id', r.id))
      toast.success(`Saved — ${both(STATUS_LABEL[status])}. The user is notified.`)
      await invalidate(USER_REPORTS)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const changed = reply.trim() !== (r.admin_reply ?? '')
  return (
    <div className="space-y-2 pt-1">
      <Textarea rows={2} value={reply} maxLength={REPORT_LIMITS.reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to the user · Mjibu mtumiaji…" aria-label="Reply" />
      <div className="flex flex-wrap justify-end gap-1.5">
        {changed && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void save(r.status === 'open' ? 'in_review' : r.status)}>
            <Send className="size-4" /> Send reply · Tuma jibu
          </Button>
        )}
        {r.status !== 'in_review' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void save('in_review')}>
            In review
          </Button>
        )}
        {r.status !== 'resolved' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void save('resolved')}>
            <CheckCircle2 className="size-4" /> Resolved
          </Button>
        )}
        {r.status !== 'closed' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save('closed')}>
            Close
          </Button>
        )}
      </div>
    </div>
  )
}
