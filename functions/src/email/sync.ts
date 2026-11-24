/** Mailbox sync (Gmail / Graph / IMAP) → ai_emails, then analysis of new inbox mail and the alert step. */
import { logger } from 'firebase-functions/v2'
import type { AiEmail, EmailAccount } from '../shared/ai/contract.js'
import { AI_COLLECTIONS } from '../shared/ai/contract.js'
import { loadSettings, nowIso, patchStatus, writeActivity } from '../lib/audit.js'
import { companyToday, daysAgoIso } from '../lib/time.js'
import type { AnthropicLike } from '../ai/claude.js'
import { runMonitor } from '../ai/monitorRun.js'
import { openSession, type MailDeps } from './accounts.js'
import { analyzeEmail, loadReference, type ReferenceData } from './analyze.js'
import { ProviderAuthError } from './http.js'
import { toAiEmail } from './message.js'
import type { Folder, MailSession } from './provider.js'

export const FIRST_SYNC_DAYS = 14
export const LIMITS: Record<Folder, number> = { inbox: 150, sent: 50 }
const LOCK_MS = 9 * 60 * 1000

export interface SyncDeps extends MailDeps {
  client: AnthropicLike | null
  /** epoch ms after which no new analysis is started (function timeout safety) */
  deadline: number
  openSession?: (account: EmailAccount) => Promise<MailSession>
  now?: () => Date
  /** run the monitor after new analyses (default true) */
  runMonitorAfter?: boolean
}

export interface SyncSummary {
  synced: number
  analyzed: number
  errors: string[]
}

async function acquireLock(deps: SyncDeps, accountId: string): Promise<boolean> {
  const ref = deps.db.doc(`${AI_COLLECTIONS.accountSecrets}/${accountId}`)
  const now = (deps.now?.() ?? new Date()).getTime()
  return deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return true // no credentials: openSession reports the problem
    const until = Date.parse(String(snap.data()?.sync_lock_until ?? ''))
    if (Number.isFinite(until) && until > now) return false
    tx.update(ref, { sync_lock_until: new Date(now + LOCK_MS).toISOString() })
    return true
  })
}

async function releaseLock(deps: SyncDeps, accountId: string) {
  await deps.db
    .doc(`${AI_COLLECTIONS.accountSecrets}/${accountId}`)
    .update({ sync_lock_until: null })
    .catch(() => undefined)
}

/** Writes new messages (existing doc ids are skipped — idempotent) and returns the ids written. */
async function writeNew(deps: SyncDeps, emails: AiEmail[]): Promise<string[]> {
  if (!emails.length) return []
  const refs = emails.map((e) => deps.db.doc(`${AI_COLLECTIONS.emails}/${e.id}`))
  const existing = new Set<string>()
  for (let i = 0; i < refs.length; i += 100) {
    const snaps = await deps.db.getAll(...refs.slice(i, i + 100))
    snaps.forEach((s) => s.exists && existing.add(s.id))
  }
  const fresh = emails.filter((e) => !existing.has(e.id))
  // bodies are up to 50k chars: keep batches small to stay well below the request size limit
  for (let i = 0; i < fresh.length; i += 20) {
    const batch = deps.db.batch()
    for (const e of fresh.slice(i, i + 20)) batch.set(deps.db.doc(`${AI_COLLECTIONS.emails}/${e.id}`), e)
    await batch.commit()
  }
  return fresh.map((e) => e.id)
}

export interface AccountSyncResult {
  synced: number
  newInbox: string[]
  error: string | null
  /** in-memory attachment bytes from IMAP parsing, per email id */
  attachments: Map<string, Map<string, Buffer>>
}

export async function syncAccount(deps: SyncDeps, account: EmailAccount, session: MailSession): Promise<AccountSyncResult> {
  const ref = deps.db.doc(`${AI_COLLECTIONS.accounts}/${account.id}`)
  const result: AccountSyncResult = { synced: 0, newInbox: [], error: null, attachments: new Map() }
  const now = deps.now?.() ?? new Date()
  await ref.update({ status: 'syncing' })
  const cursor: Record<string, unknown> = { ...(account.cursor ?? {}) }
  try {
    for (const folder of ['inbox', 'sent'] as Folder[]) {
      const res = await session.fetchNew(folder, cursor[folder] ?? null, { sinceIso: daysAgoIso(FIRST_SYNC_DAYS, now), limit: LIMITS[folder] })
      const at = nowIso()
      const docs = res.messages.map((m) => toAiEmail(account.id, account.provider, m, at))
      const written = await writeNew(deps, docs)
      res.messages.forEach((m, i) => {
        if (m.attachmentData?.size) {
          const byName = new Map<string, Buffer>()
          for (const a of m.attachments) if (a.ref && m.attachmentData.has(a.ref)) byName.set(a.name, m.attachmentData.get(a.ref)!)
          result.attachments.set(docs[i].id, byName)
        }
      })
      result.synced += written.length
      if (folder === 'inbox') result.newInbox.push(...written)
      // cursor advances only after the writes above succeeded
      if (res.nextCursor !== undefined && res.nextCursor !== null) {
        cursor[folder] = res.nextCursor
        await ref.update({ cursor: { ...cursor } })
      }
    }
    await ref.update({
      status: 'connected',
      last_sync_at: nowIso(),
      last_sync_error: null,
      messages_synced: (account.messages_synced ?? 0) + result.synced,
    })
  } catch (e) {
    const msg =
      e instanceof ProviderAuthError
        ? `${e.message}`
        : `Sync failed: ${(e as Error)?.message ?? e}`
    result.error = msg
    await ref.update({ status: 'error', last_sync_error: msg.slice(0, 500), messages_synced: (account.messages_synced ?? 0) + result.synced })
  }
  return result
}

async function countWhere(deps: SyncDeps, field?: string, value?: unknown): Promise<number> {
  const col = deps.db.collection(AI_COLLECTIONS.emails)
  const q = field ? col.where(field, '==', value) : col
  return (await q.count().get()).data().count
}

/**
 * Syncs one account (accountId) or every sync-enabled connected account, analyses new inbox mail while time
 * allows (pending ones are picked up by the next run) and runs the monitor when something was analysed.
 */
export async function syncAll(deps: SyncDeps, actor: string, accountId?: string): Promise<SyncSummary> {
  const summary: SyncSummary = { synced: 0, analyzed: 0, errors: [] }
  const settings = await loadSettings(deps.db)
  const accounts: EmailAccount[] = accountId
    ? [(await deps.db.doc(`${AI_COLLECTIONS.accounts}/${accountId}`).get()).data() as EmailAccount].filter(Boolean)
    : (await deps.db.collection(AI_COLLECTIONS.accounts).where('sync_enabled', '==', true).get()).docs.map((d) => d.data() as EmailAccount)
  if (accountId && !accounts.length) {
    summary.errors.push('Email account not found')
    return summary
  }
  const sessions = new Map<string, MailSession>()
  const attachments = new Map<string, Map<string, Buffer>>()
  const open = deps.openSession ?? ((a: EmailAccount) => openSession(deps, a))
  let lastError: string | null = null

  try {
    for (const account of accounts) {
      if (account.is_demo || account.status === 'disconnected' || (!accountId && !account.sync_enabled)) continue
      if (!(await acquireLock(deps, account.id))) {
        summary.errors.push(`${account.address}: a sync is already running`)
        continue
      }
      try {
        let session: MailSession
        try {
          session = await open(account)
        } catch (e) {
          const msg = e instanceof ProviderAuthError ? e.message : `Could not open the mailbox: ${(e as Error)?.message ?? e}`
          await deps.db.doc(`${AI_COLLECTIONS.accounts}/${account.id}`).update({ status: 'error', last_sync_error: msg.slice(0, 500) })
          summary.errors.push(`${account.address}: ${msg}`)
          lastError = msg
          await writeActivity(deps.db, actor, 'email_sync', `Sync of ${account.address} failed: ${msg}`, { table: AI_COLLECTIONS.accounts, id: account.id }, false)
          continue
        }
        sessions.set(account.id, session)
        const r = await syncAccount(deps, account, session)
        summary.synced += r.synced
        r.attachments.forEach((v, k) => attachments.set(k, v))
        if (r.error) {
          summary.errors.push(`${account.address}: ${r.error}`)
          lastError = r.error
        }
        await writeActivity(deps.db, actor, 'email_sync', `Synced ${account.address}: ${r.synced} new message(s)${r.error ? `; ${r.error}` : ''}`, { table: AI_COLLECTIONS.accounts, id: account.id }, !r.error)
      } finally {
        await releaseLock(deps, account.id)
      }
    }

    // ---- analysis of pending inbox mail (new now or left over from earlier runs)
    if (settings.enabled && deps.client) {
      const pendingSnap = await deps.db.collection(AI_COLLECTIONS.emails).where('status', '==', 'new').limit(200).get()
      const pending = pendingSnap.docs
        .map((d) => d.data() as AiEmail)
        .filter((e) => e.folder === 'inbox' && !e.is_demo && (!accountId || e.account_id === accountId))
        .sort((a, b) => a.date.localeCompare(b.date))
      if (pending.length) {
        const ref: ReferenceData = await loadReference(deps.db)
        const today = companyToday(deps.now?.() ?? new Date())
        const accountById = new Map(accounts.map((a) => [a.id, a]))
        const sessionFor = async (id: string): Promise<MailSession | null> => {
          if (sessions.has(id)) return sessions.get(id)!
          const acc = accountById.get(id) ?? ((await deps.db.doc(`${AI_COLLECTIONS.accounts}/${id}`).get()).data() as EmailAccount | undefined)
          if (!acc || acc.status === 'disconnected' || acc.is_demo) return null
          try {
            const s = await open(acc)
            sessions.set(id, s)
            return s
          } catch {
            return null
          }
        }
        let i = 0
        const worker = async () => {
          while (i < pending.length && Date.now() < deps.deadline) {
            const email = pending[i++]
            const mem = attachments.get(email.id)
            const loader = mem
              ? async (name: string) => (mem.has(name) ? { data: mem.get(name)!, mime: email.attachments.find((a) => a.name === name)?.mime ?? 'application/octet-stream' } : null)
              : email.attachments.length
                ? async (name: string) => {
                    const s = await sessionFor(email.account_id)
                    return s ? s.downloadAttachment(email.provider_message_id, email.folder, name) : null
                  }
                : null
            try {
              await analyzeEmail({ db: deps.db, client: deps.client!, today, ref, actor }, email, loader)
              summary.analyzed++
            } catch (e) {
              logger.warn('email analysis failed', { id: email.id, error: (e as Error)?.message })
              summary.errors.push(`Analysis of "${email.subject.slice(0, 60)}" failed`)
            }
          }
        }
        await Promise.all([worker(), worker(), worker()])
      }
    }
  } finally {
    for (const s of sessions.values()) await s.close().catch(() => undefined)
  }

  const [total, pending] = await Promise.all([countWhere(deps), countWhere(deps, 'status', 'new')])
  await patchStatus(deps.db, { last_sync_at: nowIso(), last_sync_error: lastError, emails_total: total, emails_pending_analysis: pending })

  // email-derived alerts (urgent emails, complaints, delivery issues) — run the full monitor so the
  // cross-checks against purchase orders / projects use current data
  if (summary.analyzed > 0 && deps.runMonitorAfter !== false) {
    try {
      await runMonitor(deps.db, actor)
    } catch (e) {
      summary.errors.push(`Alert update failed: ${(e as Error)?.message ?? e}`)
    }
  }
  return summary
}
