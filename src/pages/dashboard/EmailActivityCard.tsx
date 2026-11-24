/**
 * Admin Dashboard: company mailbox activity (ABCkit AI Email Intelligence).
 * Read-only summary of ai_emails / email_accounts / ai_email_drafts — visible to roles with `ai.email`
 * (firestore.rules enforce the same). Full detail, reply drafts and approval live on the AI page (Email tab).
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FileSignature, Gavel, Inbox, Mail, Receipt, Send } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, CardHeader, EmptyState, Skeleton } from '@/components/ui/misc'
import { db, unwrap } from '@/lib/backend'
import { cn, timeAgo } from '@/lib/utils'
import { AI_COLLECTIONS as C, EMAIL_CATEGORY_LABELS, type AiEmail, type AiEmailDraft, type EmailAccount, type EmailCategory } from '@/shared/ai/contract'
import { PriorityBadge } from '../ai/parts'

const WINDOW_DAYS = 7
const EMAIL_LINK = '/ai?tab=email'

type Row = Pick<AiEmail, 'id' | 'folder' | 'date' | 'from' | 'subject' | 'status' | 'ai' | 'is_demo'>

export function EmailActivityCard() {
  // same query-key prefixes as the AI module, so its invalidation refreshes this card too
  const emails = useQuery({
    queryKey: [C.emails, 'dashboard'],
    queryFn: async () => unwrap(await db.from(C.emails).select('id,folder,date,from,subject,status,ai,is_demo').order('date', { ascending: false }).limit(200)) as Row[],
    refetchInterval: 5 * 60_000,
  })
  const accounts = useQuery({ queryKey: [C.accounts, 'dashboard'], queryFn: async () => unwrap(await db.from(C.accounts).select('*')) as EmailAccount[] })
  const drafts = useQuery({
    queryKey: [C.drafts, 'dashboard', 'pending'],
    queryFn: async () => unwrap(await db.from(C.drafts).select('id,status').in('status', ['draft', 'approved'])) as Array<Pick<AiEmailDraft, 'id' | 'status'>>,
  })

  const stats = useMemo(() => {
    const since = Date.now() - WINDOW_DAYS * 86_400_000
    const inbox = (emails.data ?? []).filter((e) => e.folder === 'inbox' && Date.parse(e.date) >= since)
    const cat = (c: EmailCategory) => inbox.filter((e) => e.ai?.category === c).length
    const attention = inbox
      .filter((e) => e.ai && (e.ai.priority === 'urgent' || e.ai.priority === 'high' || e.ai.flags.suspicious_instructions))
      .sort((a, b) => rank(b) - rank(a) || b.date.localeCompare(a.date))
    return {
      received: inbox.length,
      urgent: inbox.filter((e) => e.ai?.priority === 'urgent').length,
      pending: inbox.filter((e) => e.status === 'new').length,
      quotations: cat('quotation'),
      tenders: cat('tender'),
      invoices: cat('invoice') + cat('payment_request'),
      attention: attention.slice(0, 5),
    }
  }, [emails.data])

  const live = (accounts.data ?? []).filter((a) => a.status !== 'disconnected')
  const loading = emails.isLoading || accounts.isLoading

  return (
    <Card className="xl:col-span-2">
      <CardHeader
        title="Company email activity"
        description={`AI-analysed mail, last ${WINDOW_DAYS} days`}
        actions={
          <Link to={EMAIL_LINK} className="text-xs font-semibold text-accent-ink hover:underline">
            Email Intelligence
          </Link>
        }
      />
      {loading ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-10" />
          <Skeleton className="h-24" />
        </div>
      ) : emails.isError ? (
        <EmptyState icon={<AlertTriangle className="size-6 text-warning" />} title="Email activity could not be loaded" />
      ) : live.length === 0 ? (
        <EmptyState
          icon={<Mail className="size-6" />}
          title="No company mailbox connected"
          description="Connect info@aricom.tz in AI → Settings → Mailboxes (IMAP / SMTP)."
        />
      ) : (
        <>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 text-xs sm:px-5">
            {live.map((a) => (
              <li key={a.id} className="flex items-center gap-1.5">
                <span className={cn('size-2 rounded-full', a.status === 'error' ? 'bg-danger' : a.status === 'syncing' ? 'bg-info' : 'bg-success')} />
                <span className="font-medium">{a.address}</span>
                <span className="text-muted">
                  {a.status === 'error' ? (a.last_sync_error ?? 'Sync error') : a.last_sync_at ? `synced ${timeAgo(a.last_sync_at)}` : 'waiting for first sync'}
                </span>
                {!a.sync_enabled && <Badge>Sync paused</Badge>}
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 sm:px-5 xl:grid-cols-6">
            <Tile icon={<Inbox />} label="Received" value={stats.received} hint={stats.pending ? `${stats.pending} awaiting AI` : undefined} />
            <Tile icon={<AlertTriangle />} label="Urgent" value={stats.urgent} alert={stats.urgent > 0} />
            <Tile icon={<FileSignature />} label="Quotations" value={stats.quotations} />
            <Tile icon={<Gavel />} label="Tenders" value={stats.tenders} />
            <Tile icon={<Receipt />} label="Invoices / payments" value={stats.invoices} />
            <Tile icon={<Send />} label="Replies to approve" value={drafts.data?.length ?? 0} alert={(drafts.data?.length ?? 0) > 0} />
          </div>
          {stats.attention.length === 0 ? (
            <p className="flex items-center gap-2 border-t border-border px-5 py-3 text-sm text-muted">
              <CheckCircle2 className="size-4 text-success" /> No urgent or high-priority email in the last {WINDOW_DAYS} days.
            </p>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {stats.attention.map((e) => (
                <li key={e.id} className="px-4 py-2.5 text-sm sm:px-5">
                  <Link to={EMAIL_LINK} className="block hover:underline-offset-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{e.subject || '(no subject)'}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {e.ai!.flags.suspicious_instructions && <Badge tone="danger">Suspicious</Badge>}
                        <PriorityBadge priority={e.ai!.priority} />
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {e.from.name || e.from.address} · {EMAIL_CATEGORY_LABELS[e.ai!.category] ?? e.ai!.category}
                      {e.ai!.related_project_name ? ` · ${e.ai!.related_project_name}` : ''}
                      {e.ai!.related_party.name ? ` · ${e.ai!.related_party.name}` : ''} · {timeAgo(e.date)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}

const rank = (e: Row) => (e.ai?.flags.suspicious_instructions ? 3 : e.ai?.priority === 'urgent' ? 2 : e.ai?.priority === 'high' ? 1 : 0)

function Tile({ icon, label, value, hint, alert }: { icon: React.ReactNode; label: string; value: number; hint?: string; alert?: boolean }) {
  return (
    <Link to={EMAIL_LINK} className={cn('flex items-center gap-2.5 rounded-lg border bg-surface p-2.5 transition-colors hover:border-accent', alert ? 'border-accent/50' : 'border-border')}>
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4', alert ? 'bg-accent text-black' : 'bg-surface-2 text-muted')}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] text-muted">{label}</span>
        <span className="block text-base font-bold leading-tight tabular">{value}</span>
        {hint && <span className="block truncate text-[10px] text-subtle">{hint}</span>}
      </span>
    </Link>
  )
}
