import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Filter,
  Mail,
  Paperclip,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form'
import { Badge, Card, CardHeader, EmptyState, ErrorState, KeyValue, Skeleton, StatusBadge } from '@/components/ui/misc'
import { db, IS_DEMO, unwrap } from '@/lib/backend'
import { useDebounced } from '@/lib/hooks'
import { EMAIL_CATEGORIES, EMAIL_CATEGORY_LABELS, PRIORITIES, type AiEmail, type AiEmailDraft, type EmailAccount, type EmailParty } from '@/shared/ai/contract'
import { cn, errorMessage, formatDate, formatDateTime, humanize } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AiErrorNotice, DemoNote, NoAccess, PriorityBadge, Untrusted } from './parts'
import { C, useAiInvalidate, useCallable } from './useAi'

const party = (p: EmailParty | null | undefined) => (p ? (p.name ? `${p.name} <${p.address}>` : p.address) : '—')
const partiesText = (list: EmailParty[] | null | undefined) => (list ?? []).map(party).join(', ')
const EMAIL_RE = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/

/** "Name <a@b.c>, x@y.z" → parties (null when an address is invalid) */
export function parseParties(text: string): EmailParty[] | null {
  const parts = text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)
  const out: EmailParty[] = []
  for (const p of parts) {
    const m = p.match(/^(.*?)<([^>]+)>$/)
    const address = (m ? m[2] : p).trim()
    if (!EMAIL_RE.test(address)) return null
    out.push({ name: m ? m[1].trim().replace(/^"|"$/g, '') || null : null, address })
  }
  return out
}

function useEmails() {
  return useQuery({
    queryKey: [C.emails, 'list'],
    queryFn: async () => unwrap(await db.from(C.emails).select('*').order('date', { ascending: false }).limit(500)) as AiEmail[],
  })
}

function useSentDrafts() {
  return useQuery({
    queryKey: [C.drafts, 'sent'],
    queryFn: async () => unwrap(await db.from(C.drafts).select('id,email_id,status').eq('status', 'sent')) as Array<Pick<AiEmailDraft, 'id' | 'email_id' | 'status'>>,
  })
}

export function EmailTab() {
  const { can } = useAuth()
  if (!can('ai.email'))
    return (
      <NoAccess
        title="Email Intelligence is not part of your role"
        description="Reading company email summaries requires the ai.email permission. Ask an administrator to grant it in User Management → Roles & permissions."
      />
    )
  return <EmailWorkspace />
}

function EmailWorkspace() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('email')
  const emails = useEmails()
  const sentDrafts = useSentDrafts()
  const accounts = useQuery({ queryKey: [C.accounts, 'list'], queryFn: async () => unwrap(await db.from(C.accounts).select('*')) as EmailAccount[] })

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState(params.get('category') ?? '')
  const [priority, setPriority] = useState('')
  const [important, setImportant] = useState(params.get('important') === '1')
  const [account, setAccount] = useState('')
  const [folder, setFolder] = useState<'inbox' | 'sent' | 'any'>('inbox')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const term = useDebounced(search.trim().toLowerCase(), 200)

  const answered = useMemo(() => {
    const set = new Set((sentDrafts.data ?? []).map((d) => d.email_id))
    const all = emails.data ?? []
    const sent = all.filter((e) => e.folder === 'sent')
    for (const e of all)
      if (e.folder === 'inbox' && sent.some((s) => (e.message_id_header && s.in_reply_to === e.message_id_header) || (e.thread_id && s.thread_id === e.thread_id && s.date > e.date))) set.add(e.id)
    return set
  }, [emails.data, sentDrafts.data])

  const rows = useMemo(() => {
    const rank = (p: unknown) => PRIORITIES.indexOf(p as never)
    return (emails.data ?? []).filter((e) => {
      if (folder !== 'any' && e.folder !== folder) return false
      if (category && e.ai?.category !== category && !(category === 'client' && e.ai?.related_party?.type === 'client')) return false
      if (priority && rank(e.ai?.priority) < rank(priority)) return false
      if (important && !e.ai?.is_important) return false
      if (account && e.account_id !== account) return false
      if (from && e.date.slice(0, 10) < from) return false
      if (to && e.date.slice(0, 10) > to) return false
      if (term) {
        const hay = `${e.subject} ${party(e.from)} ${e.ai?.summary ?? e.snippet} ${e.ai?.related_project_name ?? ''}`.toLowerCase()
        if (!hay.includes(term)) return false
      }
      return true
    })
  }, [emails.data, folder, category, priority, important, account, from, to, term])

  const current = (emails.data ?? []).find((e) => e.id === selected) ?? null
  const select = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('email', id)
    else next.delete('email')
    setParams(next, { replace: !id })
  }
  const activeFilters = [category, priority, important, account, from, to, folder !== 'inbox'].filter(Boolean).length

  if (emails.error) return <ErrorState error={emails.error} onRetry={() => emails.refetch()} />

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
      {/* list */}
      <Card className={cn('flex min-h-[60vh] flex-col', selected && 'hidden lg:flex')}>
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search subject, sender, summary" className="pl-9" aria-label="Search emails" />
            </div>
            <Button variant={activeFilters ? 'dark' : 'outline'} size="icon" onClick={() => setShowFilters((v) => !v)} aria-label="Filters" aria-expanded={showFilters}>
              <Filter />
            </Button>
          </div>
          {showFilters && (
            <div className="grid grid-cols-2 gap-2">
              <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
                <option value="">All categories</option>
                {EMAIL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {EMAIL_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
              <Select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Minimum priority">
                <option value="">Any priority</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {humanize(p)}+
                  </option>
                ))}
              </Select>
              <Select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
                <option value="">All accounts</option>
                {(accounts.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.address}
                  </option>
                ))}
              </Select>
              <Select value={folder} onChange={(e) => setFolder(e.target.value as typeof folder)} aria-label="Folder">
                <option value="inbox">Inbox</option>
                <option value="sent">Sent</option>
                <option value="any">All folders</option>
              </Select>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
              <Checkbox label="Important only" checked={important} onChange={(e) => setImportant(e.target.checked)} />
              {activeFilters > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCategory('')
                    setPriority('')
                    setImportant(false)
                    setAccount('')
                    setFolder('inbox')
                    setFrom('')
                    setTo('')
                  }}
                >
                  <X /> Clear filters
                </Button>
              )}
            </div>
          )}
          <p className="text-xs text-muted">
            {rows.length} of {(emails.data ?? []).length} emails · <span className="font-medium">external content — treated as untrusted</span>
          </p>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {emails.isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={<Mail className="size-6" />} title="No emails" description={(emails.data ?? []).length ? 'No email matches these filters.' : 'Connect a mailbox in AI Settings to start email intelligence.'} />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((e) => (
                <li key={e.id}>
                  <button
                    onClick={() => select(e.id)}
                    className={cn('block w-full px-3 py-2.5 text-left transition-colors hover:bg-surface-2', selected === e.id && 'bg-accent-soft/60')}
                  >
                    <div className="flex items-center gap-2">
                      {e.ai?.is_important && <Star className="size-3.5 shrink-0 fill-accent text-accent" aria-label="Important" />}
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold">{e.folder === 'sent' ? `To: ${partiesText(e.to)}` : (e.from?.name ?? e.from?.address)}</span>
                      <span className="shrink-0 text-[11px] text-subtle">{formatDate(e.date, 'dd MMM HH:mm')}</span>
                    </div>
                    <p className={cn('mt-0.5 truncate text-sm', !answered.has(e.id) && e.folder === 'inbox' && 'font-medium')}>{e.subject}</p>
                    <p className="mt-0.5 line-clamp-1 text-xs text-muted">{e.ai?.summary ?? e.snippet}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {e.ai ? <PriorityBadge priority={e.ai.priority} /> : <StatusBadge status={e.status} />}
                      {e.ai && <Badge>{EMAIL_CATEGORY_LABELS[e.ai.category] ?? e.ai.category}</Badge>}
                      {e.ai?.flags?.suspicious_instructions && (
                        <Badge tone="danger">
                          <ShieldAlert className="size-3" /> Suspicious
                        </Badge>
                      )}
                      {e.folder === 'inbox' && answered.has(e.id) && (
                        <Badge tone="success">
                          <CheckCircle2 className="size-3" /> Answered
                        </Badge>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* detail */}
      <div className={cn(!selected && 'hidden lg:block')}>
        {selected && !current && !emails.isLoading ? (
          <Card>
            <EmptyState title="Email not found" description="It may have been removed or you no longer have access." action={<Button onClick={() => select(null)}>Back to list</Button>} />
          </Card>
        ) : current ? (
          <EmailDetail email={current} all={emails.data ?? []} answered={answered.has(current.id)} onBack={() => select(null)} onOpen={select} />
        ) : (
          <Card className="hidden lg:block">
            <EmptyState icon={<Mail className="size-6" />} title="Select an email" description="The AI summary, required action, related project and reply drafts appear here." />
          </Card>
        )}
      </div>
    </div>
  )
}

function EmailDetail({ email: e, all, answered, onBack, onOpen }: { email: AiEmail; all: AiEmail[]; answered: boolean; onBack: () => void; onOpen: (id: string) => void }) {
  const call = useCallable()
  const invalidate = useAiInvalidate()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [replyOpen, setReplyOpen] = useState(false)
  const ai = e.ai
  const thread = all.filter((x) => x.thread_id && x.thread_id === e.thread_id && x.id !== e.id).sort((a, b) => a.date.localeCompare(b.date))
  const drafts = useQuery({
    queryKey: [C.drafts, 'email', e.id],
    queryFn: async () => unwrap(await db.from(C.drafts).select('*').eq('email_id', e.id).order('created_at', { ascending: false })) as AiEmailDraft[],
  })

  const reanalyse = async () => {
    setBusy('analyse')
    setError(null)
    try {
      await call('emailAnalyze', { email_id: e.id })
      await invalidate(C.emails)
      toast.success(IS_DEMO ? '[DEMO] Re-analysis requested — the stored analysis is kept (no AI model in Demo Mode)' : 'Email re-analysed')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <Button variant="ghost" size="sm" className="-ml-2 mb-1 lg:hidden" onClick={onBack}>
              <ArrowLeft /> Back
            </Button>
            <h2 className="text-base font-semibold break-words">{e.subject}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {formatDateTime(e.date)} · {e.folder === 'sent' ? 'Sent' : 'Inbox'} · <StatusBadge status={e.status} />
              {e.folder === 'inbox' && (answered ? <Badge tone="success" className="ml-1">Answered</Badge> : <Badge tone="warning" className="ml-1">Not answered</Badge>)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={reanalyse} loading={busy === 'analyse'} disabled={e.folder !== 'inbox'}>
              <RefreshCw /> Re-analyse
            </Button>
            <Button size="sm" variant="primary" onClick={() => setReplyOpen(true)} disabled={e.folder !== 'inbox'}>
              <Sparkles /> Generate reply
            </Button>
          </div>
        </div>
        <div className="space-y-4 p-4 sm:p-5">
          {error ? <AiErrorNotice error={error} /> : null}
          <KeyValue
            items={[
              { label: 'From', value: party(e.from) },
              { label: 'To', value: partiesText(e.to) || '—' },
              ...(e.cc?.length ? [{ label: 'Cc', value: partiesText(e.cc) }] : []),
              { label: 'Date', value: formatDateTime(e.date) },
            ]}
          />
          {ai?.flags?.suspicious_instructions && (
            <div role="alert" className="flex gap-2 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <p>
                <strong>Suspicious instructions detected.</strong> This email tries to instruct the AI or asks for unusual actions (e.g. changed bank details). The assistant ignores such
                instructions — verify by phone with a known contact before acting.
              </p>
            </div>
          )}
          {ai ? (
            <div className="rounded-lg border border-accent/30 bg-accent-soft/30 p-3 sm:p-4">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-accent-ink">
                <Bot className="size-3.5" /> AI analysis{IS_DEMO ? ' [DEMO]' : ''}
                <span className="font-normal normal-case text-subtle">
                  · {ai.model} · {Math.round((ai.confidence ?? 0) * 100)}% confidence
                </span>
              </p>
              <p className="text-sm">{ai.summary}</p>
              <div className="mt-3">
                <KeyValue
                  cols={2}
                  items={[
                    { label: 'Main message', value: ai.main_message },
                    { label: 'Required action', value: ai.required_action ?? 'None' },
                    { label: 'Responsible', value: ai.responsible_person ?? '—' },
                    { label: 'Deadline', value: ai.deadline ? formatDate(ai.deadline) : '—' },
                    { label: 'Priority', value: <PriorityBadge priority={ai.priority} /> },
                    { label: 'Category', value: EMAIL_CATEGORY_LABELS[ai.category] ?? ai.category },
                    {
                      label: 'Related project',
                      value: ai.related_project_id ? (
                        <Link className="font-medium text-accent-ink hover:underline" to={`/projects/${ai.related_project_id}`}>
                          {ai.related_project_name ?? 'Open project'}
                        </Link>
                      ) : (
                        (ai.related_project_name ?? '—')
                      ),
                    },
                    { label: 'Related party', value: ai.related_party?.name ? `${ai.related_party.name}${ai.related_party.type ? ` (${ai.related_party.type})` : ''}` : '—' },
                    { label: 'Suggested response', value: ai.suggested_response ?? '—' },
                    { label: 'Language', value: ai.language === 'sw' ? 'Kiswahili' : ai.language === 'en' ? 'English' : 'Other' },
                  ]}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {Object.entries(ai.flags ?? {})
                  .filter(([, v]) => v)
                  .map(([k]) => (
                    <Badge key={k} tone={k === 'suspicious_instructions' || k === 'complaint' ? 'danger' : 'info'}>
                      {humanize(k)}
                    </Badge>
                  ))}
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted">
              {e.status === 'error' ? `Analysis failed: ${e.error ?? 'unknown error'}` : e.folder === 'sent' ? 'Sent emails are not analysed.' : 'Not analysed yet — use Re-analyse.'}
            </p>
          )}
          {e.attachments?.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Attachments</p>
              <ul className="flex flex-wrap gap-2">
                {e.attachments.map((a, i) => (
                  <li key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                    <Paperclip className="size-3.5 text-subtle" /> {a.name} <span className="text-subtle">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <Untrusted>Original message — external content, shown as plain text</Untrusted>
            <div className="scrollbar-thin mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2/50 p-3 text-sm">{e.body_text || e.snippet}</div>
            {e.body_truncated && <p className="mt-1 text-xs text-subtle">Message truncated — open it in the mailbox for the full text.</p>}
          </div>
          {thread.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Conversation ({thread.length + 1})</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {thread.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => onOpen(t.id)} className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2">
                      <span className="font-medium">{t.folder === 'sent' ? 'You' : (t.from?.name ?? t.from?.address)}</span> <span className="text-xs text-subtle">· {formatDateTime(t.date)}</span>
                      <p className="line-clamp-1 text-xs text-muted">{t.ai?.summary ?? t.snippet}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Reply drafts" description="Drafts are never sent automatically. A person with send permission must review and approve each reply." />
        <div className="space-y-4 p-4 sm:p-5">
          {IS_DEMO && <DemoNote>Demo Mode: replies are template-based and “sending” only marks the draft as sent — nothing leaves your browser.</DemoNote>}
          {drafts.isLoading ? (
            <Skeleton className="h-24" />
          ) : !drafts.data?.length ? (
            <p className="text-sm text-muted">No reply drafts yet. Use “Generate reply”.</p>
          ) : (
            drafts.data.map((d) => <DraftEditor key={d.id} draft={d} />)
          )}
        </div>
      </Card>

      <GenerateReplyDialog email={e} open={replyOpen} onOpenChange={setReplyOpen} />
    </div>
  )
}

function GenerateReplyDialog({ email, open, onOpenChange }: { email: AiEmail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const call = useCallable()
  const invalidate = useAiInvalidate()
  const [language, setLanguage] = useState<'en' | 'sw'>(email.ai?.language === 'sw' ? 'sw' : 'en')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (open) {
      setLanguage(email.ai?.language === 'sw' ? 'sw' : 'en')
      setError(null)
    }
  }, [open, email.ai?.language])
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('emailGenerateReply', { email_id: email.id, language, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) })
      await invalidate(C.drafts, C.activity)
      toast.success('Reply draft created — it has not been sent')
      setInstructions('')
      onOpenChange(false)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate reply draft"
      description="The AI writes a draft from this email and its analysis. Nothing is sent."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={go}>
            <Sparkles /> Generate draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <AiErrorNotice error={error} title="Could not generate the reply" /> : null}
        <Field label="Language">
          <Select value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'sw')}>
            <option value="en">English</option>
            <option value="sw">Kiswahili</option>
          </Select>
        </Field>
        <Field label="Instructions (optional)" hint="e.g. confirm the meeting, ask for a revised quotation, keep it short">
          <Textarea rows={3} maxLength={1000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  )
}

function DraftEditor({ draft: d }: { draft: AiEmailDraft }) {
  const { can } = useAuth()
  const call = useCallable()
  const invalidate = useAiInvalidate()
  const editable = d.status === 'draft'
  const [subject, setSubject] = useState(d.subject)
  const [toText, setToText] = useState(partiesText(d.to))
  const [ccText, setCcText] = useState(partiesText(d.cc))
  const [body, setBody] = useState(d.body)
  const [language, setLanguage] = useState(d.language)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'send' | 'discard' | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    setSubject(d.subject)
    setToText(partiesText(d.to))
    setCcText(partiesText(d.cc))
    setBody(d.body)
    setLanguage(d.language)
  }, [d.subject, d.to, d.cc, d.body, d.language])
  const toList = parseParties(toText)
  const ccList = parseParties(ccText)
  const dirty = subject !== d.subject || body !== d.body || language !== d.language || toText !== partiesText(d.to) || ccText !== partiesText(d.cc)

  const save = async (quiet = false) => {
    if (!toList?.length) throw new Error('Enter at least one valid recipient email address')
    if (ccList === null) throw new Error('A Cc address is not a valid email address')
    unwrap(await db.from(C.drafts).update({ subject, body, language, to: toList, cc: ccList }).eq('id', d.id).select().single())
    await invalidate(C.drafts)
    if (!quiet) toast.success('Draft saved')
  }
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e)
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge status={d.status} />
          <span className="text-muted">
            {d.ai_generated ? 'AI draft' : 'Template draft'} · {d.language === 'sw' ? 'Kiswahili' : 'English'} · updated {formatDateTime(d.updated_at)}
          </span>
        </div>
        {d.status === 'sent' && (
          <span className="text-xs text-success">
            Sent {formatDateTime(d.sent_at)}
            {(d as AiEmailDraft & { demo_note?: string }).demo_note ? ` — ${(d as AiEmailDraft & { demo_note?: string }).demo_note}` : ''}
          </span>
        )}
        {d.status === 'failed' && <span className="text-xs text-danger">Failed: {d.error}</span>}
      </div>
      <div className="space-y-3 p-3">
        {error ? <AiErrorNotice error={error} title="Action failed" /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="To" error={editable && toList === null ? 'Invalid address' : undefined}>
            <Input value={toText} onChange={(e) => setToText(e.target.value)} disabled={!editable} />
          </Field>
          <Field label="Cc" error={editable && ccList === null ? 'Invalid address' : undefined}>
            <Input value={ccText} onChange={(e) => setCcText(e.target.value)} disabled={!editable} placeholder="optional" />
          </Field>
          <Field label="Subject" className="sm:col-span-2">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!editable} maxLength={300} />
          </Field>
        </div>
        <Field label="Reply">
          <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} className="font-[inherit]" />
        </Field>
        {editable && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'sw')} className="w-36" aria-label="Language">
              <option value="en">English</option>
              <option value="sw">Kiswahili</option>
            </Select>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirm('discard')} disabled={!!busy}>
                <Trash2 /> Discard
              </Button>
              <Button size="sm" onClick={() => run('save', () => save())} loading={busy === 'save'} disabled={!dirty}>
                <Save /> Save draft
              </Button>
              {can('ai.email_send') ? (
                <Button size="sm" variant="primary" onClick={() => setConfirm('send')} disabled={!!busy || !toList?.length || ccList === null}>
                  <Send /> Approve &amp; Send
                </Button>
              ) : (
                <span className="self-center text-xs text-muted">Sending needs the ai.email_send permission</span>
              )}
            </div>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirm === 'discard'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Discard this draft?"
        message="The draft is kept for the audit trail but can no longer be edited or sent."
        confirmLabel="Discard"
        danger
        loading={busy === 'discard'}
        onConfirm={() =>
          run('discard', async () => {
            unwrap(await db.from(C.drafts).update({ status: 'discarded' }).eq('id', d.id))
            await invalidate(C.drafts)
            toast.success('Draft discarded')
          })
        }
      />
      <ConfirmDialog
        open={confirm === 'send'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={IS_DEMO ? 'Approve & send ([DEMO] — nothing is really sent)' : 'Approve & send this reply?'}
        confirmLabel={IS_DEMO ? 'Mark as sent' : 'Approve & Send'}
        loading={busy === 'send'}
        message={
          <div className="space-y-2">
            <p>You are approving this reply. It will be sent from the connected company mailbox to:</p>
            <ul className="list-disc pl-5 text-foreground">
              {(toList ?? []).map((p) => (
                <li key={p.address}>To: {party(p)}</li>
              ))}
              {(ccList ?? []).map((p) => (
                <li key={p.address}>Cc: {party(p)}</li>
              ))}
            </ul>
            <p>
              Subject: <span className="text-foreground">{subject}</span>
            </p>
            {dirty && <p className="text-warning">Your unsaved changes will be saved first.</p>}
          </div>
        }
        onConfirm={() =>
          run('send', async () => {
            if (dirty) await save(true)
            await call('emailSendDraft', { draft_id: d.id })
            await invalidate(C.drafts, C.emails, C.activity)
            toast.success(IS_DEMO ? '[DEMO] Marked as sent — nothing was actually sent' : 'Reply sent')
          })
        }
      />
    </div>
  )
}
