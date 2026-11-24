/** AI audit trail (ai_activity), ABCkit audit_logs, model usage (ai_usage), AI settings and status. */
import { randomUUID } from 'node:crypto'
import { logger } from 'firebase-functions/v2'
import type { AiActivity, AiActivityAction, AiSettings, AiStatus, AiUsage, ChatProviderId } from '../shared/ai/contract.js'
import { AI_COLLECTIONS, CHAT_PROVIDERS, DEFAULT_AI_SETTINGS } from '../shared/ai/contract.js'
import type { Db, Row } from './admin.js'

export const nowIso = () => new Date().toISOString()

export async function writeActivity(
  db: Db,
  actor: string,
  action: AiActivityAction,
  detail: string,
  record: { table: string; id: string } | null = null,
  ok = true,
): Promise<void> {
  const id = randomUUID()
  const row: AiActivity = { id, at: nowIso(), actor_id: actor, action, detail: detail.slice(0, 2000), record, ok, is_demo: false }
  try {
    await db.doc(`${AI_COLLECTIONS.activity}/${id}`).set(row)
  } catch (e) {
    logger.error('ai_activity write failed', e)
  }
}

/** Same shape as the rows adminUsers writes. */
export async function writeAuditLog(
  db: Db,
  changedBy: string,
  table: string,
  recordId: string,
  action: 'INSERT' | 'UPDATE' | 'DELETE',
  oldData: Row | null,
  newData: Row | null,
): Promise<void> {
  const id = randomUUID()
  await db.doc(`audit_logs/${id}`).set({
    id,
    table_name: table,
    record_id: recordId,
    action,
    old_data: oldData,
    new_data: newData,
    changed_by: changedBy,
    changed_at: nowIso(),
  })
}

// ----------------------------------------------------------------------------- usage & cost

/** Claude Opus 5.5 list prices, USD per million tokens. */
export const PRICE_PER_MTOK = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }

export interface UsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function estimateCost(u: UsageLike): number {
  const input = (u.input_tokens ?? 0) * PRICE_PER_MTOK.input
  const output = (u.output_tokens ?? 0) * PRICE_PER_MTOK.output
  const cacheRead = (u.cache_read_input_tokens ?? 0) * PRICE_PER_MTOK.cache_read
  const cacheWrite = (u.cache_creation_input_tokens ?? 0) * PRICE_PER_MTOK.cache_write
  return Math.round(((input + output + cacheRead + cacheWrite) / 1_000_000) * 1_000_000) / 1_000_000
}

/** `provider` other than Claude: tokens are recorded, cost is not estimated (provider prices differ; see their dashboards) */
export async function recordUsage(db: Db, userId: string | null, purpose: AiUsage['purpose'], model: string, u: UsageLike, provider: ChatProviderId = 'claude'): Promise<void> {
  const id = randomUUID()
  const row: AiUsage = {
    id,
    at: nowIso(),
    user_id: userId,
    purpose,
    model,
    // input_tokens counts uncached + cache-write tokens (both are billed at or above the input rate)
    input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cost_usd: provider === 'claude' ? estimateCost(u) : 0,
  }
  try {
    await db.doc(`${AI_COLLECTIONS.usage}/${id}`).set(row)
  } catch (e) {
    logger.error('ai_usage write failed', e)
  }
}

// ----------------------------------------------------------------------------- settings & status

export type EffectiveSettings = Omit<AiSettings, 'updated_at' | 'updated_by'> & Partial<Pick<AiSettings, 'updated_at' | 'updated_by'>>

/** a de-duplicated list of known providers; an empty / invalid list falls back to the default order */
export function providerList(v: unknown, d: ChatProviderId[]): ChatProviderId[] {
  if (!Array.isArray(v)) return [...d]
  const out = [...new Set(v.filter((x): x is ChatProviderId => CHAT_PROVIDERS.includes(x as ChatProviderId)))]
  return out.length ? out : [...d]
}

export function mergeSettings(raw: Row | undefined | null): EffectiveSettings {
  const r = raw ?? {}
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
  const d = DEFAULT_AI_SETTINGS
  const notify = { ...d.notify }
  if (r.notify && typeof r.notify === 'object') for (const k of Object.keys(notify) as Array<keyof typeof notify>) notify[k] = bool(r.notify[k], notify[k])
  return {
    id: 'settings',
    enabled: bool(r.enabled, d.enabled),
    email_sync_enabled: bool(r.email_sync_enabled, d.email_sync_enabled),
    schedule_slip_threshold_pct: num(r.schedule_slip_threshold_pct, d.schedule_slip_threshold_pct),
    approval_stale_days: num(r.approval_stale_days, d.approval_stale_days),
    low_stock_alerts: bool(r.low_stock_alerts, d.low_stock_alerts),
    notify,
    reply_signature: str(r.reply_signature, d.reply_signature),
    company_style_notes: str(r.company_style_notes, d.company_style_notes),
    daily_chat_limit_per_user: num(r.daily_chat_limit_per_user, d.daily_chat_limit_per_user),
    chat_providers: providerList(r.chat_providers, d.chat_providers),
    voice_enabled: bool(r.voice_enabled, d.voice_enabled),
    daily_voice_sessions_per_user: num(r.daily_voice_sessions_per_user, d.daily_voice_sessions_per_user),
    updated_at: r.updated_at,
    updated_by: r.updated_by,
  }
}

export async function loadSettings(db: Db): Promise<EffectiveSettings> {
  const snap = await db.doc(`${AI_COLLECTIONS.settings}/settings`).get()
  return mergeSettings(snap.exists ? snap.data() : null)
}

export async function patchStatus(db: Db, patch: Partial<AiStatus>): Promise<void> {
  try {
    await db.doc(`${AI_COLLECTIONS.status}/status`).set({ id: 'status', ...patch, updated_at: nowIso() }, { merge: true })
  } catch (e) {
    logger.error('ai_status write failed', e)
  }
}
