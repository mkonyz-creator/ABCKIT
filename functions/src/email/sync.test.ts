import { describe, expect, it } from 'vitest'
import type { EmailAccount } from '../shared/ai/contract.js'
import { alertsToNotify, runMonitor, upsertAlerts } from '../ai/monitorRun.js'
import { mergeSettings } from '../lib/audit.js'
import { FakeDb, seedUser } from '../test/fakeFirestore.js'
import { fakeClaude } from '../test/fakeClaude.js'
import { ProviderAuthError } from './http.js'
import type { ParsedMessage } from './message.js'
import type { MailSession } from './provider.js'
import { syncAll } from './sync.js'

const ACC: EmailAccount = {
  id: 'gmail-0123456789abcdef',
  provider: 'gmail',
  address: 'office@aricom.co.tz',
  display_name: null,
  status: 'connected',
  sync_enabled: true,
  connected_by: 'admin',
  connected_at: '2026-11-01T00:00:00Z',
  last_sync_at: null,
  last_sync_error: null,
  cursor: null,
  messages_synced: 0,
  is_demo: false,
}

const T0 = Date.now() - 3600_000
const msg = (id: string, folder: 'inbox' | 'sent', offset: number): ParsedMessage => ({
  provider_message_id: id,
  thread_id: 't1',
  folder,
  from: { name: null, address: 'orders@simba.co.tz' },
  to: [{ name: null, address: ACC.address }],
  cc: [],
  subject: `Subject ${id}`,
  date: new Date(T0 + offset).toISOString(),
  snippet: '',
  body_text: 'Delivery will be late',
  body_truncated: false,
  attachments: [],
  message_id_header: `<${id}@x>`,
  in_reply_to: null,
  references: null,
  cursor: T0 + offset,
})

const insight = {
  category: 'supplier',
  priority: 'urgent',
  is_important: true,
  summary: 'Urgent supplier issue',
  main_message: 'x',
  required_action: null,
  responsible_person: null,
  deadline: null,
  related_project_id: null,
  related_project_name: null,
  related_party: { type: null, id: null, name: null },
  suggested_response: null,
  language: 'en',
  flags: { complaint: false, delivery_issue: false, payment_related: false, approval_request: false, meeting_request: false, suspicious_instructions: false },
  confidence: 0.8,
}

function session(inbox: ParsedMessage[], sent: ParsedMessage[], opts: { failOn?: 'inbox' | 'sent' } = {}): MailSession & { cursors: unknown[] } {
  const cursors: unknown[] = []
  return {
    provider: 'gmail',
    cursors,
    fetchNew: async (folder, cursor) => {
      cursors.push(cursor)
      if (opts.failOn === folder) throw new ProviderAuthError('Token refresh: the mailbox authorisation was revoked or expired — reconnect the account')
      const list = (folder === 'inbox' ? inbox : sent).filter((m) => Number(m.cursor) > Number(cursor ?? 0))
      return { messages: list, nextCursor: list.length ? Math.max(...list.map((m) => Number(m.cursor))) : (cursor ?? null) }
    },
    downloadAttachment: async () => null,
    send: async () => ({ providerMessageId: null }),
    close: async () => {},
  }
}

function seed() {
  const db = new FakeDb()
  db.seed('email_accounts', [ACC])
  db.seed('email_account_secrets', [{ id: ACC.id, provider: 'gmail', scopes: [], iv: '', tag: '', updated_at: '' }])
  seedUser(db, 'viewer', ['ai.view'])
  seedUser(db, 'emailer', ['ai.email'])
  seedUser(db, 'boss', [], { roleKey: 'super_admin' })
  seedUser(db, 'inactive', ['ai.view'], { active: false })
  return db
}

const deps = (db: FakeDb, s: MailSession, client = fakeClaude(() => ({ parsed_output: insight })).client) => ({
  db: db.asDb(),
  fetch: async () => new Response('{}'),
  config: {} as never,
  client,
  deadline: Date.now() + 60_000,
  openSession: async () => s,
})

describe('email sync', () => {
  it('stores new inbox + sent mail idempotently, advances cursors, analyses inbox only and raises alerts + notifications', async () => {
    const db = seed()
    const s = session([msg('a', 'inbox', 1000), msg('b', 'inbox', 2000)], [msg('c', 'sent', 1500)])
    const r1 = await syncAll(deps(db, s), 'system')
    expect(r1).toMatchObject({ synced: 3, analyzed: 2, errors: [] })
    const emails = db.all('ai_emails')
    expect(emails.map((e) => e.id).sort()).toEqual([`${ACC.id}__a`, `${ACC.id}__b`, `${ACC.id}__c`])
    expect(emails.find((e) => e.folder === 'sent')!.status).toBe('skipped')
    expect(emails.filter((e) => e.folder === 'inbox').every((e) => e.status === 'analyzed')).toBe(true)
    const acc = db.get('email_accounts', ACC.id)!
    expect(acc).toMatchObject({ status: 'connected', last_sync_error: null, messages_synced: 3, cursor: { inbox: T0 + 2000, sent: T0 + 1500 } })
    expect(db.get('email_account_secrets', ACC.id)!.sync_lock_until).toBeNull()

    // urgent emails → open alerts; high/urgent + notify.urgent_email → notifications for active ai.view holders only
    const alerts = db.all('ai_alerts')
    expect(alerts.map((a) => a.dedupe_key).sort()).toEqual([`urgent_email:${ACC.id}__a`, `urgent_email:${ACC.id}__b`])
    const notes = db.all('notifications')
    expect(new Set(notes.map((n) => n.user_id))).toEqual(new Set(['viewer', 'boss']))
    expect(notes[0]).toMatchObject({ type: 'alert', link: '/ai?tab=alerts', is_read: false })
    expect(db.get('ai_status', 'status')).toMatchObject({ emails_total: 3, emails_pending_analysis: 0, last_monitor_ok: true, alerts_open: 2 })

    // second run: nothing new, nothing duplicated, no new notifications
    const r2 = await syncAll(deps(db, s), 'system')
    expect(r2).toMatchObject({ synced: 0, analyzed: 0 })
    expect(s.cursors.slice(2)).toEqual([T0 + 2000, T0 + 1500])
    expect(db.all('ai_emails')).toHaveLength(3)
    expect(db.all('notifications')).toHaveLength(notes.length)
  })

  it('marks the account as error on revoked authorisation and keeps the cursor of the folders that failed', async () => {
    const db = seed()
    const s = session([msg('a', 'inbox', 1000)], [msg('c', 'sent', 1500)], { failOn: 'sent' })
    const r = await syncAll(deps(db, s), 'system')
    expect(r.errors[0]).toMatch(/reconnect/)
    const acc = db.get('email_accounts', ACC.id)!
    expect(acc.status).toBe('error')
    expect(acc.last_sync_error).toMatch(/revoked/)
    expect(acc.cursor).toEqual({ inbox: T0 + 1000 })
    expect(db.get('ai_status', 'status')!.last_sync_error).toMatch(/revoked/)
  })

  it('leaves mail pending (status new) when AI is not configured, and skips locked or disabled accounts', async () => {
    const db = seed()
    const r = await syncAll({ ...deps(db, session([msg('a', 'inbox', 1000)], [])), client: null }, 'u')
    expect(r.analyzed).toBe(0)
    expect(db.all('ai_emails')[0].status).toBe('new')
    expect(db.get('ai_status', 'status')!.emails_pending_analysis).toBe(1)
    db.raw('email_account_secrets').get(ACC.id)!.sync_lock_until = new Date(Date.now() + 60_000).toISOString()
    const locked = await syncAll(deps(db, session([msg('z', 'inbox', 5000)], [])), 'u')
    expect(locked.errors[0]).toMatch(/already running/)
    db.raw('email_account_secrets').get(ACC.id)!.sync_lock_until = null
    db.raw('email_accounts').get(ACC.id)!.sync_enabled = false
    const off = await syncAll(deps(db, session([msg('z', 'inbox', 5000)], [])), 'system')
    expect(off.synced).toBe(0)
  })
})

describe('alert upsert', () => {
  const cand = (key: string, priority: 'medium' | 'high' = 'high') => ({
    dedupe_key: key,
    type: 'task_overdue' as const,
    priority,
    title: key,
    description: 'd',
    source: 'monitor' as const,
    record: null,
    project: null,
    recommended_action: 'r',
  })

  it('creates once, refreshes last_seen_at, resolves vanished conditions and never touches AI-sourced alerts', async () => {
    const db = new FakeDb()
    db.seed('ai_alerts', [{ id: 'ai1', dedupe_key: 'ai:x', source: 'ai', status: 'open', type: 'risk', priority: 'high', is_demo: false }])
    const r1 = await upsertAlerts(db.asDb(), [cand('k1'), cand('k2')], '2026-11-14T00:00:00Z')
    expect(r1.created).toHaveLength(2)
    const r2 = await upsertAlerts(db.asDb(), [cand('k1', 'medium')], '2026-11-14T01:00:00Z')
    expect(r2).toMatchObject({ updated: 1, resolved: 1 })
    expect(r2.created).toHaveLength(0)
    const rows = db.all('ai_alerts')
    const k1 = rows.find((a) => a.dedupe_key === 'k1')!
    expect(k1).toMatchObject({ status: 'open', priority: 'medium', first_seen_at: '2026-11-14T00:00:00Z', last_seen_at: '2026-11-14T01:00:00Z' })
    expect(rows.find((a) => a.dedupe_key === 'k2')).toMatchObject({ status: 'resolved', resolved_at: '2026-11-14T01:00:00Z' })
    expect(rows.find((a) => a.id === 'ai1')!.status).toBe('open')
    expect(r2.open).toBe(2) // k1 + ai1
    // an acknowledged alert stays acknowledged while the condition persists
    db.raw('ai_alerts').get(k1.id)!.status = 'acknowledged'
    await upsertAlerts(db.asDb(), [cand('k1')], '2026-11-14T02:00:00Z')
    expect(db.get('ai_alerts', k1.id)!.status).toBe('acknowledged')
    // reappearing condition after resolution → a new alert
    const r4 = await upsertAlerts(db.asDb(), [cand('k1'), cand('k2')], '2026-11-14T03:00:00Z')
    expect(r4.created.map((a) => a.dedupe_key)).toEqual(['k2'])
  })

  it('notifies only new high/urgent alerts whose type is enabled', () => {
    const settings = mergeSettings({ notify: { urgent_email: true, approval_pending: false } })
    const a = (type: string, priority: string) => ({ type, priority }) as never
    const picked = alertsToNotify([a('urgent_email', 'high'), a('urgent_email', 'medium'), a('approval_pending', 'urgent'), a('task_overdue', 'urgent'), a('payment_overdue', 'urgent')], settings)
    expect(picked).toEqual([a('urgent_email', 'high'), a('payment_overdue', 'urgent')])
  })

  it('runMonitor end-to-end on Firestore data, with a lock against concurrent runs', async () => {
    const db = seed()
    db.seed('projects', [{ id: 'p1', name: 'Mbezi', status: 'active', start_date: '2026-01-01', end_date: '2026-06-30', progress: 50 }])
    db.seed('tasks', [{ id: 't1', title: 'Roof', status: 'todo', due_date: '2026-01-10', priority: 'high' }])
    const now = new Date('2026-11-14T06:00:00Z')
    const res = await runMonitor(db.asDb(), 'viewer', now)
    expect(res).toMatchObject({ created: 2, resolved: 0, alerts_open: 2 })
    // project_behind_schedule urgent + notify.project_behind_schedule true → notified; task_overdue not in notify map
    expect(db.all('notifications').every((n) => n.title.includes('Mbezi'))).toBe(true)
    expect(db.all('ai_activity').filter((a) => a.action === 'alert_created')).toHaveLength(2)
    db.seed('ai_status', [{ id: 'monitor_lock', until: new Date(Date.now() + 60_000).toISOString() }])
    expect(await runMonitor(db.asDb(), 'viewer', new Date())).toMatchObject({ created: 0, alerts_open: 2 })
  })
})
