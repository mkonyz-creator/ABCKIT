/**
 * AI Intelligence domain — collections of src/shared/ai/contract.ts (AI_COLLECTIONS).
 *
 * The web app only reads most of these; Cloud Functions (Admin SDK, no hooks, no rules) write emails, drafts,
 * alerts, usage, status and email accounts. Client writes allowed here mirror firebase/rules/50_ai.rules:
 *   ai_email_drafts  edit body/subject/to/cc/language while status 'draft', or discard (status → 'discarded')
 *   ai_alerts        acknowledge / resolve (records who and when)
 *   ai_reports       create own (immutable afterwards)
 *   ai_chats         private to user_id
 *   ai_memories      private to user_id (what the user asked the assistant to remember)
 *   ai_knowledge     CRUD for ai.manage
 *   ai_activity      own 'chat' / 'report' / 'voice' / 'assistant_action' audit rows
 *   ai_settings      ai.manage
 * No hook here ever calls the model: AI text only enters these tables through the callables or the user.
 */
import { AI_COLLECTIONS as C, AI_MEMORY_LIMITS, AI_PERMS, ALERT_TYPES, CHAT_PROVIDERS, DEFAULT_AI_SETTINGS, PRIORITIES, type ChatProviderId } from '../../shared/ai/contract'
import { defineHooks, defineScope, enableAudit, extendTable, ownScope, type Row, type WriteCtx } from '../registry'
import type { ColumnSchema } from '../types'

const text = (notNull = false, value?: unknown): ColumnSchema => ({ type: 'text', notNull, ...(value !== undefined ? { default: { kind: 'value', value } } : {}) })
const json = (value: unknown = null, notNull = false): ColumnSchema => ({ type: 'jsonb', notNull, ...(value !== null ? { default: { kind: 'value', value } } : {}) })
const bool = (value: boolean): ColumnSchema => ({ type: 'boolean', notNull: true, default: { kind: 'value', value } })
const ts = (now = false, notNull = false): ColumnSchema => ({ type: 'timestamptz', notNull, ...(now ? { default: { kind: 'now' } } : {}) })
const int = (value = 0): ColumnSchema => ({ type: 'int', notNull: true, default: { kind: 'value', value } })
const id: ColumnSchema = { type: 'text', notNull: true, default: { kind: 'uuid' } }

// ----------------------------------------------------------------------------- schema

extendTable(C.accounts, {
  columns: {
    id, provider: text(true), address: text(true), display_name: text(), status: text(true, 'connected'), sync_enabled: bool(true),
    connected_by: text(), connected_at: ts(true), last_sync_at: ts(), last_sync_error: text(), cursor: json(), messages_synced: int(), is_demo: bool(false),
  },
})
extendTable(C.userAccess, {
  columns: { id: text(true), user_id: text(true), perms: json([], true), updated_by: text(), updated_at: ts(true) },
})
extendTable(C.emails, {
  columns: {
    id, account_id: text(true), provider: text(), provider_message_id: text(), thread_id: text(), folder: text(true, 'inbox'),
    from: json(), to: json([]), cc: json([]), subject: text(true, ''), date: ts(true), snippet: text(), body_text: text(), body_truncated: bool(false),
    attachments: json([]), message_id_header: text(), in_reply_to: text(), references: text(), status: text(true, 'new'), ai: json(), error: text(),
    is_demo: bool(false), created_at: ts(true),
  },
})
extendTable(C.drafts, {
  columns: {
    id, email_id: text(true), account_id: text(), thread_id: text(), to: json([]), cc: json([]), subject: text(true, ''), body: text(true, ''),
    language: text(true, 'en'), status: text(true, 'draft'), ai_generated: bool(true), instructions: text(), created_by: text(), created_at: ts(true),
    updated_at: ts(true), approved_by: text(), approved_at: ts(), sent_at: ts(), provider_message_id: text(), error: text(), is_demo: bool(false),
  },
})
extendTable(C.alerts, {
  columns: {
    id, dedupe_key: text(true), type: text(true), priority: text(true, 'medium'), title: text(true), description: text(true, ''), source: text(true, 'monitor'),
    record: json(), project: json(), recommended_action: text(true, ''), status: text(true, 'open'), first_seen_at: ts(true), last_seen_at: ts(true),
    resolved_at: ts(), acknowledged_by: text(), acknowledged_at: ts(), is_demo: bool(false),
  },
})
extendTable(C.reports, {
  columns: {
    id, title: text(true), kind: text(true, 'custom'), prompt: text(), content_md: text(true, ''), generated_by: text(true), generated_at: ts(true),
    model: text(true, ''), is_demo: bool(false),
  },
})
extendTable(C.chats, {
  columns: { id, user_id: text(true), title: text(true, 'New conversation'), messages: json([], true), created_at: ts(true), updated_at: ts(true) },
})
extendTable(C.memories, {
  columns: { id, user_id: text(true), text: text(true), source: text(true, 'chat'), created_at: ts(true), updated_at: ts(true) },
})
extendTable(C.knowledge, {
  columns: {
    id, title: text(true), body: text(true, ''), kind: text(true, 'note'), tags: json([], true), created_by: text(), created_at: ts(true), updated_at: ts(true),
    is_demo: bool(false),
  },
})
extendTable(C.activity, {
  columns: { id, at: ts(true), actor_id: text(true), action: text(true), detail: text(true, ''), record: json(), ok: bool(true), is_demo: bool(false) },
})
extendTable(C.usage, {
  columns: {
    id, at: ts(true), user_id: text(), purpose: text(true), model: text(true, ''), input_tokens: int(), output_tokens: int(), cache_read_tokens: int(),
    cost_usd: { type: 'numeric', notNull: true, default: { kind: 'value', value: 0 } },
  },
})
extendTable(C.settings, {
  columns: {
    id: text(true, 'settings'), enabled: bool(true), email_sync_enabled: bool(true), schedule_slip_threshold_pct: { type: 'numeric', notNull: true, default: { kind: 'value', value: 10 } },
    approval_stale_days: int(2), low_stock_alerts: bool(true), notify: json(DEFAULT_AI_SETTINGS.notify, true), reply_signature: text(true, ''),
    company_style_notes: text(true, ''), daily_chat_limit_per_user: int(200), updated_at: ts(true), updated_by: text(),
    // added in phase 1 of the voice engine: nullable, so settings saved before it keep working (defaults apply on read)
    chat_providers: json(DEFAULT_AI_SETTINGS.chat_providers), voice_enabled: { type: 'boolean', default: { kind: 'value', value: true } }, daily_voice_sessions_per_user: { type: 'int', default: { kind: 'value', value: 40 } },
  },
})
extendTable(C.status, {
  columns: {
    id: text(true, 'status'), ai_configured: bool(false), providers: json({ gmail: false, microsoft: false, imap: false }), ai_providers: json({ openai: false, gemini: false, claude: false }), last_monitor_at: ts(),
    last_monitor_ok: { type: 'boolean' }, last_monitor_error: text(), alerts_open: int(), last_sync_at: ts(), last_sync_error: text(), emails_total: int(),
    emails_pending_analysis: int(), updated_at: ts(true),
  },
})
// server-only (rules deny every client access); declared so a stray query fails cleanly instead of "unknown table"
extendTable(C.accountSecrets, { columns: { id } })
extendTable(C.oauthStates, { columns: { id } })

// ----------------------------------------------------------------------------- read scopes
// The rules decide; these keep list queries in a shape the rules can verify.
defineScope(C.chats, ownScope('user_id'))
defineScope(C.memories, ownScope('user_id'))
defineScope(C.activity, (me) => (me.can(AI_PERMS.manage) ? 'all' : [[{ field: 'actor_id', value: me.uid }]]))
for (const t of [C.emails, C.drafts, C.alerts, C.reports, C.knowledge, C.usage, C.settings, C.status, C.accounts]) defineScope(t, () => 'all')
// per-user AI grants: user administrators list them (User Management → Email access); a user reads only their own,
// by document id (session.ts loadMe) — matching firestore.rules /user_access
defineScope(C.userAccess, (me) => (me.can('users.manage') ? 'all' : []))
defineScope(C.accountSecrets, () => [])
defineScope(C.oauthStates, () => [])

enableAudit(C.settings, C.knowledge)

// ----------------------------------------------------------------------------- helpers

function need(ctx: WriteCtx, perm: string, what: string) {
  if (!ctx.me.active || !ctx.me.can(perm)) ctx.fail(`Not authorised to ${what}`, '42501')
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
function changed(row: Row, old: Row) {
  return [...new Set([...Object.keys(row), ...Object.keys(old)])].filter((k) => !same(row[k], old[k]))
}
const EMAIL_RE = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/

function parties(v: unknown, ctx: WriteCtx, field: string, required: boolean) {
  if (!Array.isArray(v)) ctx.fail(`${field} must be a list of recipients`, '23514')
  const list = v as Array<{ name?: unknown; address?: unknown }>
  if (required && !list.length) ctx.fail('A reply needs at least one recipient', '23514')
  if (list.length > 50) ctx.fail(`Too many recipients in ${field}`, '23514')
  return list.map((p) => {
    const address = String(p?.address ?? '').trim()
    if (!EMAIL_RE.test(address)) ctx.fail(`Invalid email address in ${field}: ${address || '(empty)'}`, '23514')
    const name = p?.name == null || p.name === '' ? null : String(p.name).slice(0, 200)
    return { name, address }
  })
}

function serverOnly(table: string, what: string) {
  const deny = (ctx: WriteCtx): never => ctx.fail(`${what} are written by the AI service only`, '42501')
  defineHooks(table, { beforeInsert: (_r, ctx) => deny(ctx), beforeUpdate: (_r, _o, ctx) => deny(ctx), beforeDelete: (_o, ctx) => deny(ctx) })
}

serverOnly(C.emails, 'Synchronised emails')
serverOnly(C.usage, 'AI usage records')
serverOnly(C.status, 'AI status records')
serverOnly(C.accounts, 'Email accounts')
serverOnly(C.accountSecrets, 'Email credentials')
serverOnly(C.userAccess, 'Per-user access grants')
serverOnly(C.oauthStates, 'OAuth states')

// ----------------------------------------------------------------------------- reply drafts

/** fields a person may edit on a reply draft (status 'draft' only) */
export const DRAFT_EDITABLE = ['body', 'subject', 'to', 'cc', 'language', 'updated_at'] as const

defineHooks(C.drafts, {
  beforeInsert(_row, ctx) {
    ctx.fail('Reply drafts are created by the AI service (Generate reply)', '42501')
  },
  beforeUpdate(row, old, ctx) {
    need(ctx, AI_PERMS.email, 'edit email replies')
    if (old.status !== 'draft') ctx.fail(`This reply is ${old.status} and can no longer be edited`, '42501')
    const keys = changed(row, old)
    if (row.status !== old.status) {
      if (row.status !== 'discarded') ctx.fail('Replies are approved and sent only through "Approve & Send"', '42501')
      if (keys.some((k) => k !== 'status' && k !== 'updated_at')) ctx.fail('Discarding a draft cannot change its content', '42501')
      return
    }
    const bad = keys.filter((k) => !(DRAFT_EDITABLE as readonly string[]).includes(k))
    if (bad.length) ctx.fail(`You cannot change ${bad.join(', ')} on a reply draft`, '42501')
    row.to = parties(row.to, ctx, 'To', true)
    row.cc = parties(row.cc ?? [], ctx, 'Cc', false)
    row.subject = String(row.subject ?? '').slice(0, 300)
    if (!row.subject.trim()) ctx.fail('Subject is required', '23514')
    if (String(row.body ?? '').length > 50_000) ctx.fail('The reply is too long', '23514')
    if (row.language !== 'en' && row.language !== 'sw') ctx.fail('Language must be English (en) or Kiswahili (sw)', '23514')
  },
  beforeDelete(_old, ctx) {
    ctx.fail('Reply drafts are kept for the audit trail; discard them instead', '42501')
  },
})

// ----------------------------------------------------------------------------- alerts

defineHooks(C.alerts, {
  beforeInsert(_row, ctx) {
    ctx.fail('Alerts are raised by the AI monitor', '42501')
  },
  beforeUpdate(row, old, ctx) {
    need(ctx, AI_PERMS.view, 'update alerts')
    const allowed = ['status', 'acknowledged_by', 'acknowledged_at', 'resolved_at']
    const bad = changed(row, old).filter((k) => !allowed.includes(k))
    if (bad.length) ctx.fail(`You cannot change ${bad.join(', ')} on an alert`, '42501')
    if (row.status === old.status) return
    if (row.status === 'acknowledged') {
      if (old.status !== 'open') ctx.fail('Only open alerts can be acknowledged', '23514')
      row.acknowledged_by = ctx.me.uid
      row.acknowledged_at = ctx.now
    } else if (row.status === 'resolved') {
      row.resolved_at = ctx.now
      if (!old.acknowledged_by) {
        row.acknowledged_by = ctx.me.uid
        row.acknowledged_at = ctx.now
      }
    } else ctx.fail('An alert can be acknowledged or resolved', '23514')
  },
  beforeDelete(_old, ctx) {
    ctx.fail('Alerts cannot be deleted; resolve them instead', '42501')
  },
})

// ----------------------------------------------------------------------------- reports

const REPORT_KINDS = ['daily_brief', 'operations', 'project', 'email_digest', 'custom']
defineHooks(C.reports, {
  beforeInsert(row, ctx) {
    need(ctx, AI_PERMS.view, 'save AI reports')
    row.generated_by = ctx.me.uid
    row.generated_at = ctx.now
    row.is_demo = !!row.is_demo
    if (!REPORT_KINDS.includes(row.kind)) row.kind = 'custom'
    row.title = String(row.title ?? '').trim().slice(0, 200) || 'AI report'
    if (String(row.content_md ?? '').length > 400_000) ctx.fail('The report is too long to save', '23514')
  },
  beforeUpdate(_row, _old, ctx) {
    ctx.fail('Saved AI reports cannot be changed', '42501')
  },
  beforeDelete(_old, ctx) {
    ctx.fail('Saved AI reports cannot be deleted', '42501')
  },
})

// ----------------------------------------------------------------------------- chats (private)

const MAX_CHAT_MESSAGES = 120
function cleanMessages(v: unknown, ctx: WriteCtx) {
  if (!Array.isArray(v)) ctx.fail('messages must be a list', '23514')
  return (v as Row[]).slice(-MAX_CHAT_MESSAGES).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    text: String(m.text ?? '').slice(0, 60_000),
    at: String(m.at ?? ctx.now),
    ...(Array.isArray(m.tools_used) ? { tools_used: m.tools_used.map(String).slice(0, 30) } : {}),
    ...(Array.isArray(m.links) ? { links: m.links.slice(0, 30) } : {}),
  }))
}

defineHooks(C.chats, {
  beforeInsert(row, ctx) {
    need(ctx, AI_PERMS.view, 'use the AI assistant')
    row.user_id = ctx.me.uid
    row.title = String(row.title ?? '').trim().slice(0, 120) || 'New conversation'
    row.messages = cleanMessages(row.messages ?? [], ctx)
  },
  beforeUpdate(row, old, ctx) {
    need(ctx, AI_PERMS.view, 'use the AI assistant')
    if (old.user_id !== ctx.me.uid || row.user_id !== old.user_id) ctx.fail('Conversations are private to their owner', '42501')
    row.title = String(row.title ?? '').trim().slice(0, 120) || 'New conversation'
    row.messages = cleanMessages(row.messages ?? [], ctx)
  },
  beforeDelete(old, ctx) {
    if (old.user_id !== ctx.me.uid) ctx.fail('Conversations are private to their owner', '42501')
  },
})

// ----------------------------------------------------------------------------- memories (private to the user)

const MEMORY_SOURCES = ['chat', 'voice', 'manual']
function memoryCheck(row: Row, ctx: WriteCtx) {
  row.text = String(row.text ?? '').replace(/\s+/g, ' ').trim()
  if (!row.text) ctx.fail('Nothing to remember', '23514')
  if (row.text.length > AI_MEMORY_LIMITS.maxChars) ctx.fail(`A memory can be at most ${AI_MEMORY_LIMITS.maxChars} characters`, '23514')
  if (!MEMORY_SOURCES.includes(row.source)) row.source = 'chat'
}
defineHooks(C.memories, {
  beforeInsert(row, ctx) {
    need(ctx, AI_PERMS.view, 'use the AI assistant')
    row.user_id = ctx.me.uid
    memoryCheck(row, ctx)
  },
  beforeUpdate(row, old, ctx) {
    need(ctx, AI_PERMS.view, 'use the AI assistant')
    if (old.user_id !== ctx.me.uid || row.user_id !== old.user_id) ctx.fail('Memories are private to their owner', '42501')
    memoryCheck(row, ctx)
  },
  beforeDelete(old, ctx) {
    if (old.user_id !== ctx.me.uid) ctx.fail('Memories are private to their owner', '42501')
  },
})

// ----------------------------------------------------------------------------- knowledge base

const KNOWLEDGE_KINDS = ['company', 'policy', 'decision', 'note']
function knowledgeCheck(row: Row, ctx: WriteCtx) {
  row.title = String(row.title ?? '').trim().slice(0, 200)
  if (!row.title) ctx.fail('Title is required', '23514')
  if (!KNOWLEDGE_KINDS.includes(row.kind)) ctx.fail('Kind must be company, policy, decision or note', '23514')
  if (String(row.body ?? '').length > 100_000) ctx.fail('The note is too long', '23514')
  row.tags = Array.isArray(row.tags) ? [...new Set(row.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20) : []
}
defineHooks(C.knowledge, {
  beforeInsert(row, ctx) {
    need(ctx, AI_PERMS.manage, 'manage the knowledge base')
    row.created_by = ctx.me.uid
    row.created_at = ctx.now
    row.updated_at = ctx.now
    knowledgeCheck(row, ctx)
  },
  beforeUpdate(row, old, ctx) {
    need(ctx, AI_PERMS.manage, 'manage the knowledge base')
    row.created_by = old.created_by
    row.created_at = old.created_at
    knowledgeCheck(row, ctx)
  },
  beforeDelete(_old, ctx) {
    need(ctx, AI_PERMS.manage, 'manage the knowledge base')
  },
})

// ----------------------------------------------------------------------------- activity (audit trail)

defineHooks(C.activity, {
  beforeInsert(row, ctx) {
    need(ctx, AI_PERMS.view, 'use the AI assistant')
    if (!['chat', 'report', 'voice', 'assistant_action'].includes(String(row.action))) ctx.fail('The app may only record chat, report, voice and assistant-action activity', '42501')
    row.actor_id = ctx.me.uid
    row.at = ctx.now
    row.ok = row.ok !== false
    row.detail = String(row.detail ?? '').slice(0, 500)
    row.is_demo = !!row.is_demo
  },
  beforeUpdate(_r, _o, ctx) {
    ctx.fail('AI activity entries cannot be changed', '42501')
  },
  beforeDelete(_o, ctx) {
    ctx.fail('AI activity entries cannot be deleted', '42501')
  },
})

// ----------------------------------------------------------------------------- settings

function settingsCheck(row: Row, ctx: WriteCtx) {
  need(ctx, AI_PERMS.manage, 'change AI settings')
  if (row.id !== 'settings') ctx.fail('AI settings live in the single document "settings"', '23514')
  const pct = Number(row.schedule_slip_threshold_pct)
  if (!(pct >= 0 && pct <= 100)) ctx.fail('Schedule slip threshold must be 0–100 %', '23514')
  const days = Number(row.approval_stale_days)
  if (!(days >= 0 && days <= 60)) ctx.fail('Approval reminder must be 0–60 days', '23514')
  const lim = Number(row.daily_chat_limit_per_user)
  if (!(lim >= 0 && lim <= 10_000)) ctx.fail('Daily limit must be 0–10000', '23514')
  const n: Row = row.notify && typeof row.notify === 'object' ? row.notify : {}
  row.notify = Object.fromEntries(Object.keys(DEFAULT_AI_SETTINGS.notify).map((k) => [k, n[k] !== false]))
  row.reply_signature = String(row.reply_signature ?? '').slice(0, 2000)
  row.company_style_notes = String(row.company_style_notes ?? '').slice(0, 4000)
  // provider order: known ids, no duplicates, at least one
  const order = Array.isArray(row.chat_providers) ? [...new Set(row.chat_providers.filter((p: unknown) => CHAT_PROVIDERS.includes(p as ChatProviderId)))] : []
  row.chat_providers = order.length ? order : [...DEFAULT_AI_SETTINGS.chat_providers]
  row.updated_by = ctx.me.uid
  row.updated_at = ctx.now
}
defineHooks(C.settings, {
  beforeInsert: (row, ctx) => settingsCheck(row, ctx),
  beforeUpdate: (row, _old, ctx) => settingsCheck(row, ctx),
  beforeDelete(_o, ctx) {
    ctx.fail('AI settings cannot be deleted', '42501')
  },
})

/** allowed values (re-exported for the UI) */
export const AI_ENUMS = { priorities: PRIORITIES, alertTypes: ALERT_TYPES, reportKinds: REPORT_KINDS, knowledgeKinds: KNOWLEDGE_KINDS }
