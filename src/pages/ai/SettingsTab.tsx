import { useQuery } from '@tanstack/react-query'
import { BookOpen, Check, Cloud, Database, KeyRound, Mail, Pencil, Plug, Plus, RefreshCw, Save, Server, ShieldCheck, Trash2, Unplug, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form'
import { Badge, Card, CardHeader, EmptyState, Skeleton, StatusBadge } from '@/components/ui/misc'
import { db, IS_DEMO, unwrap } from '@/lib/backend'
import { AI_COLLECTIONS, CHAT_PROVIDER_LABEL, CHAT_PROVIDERS, DEFAULT_AI_SETTINGS, type AiKnowledge, type AiSettings, type EmailAccount } from '@/shared/ai/contract'
import { errorMessage, formatDateTime, humanize, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { ActivityTable } from './ActivityTab'
import { AiApiKeys } from './AiApiKeys'
import { AiErrorNotice, DemoNote, NoAccess } from './parts'
import { C, useAiInvalidate, useAiSettings, useAiStatus, useCallable } from './useAi'

export function SettingsTab() {
  const { can } = useAuth()
  if (!can('ai.manage'))
    return <NoAccess title="AI Control Center" description="Connecting mailboxes, AI settings, the knowledge base and the audit log require the ai.manage permission." />
  return (
    <div className="space-y-4">
      {IS_DEMO && <DemoNote>Demo Mode: no mailbox or AI provider is ever contacted. Connecting accounts is disabled; everything else works on the demo data in this browser.</DemoNote>}
      <AiApiKeys />
      <EmailAccounts />
      <div className="grid gap-4 xl:grid-cols-2">
        <ProcessingStatus />
        <DataSources />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <PermissionsOverview />
        <EmailPermissions />
      </div>
      <SettingsForm />
      <KnowledgeBase />
      <Card>
        <CardHeader title="AI audit log" description="Latest AI actions. The full history with filters is in the Activity tab." actions={<Link to="/ai?tab=activity" className="text-xs font-medium text-accent-ink hover:underline">Open activity history</Link>} />
        <div className="p-3 sm:p-4">
          <ActivityTable limit={50} compact />
        </div>
      </Card>
    </div>
  )
}

// ----------------------------------------------------------------------------- email accounts

function EmailAccounts() {
  const call = useCallable()
  const invalidate = useAiInvalidate()
  const q = useQuery({ queryKey: [C.accounts, 'list'], queryFn: async () => unwrap(await db.from(C.accounts).select('*').order('connected_at')) as EmailAccount[] })
  const status = useAiStatus()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [imap, setImap] = useState(false)
  const [disconnect, setDisconnect] = useState<EmailAccount | null>(null)

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      if (success) toast.success(success)
      await invalidate(C.accounts, C.status, C.activity, C.emails)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const connectOAuth = (provider: 'gmail' | 'microsoft') =>
    run(provider, async () => {
      const { auth_url } = await call('emailConnectStart', { provider, return_url: `${window.location.origin}${window.location.pathname}` })
      if (!/^https:\/\//i.test(auth_url)) throw new Error('The server returned an invalid sign-in address')
      window.location.assign(auth_url)
    })

  const providers = status.data?.providers
  return (
    <Card>
      <CardHeader
        title="Email accounts"
        description="Company mailboxes synchronised for email intelligence. Credentials stay on the server (encrypted); the app never sees them."
        actions={
          <>
            <Button size="sm" onClick={() => connectOAuth('gmail')} loading={busy === 'gmail'}>
              <Mail /> Connect Gmail
            </Button>
            <Button size="sm" onClick={() => connectOAuth('microsoft')} loading={busy === 'microsoft'}>
              <Cloud /> Connect Microsoft 365
            </Button>
            <Button size="sm" onClick={() => setImap(true)}>
              <Server /> IMAP / SMTP
            </Button>
            <Button size="sm" variant="primary" onClick={() => run('sync', async () => {
              const r = await call('emailSyncNow', {})
              toast.success(`Sync finished: ${r.synced} new, ${r.analyzed} analysed${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`)
              if (r.errors.length) setError(new Error(r.errors.join(' · ')))
            })} loading={busy === 'sync'}>
              <RefreshCw /> Sync all now
            </Button>
          </>
        }
      />
      <div className="space-y-3 p-4 sm:p-5">
        {error ? <AiErrorNotice error={error} /> : null}
        {providers && (
          <p className="flex flex-wrap gap-2 text-xs text-muted">
            Server providers configured:
            {(['gmail', 'microsoft', 'imap'] as const).map((p) => (
              <Badge key={p} tone={providers[p] ? 'success' : 'neutral'}>
                {providers[p] ? <Check className="size-3" /> : <X className="size-3" />} {p === 'microsoft' ? 'Microsoft 365' : humanize(p)}
              </Badge>
            ))}
          </p>
        )}
        {q.isLoading ? (
          <Skeleton className="h-20" />
        ) : !q.data?.length ? (
          <EmptyState icon={<Plug className="size-6" />} title="No mailbox connected" description="Connect the company Gmail, Microsoft 365 or any IMAP mailbox to analyse incoming email." />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {q.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {a.address}
                    <Badge>{a.provider === 'microsoft' ? 'Microsoft 365' : humanize(a.provider)}</Badge>
                    <StatusBadge status={a.status === 'connected' ? 'active' : a.status === 'error' ? 'blocked' : a.status === 'syncing' ? 'in_progress' : 'cancelled'} />
                    <span className="text-xs font-normal text-muted">{humanize(a.status)}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {a.display_name ? `${a.display_name} · ` : ''}
                    {a.messages_synced} messages · last sync {a.last_sync_at ? timeAgo(a.last_sync_at) : 'never'} · connected {formatDateTime(a.connected_at)}
                  </p>
                  {a.last_sync_error && <p className="mt-0.5 text-xs text-danger">Last error: {a.last_sync_error}</p>}
                </div>
                {a.status !== 'disconnected' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Checkbox
                      label="Sync on"
                      checked={a.sync_enabled}
                      disabled={busy === `toggle-${a.id}`}
                      onChange={(e) => run(`toggle-${a.id}`, () => call('emailSetSync', { account_id: a.id, enabled: e.target.checked }), e.target.checked ? 'Synchronisation switched on' : 'Synchronisation paused')}
                    />
                    <Button size="sm" onClick={() => run(`sync-${a.id}`, async () => {
                      const r = await call('emailSyncNow', { account_id: a.id })
                      toast.success(`${a.address}: ${r.synced} new, ${r.analyzed} analysed`)
                      if (r.errors.length) setError(new Error(r.errors.join(' · ')))
                    })} loading={busy === `sync-${a.id}`}>
                      <RefreshCw /> Sync now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDisconnect(a)}>
                      <Unplug /> Disconnect
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ImapDialog open={imap} onOpenChange={setImap} onDone={() => invalidate(C.accounts, C.status)} />
      <ConfirmDialog
        open={!!disconnect}
        onOpenChange={(o) => !o && setDisconnect(null)}
        title="Disconnect mailbox?"
        message={`${disconnect?.address ?? ''} will stop synchronising and its stored credentials are deleted on the server. Already analysed emails stay available.`}
        confirmLabel="Disconnect"
        danger
        loading={busy === 'disconnect'}
        onConfirm={() => {
          const a = disconnect!
          setDisconnect(null)
          void run('disconnect', () => call('emailDisconnect', { account_id: a.id }), `${a.address} disconnected`)
        }}
      />
    </Card>
  )
}

/**
 * ARICOM's company mailbox is hosted on the company's own mail server (MX mail.aricom.tz, not Google Workspace),
 * so it connects over IMAP/SMTP. The certificate on mail.aricom.tz covers mail./smtp./pop.aricom.tz.
 */
const ARICOM_MAILBOX = { address: 'info@aricom.tz', display_name: 'ARICOM BUILDING CONTRACTORS LTD.', host: 'mail.aricom.tz' }
const aricomPreset = () => ({
  address: ARICOM_MAILBOX.address,
  display_name: ARICOM_MAILBOX.display_name,
  user: ARICOM_MAILBOX.address,
  imap_host: ARICOM_MAILBOX.host,
  imap_port: 993,
  imap_secure: true,
  smtp_host: ARICOM_MAILBOX.host,
  smtp_port: 465,
  smtp_secure: true,
})

function ImapDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const call = useCallable()
  const blank = { address: '', display_name: '', imap_host: '', imap_port: 993, imap_secure: true, smtp_host: '', smtp_port: 465, smtp_secure: true, user: '', password: '', smtp_user: '', smtp_password: '' }
  const [f, setF] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!open) {
      setF(blank)
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const set = (k: keyof typeof blank, v: string | number | boolean) => setF((x) => ({ ...x, [k]: v }))
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.address) && f.imap_host && f.smtp_host && f.user && f.password
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('emailConnectImap', {
        address: f.address.trim(),
        ...(f.display_name.trim() ? { display_name: f.display_name.trim() } : {}),
        imap: { host: f.imap_host.trim(), port: Number(f.imap_port), secure: f.imap_secure, user: f.user.trim(), password: f.password },
        smtp: { host: f.smtp_host.trim(), port: Number(f.smtp_port), secure: f.smtp_secure, user: (f.smtp_user || f.user).trim(), password: f.smtp_password || f.password },
      })
      toast.success('Mailbox connected — the first sync starts shortly')
      onDone()
      onOpenChange(false)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
      setF((x) => ({ ...x, password: '', smtp_password: '' }))
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Connect an IMAP / SMTP mailbox"
      description="The password is sent once to the server over HTTPS, stored encrypted, and never returned to the app."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!valid}>
            <KeyRound /> Connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <AiErrorNotice error={error} title="Could not connect the mailbox" /> : null}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-2 p-3 text-sm">
          <span className="text-muted">
            Company mailbox <strong className="text-foreground">{ARICOM_MAILBOX.address}</strong> on {ARICOM_MAILBOX.host} (IMAP 993 TLS, SMTP 465 TLS)
          </span>
          <Button size="sm" variant="outline" type="button" onClick={() => setF((x) => ({ ...x, ...aricomPreset() }))}>
            <Mail /> Use ARICOM settings
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email address" required>
            <Input type="email" value={f.address} onChange={(e) => set('address', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Display name">
            <Input value={f.display_name} onChange={(e) => set('display_name', e.target.value)} />
          </Field>
          <Field label="Username" required>
            <Input value={f.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password / app password" required>
            <Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_110px_auto]">
          <Field label="IMAP server" required>
            <Input value={f.imap_host} onChange={(e) => set('imap_host', e.target.value)} placeholder="imap.example.com" />
          </Field>
          <Field label="Port">
            <Input type="number" value={f.imap_port} onChange={(e) => set('imap_port', Number(e.target.value))} />
          </Field>
          <Checkbox className="self-end pb-2" label="TLS" checked={f.imap_secure} onChange={(e) => set('imap_secure', e.target.checked)} />
          <Field label="SMTP server (for sending approved replies)" required>
            <Input value={f.smtp_host} onChange={(e) => set('smtp_host', e.target.value)} placeholder="smtp.example.com" />
          </Field>
          <Field label="Port">
            <Input type="number" value={f.smtp_port} onChange={(e) => set('smtp_port', Number(e.target.value))} />
          </Field>
          <Checkbox className="self-end pb-2" label="TLS" checked={f.smtp_secure} onChange={(e) => set('smtp_secure', e.target.checked)} />
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Different SMTP login</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="SMTP username">
              <Input value={f.smtp_user} onChange={(e) => set('smtp_user', e.target.value)} autoComplete="off" />
            </Field>
            <Field label="SMTP password">
              <Input type="password" value={f.smtp_password} onChange={(e) => set('smtp_password', e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        </details>
      </div>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------- status

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  )
}

function ProcessingStatus() {
  const s = useAiStatus()
  const st = s.data
  return (
    <Card>
      <CardHeader title="Synchronisation & AI processing" description="Reported by the server (ai_status)." />
      <div className="divide-y divide-border px-4 py-2 sm:px-5">
        {s.isLoading ? (
          <Skeleton className="my-2 h-24" />
        ) : !st ? (
          <p className="py-3 text-sm text-muted">No status reported yet — the AI Cloud Functions have not run (are they deployed?).</p>
        ) : (
          <>
            <Row label="AI providers">
              {IS_DEMO ? (
                <Badge tone="warning">[DEMO] rule-based, no model</Badge>
              ) : (
                <span className="flex flex-wrap gap-1.5">
                  {CHAT_PROVIDERS.map((p) => (
                    <Badge key={p} tone={st.ai_providers?.[p] ? 'success' : 'danger'}>
                      {CHAT_PROVIDER_LABEL[p]}: {st.ai_providers?.[p] ? 'key set' : 'no key'}
                    </Badge>
                  ))}
                  {!st.ai_providers && (st.ai_configured ? <Badge tone="success">Configured</Badge> : <Badge tone="danger">Not configured (no API key on the server)</Badge>)}
                </span>
              )}
            </Row>
            <Row label="Last email sync">{st.last_sync_at ? `${formatDateTime(st.last_sync_at)} (${timeAgo(st.last_sync_at)})` : 'Never'}</Row>
            {st.last_sync_error && <Row label="Sync error"><span className="text-danger">{st.last_sync_error}</span></Row>}
            <Row label="Emails stored / waiting for analysis">
              {st.emails_total} / {st.emails_pending_analysis}
            </Row>
            <Row label="Last monitor run">
              {st.last_monitor_at ? `${formatDateTime(st.last_monitor_at)} · ${st.last_monitor_ok === false ? 'failed' : 'OK'}` : 'Never'}
            </Row>
            {st.last_monitor_error && <Row label="Monitor error"><span className="text-danger">{st.last_monitor_error}</span></Row>}
            <Row label="Open alerts">{st.alerts_open}</Row>
            <Row label="Status updated">{timeAgo(st.updated_at)}</Row>
          </>
        )}
      </div>
    </Card>
  )
}

const SOURCES: Array<{ module: string; perms: string[]; what: string }> = [
  { module: 'Projects & clients', perms: ['projects.view'], what: 'schedule, progress, dates' },
  { module: 'Tasks', perms: ['tasks.view'], what: 'open / overdue tasks (own tasks always)' },
  { module: 'BOQ', perms: ['boq.view'], what: 'BOQs awaiting approval' },
  { module: 'Site reports & safety', perms: ['site.view'], what: 'reported problems, incidents' },
  { module: 'Procurement', perms: ['procurement.view', 'procurement.request'], what: 'requests, purchase orders, deliveries' },
  { module: 'Inventory', perms: ['inventory.view', 'procurement.view', 'site.report'], what: 'low stock' },
  { module: 'Finance', perms: ['finance.view'], what: 'receivables, payables, budgets, transactions' },
  { module: 'Workforce & HR', perms: ['hr.view'], what: 'headcount, attendance, leave' },
  { module: 'Documents', perms: ['documents.view'], what: 'titles & descriptions (for search)' },
  { module: 'Email intelligence', perms: ['ai.email'], what: 'email summaries & bodies (untrusted)' },
  { module: 'Alerts, reports, knowledge base', perms: ['ai.view'], what: 'AI monitor alerts, saved reports, curated notes' },
]

function DataSources() {
  const { can } = useAuth()
  return (
    <Card>
      <CardHeader title="Connected data sources" description="What the assistant can read — always limited to what the asking user may open (Firestore security rules)." />
      <ul className="divide-y divide-border">
        {SOURCES.map((s) => {
          const ok = s.perms.some(can)
          return (
            <li key={s.module} className="flex items-center justify-between gap-3 px-4 py-2 sm:px-5">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  <Database className="mr-1.5 inline size-3.5 text-subtle" />
                  {s.module}
                </p>
                <p className="text-xs text-muted">
                  {s.what} · needs {s.perms.join(' or ')}
                </p>
              </div>
              <Badge tone={ok ? 'success' : 'neutral'}>{ok ? 'You: yes' : 'You: no'}</Badge>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

const AI_PERM_LIST = [
  { key: 'ai.view', label: 'AI dashboard, alerts, reports, assistant' },
  { key: 'ai.email', label: 'Read email intelligence, prepare drafts' },
  { key: 'ai.email_send', label: 'Approve & send replies' },
  { key: 'ai.manage', label: 'AI Control Center' },
]

function PermissionsOverview() {
  const q = useQuery({ queryKey: ['roles', 'ai-perms'], queryFn: async () => unwrap(await db.from('roles').select('id,key,name,perms').order('name')) as Array<{ id: string; key: string; name: string; perms: string[] }> })
  return (
    <Card>
      <CardHeader title="AI permissions by role" description="Change them in User Management → Roles & permissions." actions={<Link to="/users" className="text-xs font-medium text-accent-ink hover:underline">Manage roles</Link>} />
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Role</th>
              {AI_PERM_LIST.map((p) => (
                <th key={p.key} className="px-2 py-2 text-center font-mono text-[11px] font-semibold" title={p.label}>
                  {p.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-4 py-1.5 whitespace-nowrap">{r.name}</td>
                {AI_PERM_LIST.map((p) => {
                  const has = r.key === 'super_admin' || (r.perms ?? []).includes(p.key)
                  return (
                    <td key={p.key} className="px-2 py-1.5 text-center">
                      {has ? <Check className="mx-auto size-4 text-success" aria-label="yes" /> : <span className="text-subtle" aria-label="no">·</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {q.isLoading && <Skeleton className="m-4 h-24" />}
      </div>
    </Card>
  )
}

function EmailPermissions() {
  return (
    <Card>
      <CardHeader title="Email access & safety" />
      <ul className="space-y-2.5 px-4 py-3 text-sm sm:px-5">
        {[
          ['ai.email', 'Read synchronised emails, their AI summaries and attachments list; generate, edit, save and discard reply drafts.'],
          ['ai.email_send', 'Approve & Send a reviewed draft. Every send needs a confirmation that shows the recipients and is recorded in the audit log.'],
          ['ai.manage', 'Connect / disconnect mailboxes, pause synchronisation, AI settings, knowledge base, usage and the full audit log.'],
          ['—', 'The AI assistant has no tool that sends email: it can only prepare a draft. Email text is treated as untrusted; instructions inside emails are ignored and flagged.'],
          ['—', 'Mailbox passwords and OAuth tokens are stored encrypted on the server only; the app and the AI never see them.'],
        ].map(([k, v], i) => (
          <li key={i} className="flex gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
            <span>
              {k !== '—' && <code className="mr-1 rounded bg-surface-2 px-1 font-mono text-xs">{k}</code>}
              {v}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ----------------------------------------------------------------------------- settings form

const NOTIFY_LABELS: Record<keyof AiSettings['notify'], string> = {
  urgent_email: 'Urgent emails',
  client_complaint: 'Client complaints',
  project_behind_schedule: 'Projects behind schedule',
  payment_overdue: 'Overdue payments',
  supplier_delivery_issue: 'Supplier delivery issues',
  approval_pending: 'Approvals pending too long',
  risk: 'Other risks',
}

function SettingsForm() {
  const q = useAiSettings()
  const invalidate = useAiInvalidate()
  const [s, setS] = useState<AiSettings | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.data) setS(q.data.settings)
  }, [q.data])
  if (!s) return <Skeleton className="h-64" />
  const save = async () => {
    setBusy(true)
    const { id: _id, updated_at: _u, updated_by: _b, ...rest } = s
    const res = q.data?.exists ? await db.from(C.settings).update(rest).eq('id', 'settings') : await db.from(C.settings).insert({ ...rest, id: 'settings' })
    setBusy(false)
    if (res.error) return toast.error(errorMessage(res.error))
    toast.success('AI settings saved')
    await invalidate(C.settings)
  }
  return (
    <Card>
      <CardHeader title="AI behaviour & notifications" description={q.data?.settings.updated_at ? `Last changed ${formatDateTime(q.data.settings.updated_at)}` : 'Using the default settings'} />
      <div className="grid gap-6 p-4 sm:p-5 lg:grid-cols-2">
        <div className="space-y-3">
          <Checkbox label="AI features enabled (assistant, reports, analysis)" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
          <Checkbox label="Email synchronisation enabled" checked={s.email_sync_enabled} onChange={(e) => setS({ ...s, email_sync_enabled: e.target.checked })} />
          <Checkbox label="Low-stock alerts" checked={s.low_stock_alerts} onChange={(e) => setS({ ...s, low_stock_alerts: e.target.checked })} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Schedule slip (%)" hint="progress behind time elapsed">
              <Input type="number" min={0} max={100} value={s.schedule_slip_threshold_pct} onChange={(e) => setS({ ...s, schedule_slip_threshold_pct: Number(e.target.value) })} />
            </Field>
            <Field label="Approval reminder (days)">
              <Input type="number" min={0} max={60} value={s.approval_stale_days} onChange={(e) => setS({ ...s, approval_stale_days: Number(e.target.value) })} />
            </Field>
            <Field label="Daily AI limit / user" hint="chat + report calls">
              <Input type="number" min={0} max={10000} value={s.daily_chat_limit_per_user} onChange={(e) => setS({ ...s, daily_chat_limit_per_user: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Assistant providers (in order)</p>
            <p className="mb-2 text-xs text-muted">The first provider with an API key answers; the next ones are used only if it fails. Reports, email analysis and replies use Claude (phase 1).</p>
            <ol className="space-y-1">
              {[...s.chat_providers, ...CHAT_PROVIDERS.filter((p) => !s.chat_providers.includes(p))].map((p) => {
                const on = s.chat_providers.includes(p)
                const i = s.chat_providers.indexOf(p)
                const move = (d: -1 | 1) => {
                  const list = [...s.chat_providers]
                  ;[list[i], list[i + d]] = [list[i + d], list[i]]
                  setS({ ...s, chat_providers: list })
                }
                return (
                  <li key={p} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      checked={on}
                      disabled={on && s.chat_providers.length === 1}
                      onChange={(e) => setS({ ...s, chat_providers: e.target.checked ? [...s.chat_providers, p] : s.chat_providers.filter((x) => x !== p) })}
                      aria-label={`Use ${CHAT_PROVIDER_LABEL[p]}`}
                    />
                    <span className={on ? 'font-medium' : 'text-muted'}>{on ? `${i + 1}. ` : ''}{CHAT_PROVIDER_LABEL[p]}</span>
                    {on && (
                      <span className="ml-auto flex gap-1">
                        <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => move(-1)} aria-label={`Move ${CHAT_PROVIDER_LABEL[p]} up`}>↑</Button>
                        <Button size="icon-sm" variant="ghost" disabled={i === s.chat_providers.length - 1} onClick={() => move(1)} aria-label={`Move ${CHAT_PROVIDER_LABEL[p]} down`}>↓</Button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Checkbox label="Live voice (OpenAI Realtime)" checked={s.voice_enabled} onChange={(e) => setS({ ...s, voice_enabled: e.target.checked })} />
              <Field label="Live voice conversations / user / day">
                <Input type="number" min={0} max={1000} value={s.daily_voice_sessions_per_user} onChange={(e) => setS({ ...s, daily_voice_sessions_per_user: Number(e.target.value) })} />
              </Field>
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Notify management about</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(DEFAULT_AI_SETTINGS.notify) as Array<keyof AiSettings['notify']>).map((k) => (
                <Checkbox key={k} label={NOTIFY_LABELS[k]} checked={s.notify[k]} onChange={(e) => setS({ ...s, notify: { ...s.notify, [k]: e.target.checked } })} />
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Reply signature" hint="Appended to generated replies">
            <Textarea rows={3} maxLength={2000} value={s.reply_signature} onChange={(e) => setS({ ...s, reply_signature: e.target.value })} />
          </Field>
          <Field label="Company style notes" hint="Tone and house style for the reply writer">
            <Textarea rows={4} maxLength={4000} value={s.company_style_notes} onChange={(e) => setS({ ...s, company_style_notes: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="flex justify-end border-t border-border px-4 py-3">
        <Button variant="primary" onClick={save} loading={busy}>
          <Save /> Save settings
        </Button>
      </div>
    </Card>
  )
}

// ----------------------------------------------------------------------------- knowledge base

function KnowledgeBase() {
  const invalidate = useAiInvalidate()
  const q = useQuery({ queryKey: [AI_COLLECTIONS.knowledge, 'list'], queryFn: async () => unwrap(await db.from(C.knowledge).select('*').order('updated_at', { ascending: false })) as AiKnowledge[] })
  const [edit, setEdit] = useState<Partial<AiKnowledge> | null>(null)
  const [remove, setRemove] = useState<AiKnowledge | null>(null)
  const [busy, setBusy] = useState(false)
  const [tags, setTags] = useState('')
  useEffect(() => setTags((edit?.tags ?? []).join(', ')), [edit])

  const save = async () => {
    if (!edit) return
    setBusy(true)
    const values = { title: edit.title ?? '', body: edit.body ?? '', kind: edit.kind ?? 'note', tags: tags.split(',').map((t) => t.trim()).filter(Boolean), ...(edit.id ? {} : { is_demo: IS_DEMO }) }
    const res = edit.id ? await db.from(C.knowledge).update(values).eq('id', edit.id) : await db.from(C.knowledge).insert(values)
    setBusy(false)
    if (res.error) return toast.error(errorMessage(res.error))
    toast.success('Knowledge note saved')
    setEdit(null)
    await invalidate(C.knowledge)
  }

  return (
    <Card>
      <CardHeader
        title="Knowledge base"
        description="Curated company knowledge (profile, policies, decisions) the assistant can search. Readable by everyone with AI access."
        actions={
          <Button size="sm" variant="primary" onClick={() => setEdit({ kind: 'note', tags: [] })}>
            <Plus /> Add note
          </Button>
        }
      />
      {q.isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : !q.data?.length ? (
        <EmptyState icon={<BookOpen className="size-6" />} title="No knowledge notes" description="Add the company profile, policies and key decisions so the assistant can use them." />
      ) : (
        <ul className="divide-y divide-border">
          {q.data.map((k) => (
            <li key={k.id} className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {k.title} <Badge>{humanize(k.kind)}</Badge>
                  {k.tags.map((t) => (
                    <Badge key={t} tone="info">
                      {t}
                    </Badge>
                  ))}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted">{k.body}</p>
                <p className="mt-0.5 text-[11px] text-subtle">Updated {timeAgo(k.updated_at)}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${k.title}`} onClick={() => setEdit(k)}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${k.title}`} onClick={() => setRemove(k)}>
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={!!edit}
        onOpenChange={(o) => !o && setEdit(null)}
        title={edit?.id ? 'Edit knowledge note' : 'New knowledge note'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={busy} disabled={!edit?.title?.trim()}>
              <Save /> Save
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <Field label="Title" required>
                <Input value={edit.title ?? ''} maxLength={200} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              </Field>
              <Field label="Kind">
                <Select value={edit.kind ?? 'note'} onChange={(e) => setEdit({ ...edit, kind: e.target.value as AiKnowledge['kind'] })}>
                  <option value="company">Company</option>
                  <option value="policy">Policy</option>
                  <option value="decision">Decision</option>
                  <option value="note">Note</option>
                </Select>
              </Field>
            </div>
            <Field label="Tags" hint="comma-separated, e.g. procurement, safety">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
            <Field label="Text">
              <Textarea rows={10} maxLength={100000} value={edit.body ?? ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title="Delete knowledge note?"
        message={`“${remove?.title ?? ''}” will no longer be used by the assistant.`}
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          const k = remove!
          setRemove(null)
          const { error } = await db.from(C.knowledge).delete().eq('id', k.id)
          if (error) return toast.error(errorMessage(error))
          toast.success('Note deleted')
          await invalidate(C.knowledge)
        }}
      />
    </Card>
  )
}
