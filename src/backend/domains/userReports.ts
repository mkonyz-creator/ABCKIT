/**
 * Reports to the admin (src/shared/userReports.ts). Mirrors firebase/rules/10_core.rules `match /user_reports`:
 *  - any active user creates a report as themself (status 'open', no reply yet) → every administrator is notified
 *  - the reporter reads their own reports and may close (withdraw) one; nothing else
 *  - administrators (users.manage) read all, reply and change the status (stamped handled_by / handled_at)
 *    → the reporter is notified; only they may delete a report
 */
import {
  REPORT_CATEGORIES,
  REPORT_LIMITS,
  REPORT_PRIORITIES,
  REPORT_STATUSES,
  STATUS_LABEL,
  USER_REPORT_ADMIN_PERM as ADMIN,
  USER_REPORTS as T,
} from '../../shared/userReports'
import { defineHooks, defineScope, enableAudit, extendTable, type Row, type WriteCtx } from '../registry'
import type { ColumnSchema } from '../types'

const text = (notNull = false, value?: unknown): ColumnSchema => ({ type: 'text', notNull, ...(value !== undefined ? { default: { kind: 'value', value } } : {}) })
const ts = (now = false): ColumnSchema => ({ type: 'timestamptz', notNull: now, ...(now ? { default: { kind: 'now' } } : {}) })

extendTable(T, {
  columns: {
    id: { type: 'text', notNull: true, default: { kind: 'uuid' } },
    reporter_id: text(true),
    category: text(true, 'problem'),
    priority: text(true, 'normal'),
    subject: text(true),
    body: text(true),
    page: text(),
    status: text(true, 'open'),
    admin_reply: text(),
    handled_by: text(),
    handled_at: ts(),
    created_at: ts(true),
    updated_at: ts(true),
  },
})
enableAudit(T)

defineScope(T, (me) => (me.can(ADMIN) ? 'all' : [[{ field: 'reporter_id', value: me.uid }]]))

const clean = (v: unknown) => String(v ?? '').replace(/\r\n/g, '\n').trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function validate(row: Row, ctx: WriteCtx) {
  row.subject = clean(row.subject).replace(/\s+/g, ' ')
  row.body = clean(row.body)
  if (!row.subject) ctx.fail('Write a short subject for the report', '23514')
  if (row.subject.length > REPORT_LIMITS.subject) ctx.fail(`The subject can be at most ${REPORT_LIMITS.subject} characters`, '23514')
  if (!row.body) ctx.fail('Describe what you want to report', '23514')
  if (row.body.length > REPORT_LIMITS.body) ctx.fail(`The report can be at most ${REPORT_LIMITS.body} characters`, '23514')
  if (!(REPORT_CATEGORIES as readonly string[]).includes(row.category)) row.category = 'other'
  if (!(REPORT_PRIORITIES as readonly string[]).includes(row.priority)) row.priority = 'normal'
  row.page = row.page ? clip(clean(row.page), REPORT_LIMITS.page) : null
}

defineHooks(T, {
  beforeInsert(row, ctx) {
    if (!ctx.me.active) ctx.fail('Your account is not active', '42501')
    row.reporter_id = ctx.me.uid
    row.status = 'open'
    row.admin_reply = null
    row.handled_by = null
    row.handled_at = null
    validate(row, ctx)
  },
  beforeUpdate(row, old, ctx) {
    const fixed = ['reporter_id', 'category', 'priority', 'subject', 'body', 'page', 'created_at']
    if (fixed.some((k) => JSON.stringify(row[k] ?? null) !== JSON.stringify(old[k] ?? null))) ctx.fail('A sent report cannot be edited — send a new one', '42501')
    if (!(REPORT_STATUSES as readonly string[]).includes(row.status)) ctx.fail('Unknown report status', '23514')
    if (ctx.me.can(ADMIN)) {
      row.admin_reply = clean(row.admin_reply) || null
      if (row.admin_reply && row.admin_reply.length > REPORT_LIMITS.reply) ctx.fail(`The reply can be at most ${REPORT_LIMITS.reply} characters`, '23514')
      row.handled_by = ctx.me.uid
      row.handled_at = ctx.now
      return
    }
    if (old.reporter_id !== ctx.me.uid) ctx.fail('Only an administrator can handle this report', '42501')
    // the reporter may only withdraw (close) their own report
    const touched = ['admin_reply', 'handled_by', 'handled_at'].some((k) => (row[k] ?? null) !== (old[k] ?? null))
    if (touched || row.status !== 'closed') ctx.fail('Only an administrator can reply to or reopen a report', '42501')
  },
  beforeDelete(_old, ctx) {
    if (!ctx.me.can(ADMIN)) ctx.fail('Only an administrator can delete a report', '42501')
  },
  async afterInsert(row, ctx) {
    const who = String(ctx.me.profile?.full_name ?? '').trim() || ctx.me.email || 'A user'
    await ctx.notifyPermission(
      ADMIN,
      `${row.priority === 'urgent' ? 'URGENT report' : 'New report'}: ${clip(row.subject, 80)}`,
      `${who} — ${clip(row.body, 160)}`,
      row.priority === 'urgent' || row.priority === 'high' || row.category === 'safety' ? 'alert' : 'info',
      `/report-to-admin?tab=inbox&id=${row.id}`,
    )
  },
  async afterUpdate(row, old, ctx) {
    if (row.reporter_id === ctx.me.uid) return
    const replied = (row.admin_reply ?? null) !== (old.admin_reply ?? null) && !!row.admin_reply
    if (!replied && row.status === old.status) return
    const status = STATUS_LABEL[row.status as keyof typeof STATUS_LABEL]?.en ?? row.status
    await ctx.notifyUser(
      row.reporter_id,
      replied ? `Admin replied: ${clip(row.subject, 80)}` : `Your report is now ${status.toLowerCase()}: ${clip(row.subject, 80)}`,
      replied ? clip(row.admin_reply, 200) : null,
      row.status === 'resolved' ? 'success' : 'info',
      `/report-to-admin?id=${row.id}`,
    )
  },
})
