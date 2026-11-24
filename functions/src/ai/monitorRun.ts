/** Monitoring run: load ABCkit data with the Admin SDK → computeAlerts → upsert ai_alerts → notifications. */
import { randomUUID } from 'node:crypto'
import type { AiAlert, AlertType } from '../shared/ai/contract.js'
import { AI_COLLECTIONS, AI_PERMS } from '../shared/ai/contract.js'
import { computeAlerts, type AlertCandidate, type MonitorInput } from '../shared/ai/monitor.js'
import type { Db, Row } from '../lib/admin.js'
import { usersWithPerm } from '../lib/auth.js'
import { loadSettings, nowIso, patchStatus, writeActivity, type EffectiveSettings } from '../lib/audit.js'
import { companyToday, daysAgoIso } from '../lib/time.js'

const rows = async (q: FirebaseFirestore.Query): Promise<Row[]> => (await q.get()).docs.map((d) => ({ id: d.id, ...d.data() }))

export async function loadMonitorInput(db: Db, settings: EffectiveSettings, now = new Date()): Promise<MonitorInput> {
  const c = (name: string) => db.collection(name)
  const [projects, tasks, boqs, siteReports, incidents, prs, pos, txs, clientInv, supplierInv, leave, materials, emails, suppliers, clients] = await Promise.all([
    rows(c('projects')),
    rows(c('tasks').where('status', 'in', ['todo', 'in_progress', 'review', 'blocked'])),
    rows(c('boqs').where('status', '==', 'submitted')),
    rows(c('site_reports').where('status', '==', 'submitted')),
    rows(c('safety_incidents').where('status', 'in', ['open', 'investigating'])),
    rows(c('purchase_requests').where('status', '==', 'submitted')),
    rows(c('purchase_orders').where('status', 'in', ['pending_approval', 'approved', 'sent', 'partially_received'])),
    rows(
      c('financial_transactions')
        .where('status', 'in', ['approved', 'pending'])
        .select('number', 'project_id', 'direction', 'amount', 'amount_base', 'currency', 'status', 'client_invoice_id', 'supplier_invoice_id', 'transaction_date', 'created_at'),
    ),
    rows(c('client_invoices').where('status', 'in', ['issued', 'partially_paid'])),
    rows(c('supplier_invoices').where('status', 'in', ['unpaid', 'partially_paid'])),
    rows(c('leave_requests').where('status', '==', 'pending')),
    settings.low_stock_alerts ? rows(c('materials').select('code', 'name', 'unit', 'min_stock', 'current_stock', 'is_active')) : Promise.resolve([]),
    rows(c(AI_COLLECTIONS.emails).where('date', '>=', daysAgoIso(14, now)).select('subject', 'from', 'folder', 'status', 'ai', 'date', 'account_id', 'is_demo')),
    rows(c('suppliers').select('name', 'email', 'is_active')),
    rows(c('clients').select('name', 'email')),
  ])
  return {
    today: companyToday(now),
    settings,
    projects,
    tasks,
    boqs,
    site_reports: siteReports,
    safety_incidents: incidents,
    purchase_requests: prs,
    purchase_orders: pos,
    financial_transactions: txs,
    client_invoices: clientInv,
    supplier_invoices: supplierInv,
    leave_requests: leave,
    materials,
    emails,
    suppliers,
    clients,
  }
}

export interface UpsertResult {
  created: AiAlert[]
  updated: number
  resolved: number
  open: number
}

/** One open/acknowledged alert per dedupe_key: refresh existing, create new, resolve vanished (monitor/email sources only). */
export async function upsertAlerts(db: Db, candidates: AlertCandidate[], now = nowIso()): Promise<UpsertResult> {
  const existingSnap = await db.collection(AI_COLLECTIONS.alerts).where('status', 'in', ['open', 'acknowledged']).get()
  const byKey = new Map<string, { ref: FirebaseFirestore.DocumentReference; data: AiAlert }>()
  const duplicates: FirebaseFirestore.DocumentReference[] = []
  for (const d of existingSnap.docs) {
    const data = d.data() as AiAlert
    if (data.is_demo) continue
    if (byKey.has(data.dedupe_key)) duplicates.push(d.ref)
    else byKey.set(data.dedupe_key, { ref: d.ref, data })
  }
  const writes: Array<(b: FirebaseFirestore.WriteBatch) => void> = []
  const created: AiAlert[] = []
  let updated = 0
  const seen = new Set<string>()
  for (const c of candidates) {
    seen.add(c.dedupe_key)
    const prev = byKey.get(c.dedupe_key)
    if (prev) {
      updated++
      writes.push((b) =>
        b.update(prev.ref, {
          last_seen_at: now,
          priority: c.priority,
          title: c.title,
          description: c.description,
          record: c.record,
          project: c.project,
          recommended_action: c.recommended_action,
        }),
      )
      continue
    }
    const id = randomUUID()
    const alert: AiAlert = {
      id,
      dedupe_key: c.dedupe_key,
      type: c.type,
      priority: c.priority,
      title: c.title,
      description: c.description,
      source: c.source,
      record: c.record,
      project: c.project,
      recommended_action: c.recommended_action,
      status: 'open',
      first_seen_at: now,
      last_seen_at: now,
      resolved_at: null,
      acknowledged_by: null,
      acknowledged_at: null,
      is_demo: false,
    }
    created.push(alert)
    writes.push((b) => b.set(db.doc(`${AI_COLLECTIONS.alerts}/${id}`), alert))
  }
  let resolved = 0
  for (const [key, prev] of byKey) {
    if (seen.has(key) || prev.data.source === 'ai') continue
    resolved++
    writes.push((b) => b.update(prev.ref, { status: 'resolved', resolved_at: now }))
  }
  // a concurrent run may have created a second open alert for a key: resolve the extras
  for (const ref of duplicates) writes.push((b) => b.update(ref, { status: 'resolved', resolved_at: now }))
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch()
    writes.slice(i, i + 400).forEach((w) => w(batch))
    await batch.commit()
  }
  const open = [...byKey.keys()].filter((k) => seen.has(k) || byKey.get(k)!.data.source === 'ai').length + created.length
  return { created, updated, resolved, open }
}

export const MAX_NOTIFICATIONS_PER_USER = 10

/** Notifications only for NEW high/urgent alerts whose type is enabled in ai_settings.notify. */
export function alertsToNotify(created: AiAlert[], settings: EffectiveSettings): AiAlert[] {
  const notify = settings.notify as Partial<Record<AlertType, boolean>>
  return created.filter((a) => (a.priority === 'high' || a.priority === 'urgent') && notify[a.type] === true)
}

export async function notifyAlerts(db: Db, alerts: AiAlert[], now = nowIso()): Promise<number> {
  if (!alerts.length) return 0
  const users = await usersWithPerm(db, AI_PERMS.view)
  const sorted = [...alerts].sort((a, b) => (a.priority === b.priority ? a.dedupe_key.localeCompare(b.dedupe_key) : a.priority === 'urgent' ? -1 : 1))
  const shown = sorted.slice(0, MAX_NOTIFICATIONS_PER_USER)
  const rest = sorted.length - shown.length
  let n = 0
  const batchWrites: Array<{ id: string; row: Row }> = []
  for (const uid of users) {
    for (const a of shown) {
      const id = randomUUID()
      batchWrites.push({
        id,
        row: { id, user_id: uid, title: `${a.priority === 'urgent' ? 'Urgent' : 'High priority'}: ${a.title}`.slice(0, 200), body: a.description.slice(0, 500), type: 'alert', link: '/ai?tab=alerts', is_read: false, created_at: now },
      })
    }
    if (rest > 0) {
      const id = randomUUID()
      batchWrites.push({ id, row: { id, user_id: uid, title: `${rest} more new AI alerts`, body: 'Open the AI alerts page to review them.', type: 'alert', link: '/ai?tab=alerts', is_read: false, created_at: now } })
    }
  }
  for (let i = 0; i < batchWrites.length; i += 400) {
    const batch = db.batch()
    for (const w of batchWrites.slice(i, i + 400)) batch.set(db.doc(`notifications/${w.id}`), w.row)
    await batch.commit()
    n += Math.min(400, batchWrites.length - i)
  }
  return n
}

const LOCK_DOC = `${AI_COLLECTIONS.status}/monitor_lock`
const LOCK_MS = 5 * 60 * 1000

async function acquireLock(db: Db, now: number): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const ref = db.doc(LOCK_DOC)
    const snap = await tx.get(ref)
    const until = snap.exists ? Date.parse(String(snap.data()?.until ?? '')) : 0
    if (Number.isFinite(until) && until > now) return false
    tx.set(ref, { id: 'monitor_lock', until: new Date(now + LOCK_MS).toISOString() })
    return true
  })
}

export interface MonitorResult {
  alerts_open: number
  created: number
  resolved: number
}

export async function runMonitor(db: Db, actor: string, now = new Date()): Promise<MonitorResult> {
  if (!(await acquireLock(db, now.getTime()))) {
    const open = (await db.collection(AI_COLLECTIONS.alerts).where('status', 'in', ['open', 'acknowledged']).count().get()).data().count
    return { alerts_open: open, created: 0, resolved: 0 }
  }
  const at = now.toISOString()
  try {
    const settings = await loadSettings(db)
    const input = await loadMonitorInput(db, settings, now)
    const candidates = computeAlerts(input)
    const res = await upsertAlerts(db, candidates, at)
    const notified = await notifyAlerts(db, alertsToNotify(res.created, settings), at)
    for (const a of res.created.slice(0, 50))
      await writeActivity(db, actor, 'alert_created', `${a.priority.toUpperCase()} ${a.type}: ${a.title}`, { table: AI_COLLECTIONS.alerts, id: a.id })
    await writeActivity(db, actor, 'monitor_run', `Monitor: ${candidates.length} conditions, ${res.created.length} new, ${res.resolved} resolved, ${notified} notifications`)
    await patchStatus(db, { last_monitor_at: at, last_monitor_ok: true, last_monitor_error: null, alerts_open: res.open })
    return { alerts_open: res.open, created: res.created.length, resolved: res.resolved }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    await patchStatus(db, { last_monitor_at: at, last_monitor_ok: false, last_monitor_error: msg.slice(0, 500) })
    await writeActivity(db, actor, 'monitor_run', `Monitor failed: ${msg}`, null, false)
    throw e
  } finally {
    await db.doc(LOCK_DOC).set({ id: 'monitor_lock', until: new Date(0).toISOString() }).catch(() => undefined)
  }
}
