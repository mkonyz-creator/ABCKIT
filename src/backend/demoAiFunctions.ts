/**
 * Demo Mode stand-ins for the AI Cloud Functions (src/shared/ai/contract.ts CallableContracts).
 * Nothing here contacts Firebase, an email provider or an AI model:
 *   aiComplete          → [DEMO] rule-based assistant (src/lib/ai/demoAssistant.ts)
 *   emailGenerateReply  → template reply from the email's stored analysis, marked [DEMO]
 *   emailSendDraft      → marks the draft 'sent' with the note "[DEMO] not actually sent"
 *   emailConnectStart / emailConnectImap → "Not available in Demo Mode"
 *   emailSyncNow / emailAnalyze → no-op success
 *   aiRunMonitor        → shared computeAlerts() on the demo data, upserting ai_alerts
 * Server-written collections are written straight to the store (like the Admin SDK would), not through hooks.
 */
import { DEMO_MODEL, demoComplete } from '../lib/ai/demoAssistant'
import { AI_COLLECTIONS as C, AI_PERMS, DEFAULT_AI_SETTINGS, type AiEmailDraft, type CallableName, type EmailInsight } from '../shared/ai/contract'
import { computeAlerts, type MonitorInput } from '../shared/ai/monitor'
import type { createDb } from './client'
import { uuid } from './engine'
import type { Row } from './registry'
import type { Store } from './store'

type Db = ReturnType<typeof createDb>
type Result = { data: any; error: any }

const ok = (data: unknown): Result => ({ data, error: null })
const fail = (message: string, code = 'functions/failed-precondition'): Result => ({ data: null, error: { message, code, context: { json: async () => ({ error: message }) } } })
const denied = (what: string) => fail(`Your role does not allow ${what}.`, 'functions/permission-denied')

export const DEMO_NOT_SENT = '[DEMO] not actually sent'
const AI_CALLABLES = new Set<string>(['aiComplete', 'emailConnectStart', 'emailConnectImap', 'emailDisconnect', 'emailSetSync', 'emailSyncNow', 'emailAnalyze', 'emailGenerateReply', 'emailSendDraft', 'aiRunMonitor', 'aiManageKeys'] satisfies CallableName[])

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function isAiCallable(name: string) {
  return AI_CALLABLES.has(name)
}

export function createDemoAiFunctions(deps: { db: () => Db; store: Store }) {
  const { store } = deps
  const write = (fn: (put: (t: string, id: string, row: Row) => void) => void) =>
    store.transaction(async (tx) => {
      fn((t, id, row) => tx.set(t, id, row))
    })
  const activity = (actor: string, action: string, detail: string, record: { table: string; id: string } | null = null, okFlag = true): Row => {
    const id = uuid()
    return { id, at: new Date().toISOString(), actor_id: actor, action, detail, record, ok: okFlag, is_demo: true }
  }
  const settings = async () => ({ ...DEFAULT_AI_SETTINGS, ...((await store.get(C.settings, 'settings')) ?? {}) })

  return async function invoke(name: string, body: Record<string, any>): Promise<Result> {
    const db = deps.db()
    const me = await db.me()
    if (!me?.active) return fail('Sign in first.', 'functions/unauthenticated')
    const now = new Date().toISOString()

    switch (name) {
      case 'aiComplete': {
        if (!me.can(AI_PERMS.view)) return denied('using the AI assistant')
        if (!Array.isArray(body.messages) || !body.messages.length) return fail('messages must be a non-empty array', 'functions/invalid-argument')
        const res = demoComplete(body as never)
        await write((put) => {
          const id = uuid()
          put(C.usage, id, { id, at: now, user_id: me.uid, purpose: body.purpose === 'report' ? 'report' : 'chat', model: DEMO_MODEL, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 })
        })
        return ok(res)
      }

      case 'emailConnectStart':
      case 'emailConnectImap':
        return fail('Not available in Demo Mode: Demo Mode never connects to a real mailbox.')

      case 'aiManageKeys':
        // a real API key must never be stored in the browser (Demo Mode keeps everything in IndexedDB)
        if (!me.can(AI_PERMS.manage)) return denied('managing AI API keys')
        return fail('[DEMO] API keys are never saved in Demo Mode. Sign in to the real ABCkit to add AI API keys.')

      case 'emailDisconnect':
      case 'emailSetSync': {
        if (!me.can(AI_PERMS.manage)) return denied('managing email accounts')
        const acc = await store.get(C.accounts, String(body.account_id ?? ''))
        if (!acc) return fail('Email account not found', 'functions/not-found')
        const patch = name === 'emailDisconnect' ? { status: 'disconnected', sync_enabled: false } : { sync_enabled: !!body.enabled }
        await write((put) => {
          put(C.accounts, acc.id, { ...acc, ...patch })
          const a = activity(me.uid, name === 'emailDisconnect' ? 'account_disconnected' : 'settings_changed', `[DEMO] ${acc.address}: ${JSON.stringify(patch)}`, { table: C.accounts, id: acc.id })
          put(C.activity, a.id, a)
        })
        return ok({ ok: true })
      }

      case 'emailSyncNow': {
        if (!me.can(AI_PERMS.manage) && !me.can(AI_PERMS.email)) return denied('synchronising email')
        const accounts = await store.query(C.accounts, [])
        await write((put) => {
          for (const a of accounts) if (!body.account_id || a.id === body.account_id) put(C.accounts, a.id, { ...a, last_sync_at: now, last_sync_error: null })
          const a = activity(me.uid, 'email_sync', '[DEMO] Sync requested — Demo Mode has no real mailbox, nothing was fetched.')
          put(C.activity, a.id, a)
        })
        const status = await store.get(C.status, 'status')
        if (status) await write((put) => put(C.status, 'status', { ...status, last_sync_at: now, updated_at: now }))
        return ok({ synced: 0, analyzed: 0, errors: [] })
      }

      case 'emailAnalyze': {
        if (!me.can(AI_PERMS.email)) return denied('analysing emails')
        const e = await store.get(C.emails, String(body.email_id ?? ''))
        if (!e) return fail('Email not found', 'functions/not-found')
        const insight: EmailInsight = e.ai ?? demoInsight(e)
        await write((put) => {
          put(C.emails, e.id, { ...e, ai: { ...insight, analyzed_at: now }, status: 'analyzed', error: null })
          const a = activity(me.uid, 'email_analyzed', `[DEMO] Re-analysis requested for "${String(e.subject).slice(0, 80)}" — stored analysis kept (no AI model in Demo Mode).`, { table: C.emails, id: e.id })
          put(C.activity, a.id, a)
        })
        return ok({ ai: insight })
      }

      case 'emailGenerateReply': {
        if (!me.can(AI_PERMS.email)) return denied('preparing email replies')
        const e = await store.get(C.emails, String(body.email_id ?? ''))
        if (!e) return fail('Email not found', 'functions/not-found')
        if (e.folder !== 'inbox') return fail('Replies can only be prepared for received emails', 'functions/invalid-argument')
        const language = body.language === 'sw' ? 'sw' : 'en'
        const s = await settings()
        const id = uuid()
        const draft: AiEmailDraft = {
          id,
          email_id: e.id,
          account_id: e.account_id,
          thread_id: e.thread_id ?? null,
          to: [e.from],
          cc: [],
          subject: /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`,
          body: templateReply(e, language, s.reply_signature, body.instructions),
          language,
          status: 'draft',
          ai_generated: false,
          instructions: body.instructions ? String(body.instructions).slice(0, 1000) : null,
          created_by: me.uid,
          created_at: now,
          updated_at: now,
          approved_by: null,
          approved_at: null,
          sent_at: null,
          provider_message_id: null,
          error: null,
          is_demo: true,
        }
        await write((put) => {
          put(C.drafts, id, draft as unknown as Row)
          const a = activity(me.uid, 'reply_generated', `[DEMO] Template reply (${language}) for "${String(e.subject).slice(0, 80)}"`, { table: C.drafts, id })
          put(C.activity, a.id, a)
        })
        return ok({ draft_id: id })
      }

      case 'emailSendDraft': {
        if (!me.can(AI_PERMS.send)) return denied('approving and sending emails')
        const d = await store.get(C.drafts, String(body.draft_id ?? ''))
        if (!d) return fail('Draft not found', 'functions/not-found')
        if (d.status !== 'draft' && d.status !== 'approved') return fail(`This reply is ${d.status} and cannot be sent`, 'functions/failed-precondition')
        if (!Array.isArray(d.to) || !d.to.length) return fail('The reply has no recipient', 'functions/invalid-argument')
        const original = await store.get(C.emails, String(d.email_id))
        const account = original ? await store.get(C.accounts, String(original.account_id)) : null
        const sentId = `${d.account_id}__demo-sent-${d.id}`
        await write((put) => {
          // nothing leaves the browser: the draft is only marked sent, with a note saying so
          put(C.drafts, d.id, { ...d, status: 'sent', approved_by: me.uid, approved_at: now, sent_at: now, provider_message_id: null, error: null, demo_note: DEMO_NOT_SENT })
          put(C.emails, sentId, {
            id: sentId,
            account_id: d.account_id,
            provider: account?.provider ?? 'gmail',
            provider_message_id: `demo-sent-${d.id}`,
            thread_id: d.thread_id ?? original?.thread_id ?? null,
            folder: 'sent',
            from: { name: account?.display_name ?? 'ARICOM [DEMO]', address: account?.address ?? 'office@aricom.example' },
            to: d.to,
            cc: d.cc ?? [],
            subject: d.subject,
            date: now,
            snippet: `${DEMO_NOT_SENT} — ${String(d.body).slice(0, 120)}`,
            body_text: `${d.body}\n\n${DEMO_NOT_SENT}`,
            body_truncated: false,
            attachments: [],
            message_id_header: `<demo-sent-${d.id}@aricom.example>`,
            in_reply_to: original?.message_id_header ?? null,
            references: original?.message_id_header ?? null,
            status: 'skipped',
            ai: null,
            error: null,
            is_demo: true,
            created_at: now,
          })
          const a = activity(me.uid, 'email_sent', `${DEMO_NOT_SENT}: reply "${String(d.subject).slice(0, 80)}" to ${d.to.map((p: Row) => p.address).join(', ')}`, { table: C.drafts, id: d.id })
          put(C.activity, a.id, a)
        })
        return ok({ ok: true, sent_at: now })
      }

      case 'aiRunMonitor': {
        if (!me.can(AI_PERMS.view)) return denied('running the AI monitor')
        return ok(await runDemoMonitor(store, me.uid))
      }
    }
    return fail(`Function ${name} is not available in demo mode`)
  }
}

/** computeAlerts() over all demo data, upserting one alert per dedupe_key */
export async function runDemoMonitor(store: Store, actor: string) {
  const now = new Date().toISOString()
  const today = localToday()
  const all = (t: string) => store.query(t, [])
  const s = { ...DEFAULT_AI_SETTINGS, ...((await store.get(C.settings, 'settings')) ?? {}) }
  const tables = ['projects', 'tasks', 'boqs', 'site_reports', 'safety_incidents', 'purchase_requests', 'purchase_orders', 'financial_transactions', 'client_invoices', 'supplier_invoices', 'leave_requests', 'materials', 'suppliers', 'clients'] as const
  const rows = await Promise.all(tables.map(all))
  const input = Object.fromEntries(tables.map((t, i) => [t, rows[i]])) as unknown as MonitorInput
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  input.emails = (await all(C.emails)).filter((e) => e.folder === 'inbox' && e.ai && String(e.date) >= since)
  input.today = today
  input.settings = { schedule_slip_threshold_pct: s.schedule_slip_threshold_pct, approval_stale_days: s.approval_stale_days, low_stock_alerts: s.low_stock_alerts }
  let candidates: ReturnType<typeof computeAlerts> = []
  let error: string | null = null
  try {
    candidates = computeAlerts(input)
  } catch (e) {
    error = (e as Error)?.message ?? String(e)
  }
  const existing = await all(C.alerts)
  const byKey = new Map(existing.filter((a) => a.status !== 'resolved').map((a) => [a.dedupe_key, a]))
  let created = 0
  let resolved = 0
  const keys = new Set(candidates.map((c) => c.dedupe_key))
  await store.transaction(async (tx) => {
    for (const c of candidates) {
      const cur = byKey.get(c.dedupe_key)
      if (cur) tx.set(C.alerts, cur.id, { ...cur, ...c, last_seen_at: now })
      else {
        const id = uuid()
        created++
        tx.set(C.alerts, id, { id, ...c, status: 'open', first_seen_at: now, last_seen_at: now, resolved_at: null, acknowledged_by: null, acknowledged_at: null, is_demo: true })
      }
    }
    // conditions that no longer hold are resolved — only when the monitor produced a result set at all
    // (the shared rules may still be a stub returning nothing; then the seeded demo alerts are kept)
    if (candidates.length && !error)
      for (const a of byKey.values())
        if (a.source === 'monitor' && !keys.has(a.dedupe_key)) {
          resolved++
          tx.set(C.alerts, a.id, { ...a, status: 'resolved', resolved_at: now })
        }
    const open = existing.filter((a) => a.status !== 'resolved').length + created - resolved
    const st = (await tx.get(C.status, 'status')) ?? { id: 'status' }
    tx.set(C.status, 'status', { ...st, last_monitor_at: now, last_monitor_ok: !error, last_monitor_error: error, alerts_open: open, updated_at: now })
    const aid = uuid()
    tx.set(C.activity, aid, {
      id: aid,
      at: now,
      actor_id: actor,
      action: 'monitor_run',
      detail: error ? `[DEMO] Monitor failed: ${error}` : `[DEMO] Monitor run: ${candidates.length} condition(s), ${created} new, ${resolved} resolved`,
      record: null,
      ok: !error,
      is_demo: true,
    })
  })
  if (error) throw Object.assign(new Error(error), { code: 'monitor' })
  const after = await all(C.alerts)
  return { alerts_open: after.filter((a) => a.status !== 'resolved').length, created, resolved }
}

function demoInsight(e: Row): EmailInsight {
  return {
    category: 'general_admin',
    priority: 'medium',
    is_important: false,
    summary: `[DEMO] ${String(e.snippet ?? e.subject).slice(0, 200)}`,
    main_message: String(e.subject ?? ''),
    required_action: null,
    responsible_person: null,
    deadline: null,
    related_project_id: null,
    related_project_name: null,
    related_party: { type: null, id: null, name: e.from?.name ?? null },
    suggested_response: null,
    language: 'en',
    flags: { complaint: false, delivery_issue: false, payment_related: false, approval_request: false, meeting_request: false, suspicious_instructions: false },
    confidence: 0.3,
    model: DEMO_MODEL,
    analyzed_at: new Date().toISOString(),
  }
}

/** template reply from the stored analysis (no model) */
export function templateReply(e: Row, language: 'en' | 'sw', signature: string, instructions?: string) {
  const ai = (e.ai ?? {}) as Partial<EmailInsight>
  const name = String(e.from?.name ?? '').split(/[\s(]/)[0] || (language === 'sw' ? 'Ndugu' : 'Sir/Madam')
  const subject = String(e.subject ?? '').replace(/^re:\s*/i, '')
  const suspicious = !!ai.flags?.suspicious_instructions
  const lines =
    language === 'sw'
      ? [
          `Habari ${name},`,
          '',
          `Tunashukuru kwa barua yako kuhusu "${subject}".`,
          suspicious
            ? 'Hatubadilishi taarifa za malipo kupitia barua pepe. Tutawasiliana nanyi kwa simu kupitia namba tunayoijua ili kuthibitisha.'
            : ai.required_action
              ? `Tumepokea ombi lako na tunalishughulikia: ${ai.required_action}${ai.deadline ? ` (kabla ya ${ai.deadline})` : ''}.`
              : 'Tumepokea taarifa yako na tutakujibu kwa kina hivi karibuni.',
          ai.suggested_response && !suspicious ? `Kwa ufupi: ${ai.suggested_response}` : '',
          instructions ? `Maelezo ya ziada: ${instructions}` : '',
          '',
          signature,
          '',
          '[DEMO] Jibu hili limeandaliwa kwa kiolezo (hakuna AI iliyotumika).',
        ]
      : [
          `Dear ${name},`,
          '',
          `Thank you for your email regarding "${subject}".`,
          suspicious
            ? 'We do not change payment details on the basis of an email. We will call you on a number we already hold to verify this request before taking any action.'
            : ai.required_action
              ? `We have noted the request and are acting on it: ${ai.required_action}${ai.deadline ? ` (by ${ai.deadline})` : ''}.`
              : 'We have received your message and will revert with details shortly.',
          ai.suggested_response && !suspicious ? `In summary: ${ai.suggested_response}` : '',
          instructions ? `Additional note: ${instructions}` : '',
          '',
          signature,
          '',
          '[DEMO] Template reply prepared without an AI model.',
        ]
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n')
}
