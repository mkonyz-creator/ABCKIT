/**
 * Reply drafts (AI-written) and the human-approved send. Nothing is ever sent except by sendDraft, which requires
 * ai.email_send, a draft in status draft/approved, a non-demo draft/email/account, and records the approver.
 */
import { randomUUID } from 'node:crypto'
import { HttpsError } from 'firebase-functions/v2/https'
import type { AiEmail, AiEmailDraft, CallableContracts, EmailAccount, EmailParty } from '../shared/ai/contract.js'
import { AI_COLLECTIONS, AI_PERMS } from '../shared/ai/contract.js'
import type { Db, Row } from '../lib/admin.js'
import type { AiCaller } from '../lib/auth.js'
import { loadSettings, nowIso, recordUsage, writeActivity, writeAuditLog } from '../lib/audit.js'
import { aiNotConfigured, assertUsable, FALLBACK_PARAMS, MODEL, textOf, toHttpsError, type AnthropicLike } from '../ai/claude.js'
import { REPLY_SYSTEM_PROMPT } from '../ai/prompts.js'
import { fenceUntrusted } from './analyze.js'
import { replyReferences, replySubject } from './message.js'
import type { MailSession } from './provider.js'

export const THREAD_LIMIT = 10
const PER_MESSAGE_CHARS = 12_000
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const idArg = (data: unknown, key: string) => {
  const v = String(((data ?? {}) as Row)[key] ?? '')
  if (!v || v.length > 1500 || v.includes('/')) throw new HttpsError('invalid-argument', `${key} is required`)
  return v
}

export async function loadThread(db: Db, email: AiEmail): Promise<AiEmail[]> {
  if (!email.thread_id) return [email]
  const snap = await db.collection(AI_COLLECTIONS.emails).where('thread_id', '==', email.thread_id).get()
  const all = snap.docs.map((d) => d.data() as AiEmail).filter((e) => e.account_id === email.account_id)
  if (!all.some((e) => e.id === email.id)) all.push(email)
  all.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  // the email being answered plus the messages before it, at most THREAD_LIMIT
  const idx = all.findIndex((e) => e.id === email.id)
  return all.slice(Math.max(0, idx + 1 - THREAD_LIMIT), idx + 1)
}

export function threadText(thread: AiEmail[], targetId: string): string {
  const party = (p: EmailParty) => (p.name ? `${p.name} <${p.address}>` : p.address)
  return [
    '<thread>',
    ...thread.map((e) => {
      const full = e.id === targetId
      let body = e.body_text || '(empty body)'
      let note = e.body_truncated ? ' (body was truncated when stored)' : ''
      if (!full && body.length > PER_MESSAGE_CHARS) {
        body = body.slice(0, PER_MESSAGE_CHARS)
        note += ' (earlier message shortened for context)'
      }
      return [
        `<message folder="${e.folder}"${full ? ' answer_this="true"' : ''}>`,
        `From: ${fenceUntrusted(party(e.from))}`,
        `To: ${fenceUntrusted(e.to.map(party).join(', '))}`,
        `Date: ${e.date}`,
        `Subject: ${fenceUntrusted(e.subject)}${note}`,
        '',
        fenceUntrusted(body),
        '</message>',
      ].join('\n')
    }),
    '</thread>',
  ].join('\n')
}

export interface ReplyDeps {
  db: Db
  client: AnthropicLike | null
}

export async function generateReply(deps: ReplyDeps, caller: AiCaller, data: unknown): Promise<CallableContracts['emailGenerateReply']['res']> {
  const body = (data ?? {}) as Row
  const emailId = idArg(data, 'email_id')
  const language = body.language
  if (language !== 'en' && language !== 'sw') throw new HttpsError('invalid-argument', 'language must be "en" or "sw"')
  const instructions = typeof body.instructions === 'string' && body.instructions.trim() ? body.instructions.trim().slice(0, 2000) : null
  const settings = await loadSettings(deps.db)
  if (!settings.enabled) throw new HttpsError('failed-precondition', 'AI features are switched off in the AI Control Center.')
  if (!deps.client) throw aiNotConfigured()

  const snap = await deps.db.doc(`${AI_COLLECTIONS.emails}/${emailId}`).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Email not found')
  const email = snap.data() as AiEmail
  const account = (await deps.db.doc(`${AI_COLLECTIONS.accounts}/${email.account_id}`).get()).data() as EmailAccount | undefined
  const company = (await deps.db.doc('company_settings/1').get()).data()
  const companyName = String(company?.company_name || 'ARICOM BUILDING CONTRACTORS')
  const thread = await loadThread(deps.db, email)

  const task = [
    `Write the reply to the message marked answer_this="true".`,
    `Language: ${language === 'sw' ? 'Kiswahili' : 'English'}.`,
    `Company: ${companyName}. The reply is sent from ${account?.address ?? 'the company mailbox'}${account?.display_name ? ` (${account.display_name})` : ''}.`,
    `Company style notes: ${settings.company_style_notes || 'Professional and concise.'}`,
    instructions ? `Instructions from the ARICOM staff member preparing this reply (trusted): ${instructions}` : 'No extra instructions from staff.',
    `End the reply with this signature exactly:\n${settings.reply_signature}`,
  ].join('\n')

  let msg
  try {
    msg = await deps.client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: REPLY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: threadText(thread, email.id) }, { type: 'text', text: task }] }],
        ...FALLBACK_PARAMS,
      })
      .finalMessage()
  } catch (e) {
    await writeActivity(deps.db, caller.uid, 'reply_generated', `Reply generation failed: ${(e as Error)?.message ?? e}`, { table: AI_COLLECTIONS.emails, id: email.id }, false)
    throw toHttpsError(e)
  }
  await recordUsage(deps.db, caller.uid, 'reply', msg.model ?? MODEL, msg.usage)
  try {
    assertUsable(msg, 'reply')
  } catch (e) {
    await writeActivity(deps.db, caller.uid, 'reply_generated', (e as Error).message, { table: AI_COLLECTIONS.emails, id: email.id }, false)
    throw toHttpsError(e)
  }
  let text = textOf(msg)
  if (!text) throw new HttpsError('aborted', 'The AI returned an empty reply.')
  const sig = settings.reply_signature.trim()
  if (sig && !text.includes(sig)) text = `${text}\n\n${sig}`

  const own = account?.address?.toLowerCase()
  const to = email.folder === 'sent' ? email.to : [email.from]
  const now = nowIso()
  const draft: AiEmailDraft = {
    id: randomUUID(),
    email_id: email.id,
    account_id: email.account_id,
    thread_id: email.thread_id,
    to: to.filter((p) => p.address && p.address.toLowerCase() !== own),
    cc: [],
    subject: replySubject(email.subject),
    body: text,
    language,
    status: 'draft',
    ai_generated: true,
    instructions,
    created_by: caller.uid,
    created_at: now,
    updated_at: now,
    approved_by: null,
    approved_at: null,
    sent_at: null,
    provider_message_id: null,
    error: null,
    is_demo: email.is_demo === true,
  }
  await deps.db.doc(`${AI_COLLECTIONS.drafts}/${draft.id}`).set(draft)
  await writeActivity(deps.db, caller.uid, 'reply_generated', `Drafted a ${language === 'sw' ? 'Kiswahili' : 'English'} reply to "${email.subject.slice(0, 120)}"`, { table: AI_COLLECTIONS.drafts, id: draft.id })
  return { draft_id: draft.id }
}

// ----------------------------------------------------------------------------- send (human approved)

export interface SendDeps {
  db: Db
  openSession: (account: EmailAccount) => Promise<MailSession>
}

const validParties = (list: unknown): list is EmailParty[] =>
  Array.isArray(list) && list.every((p) => p && typeof p === 'object' && typeof (p as EmailParty).address === 'string' && EMAIL_RE.test((p as EmailParty).address))

export async function sendDraft(deps: SendDeps, caller: AiCaller, data: unknown): Promise<CallableContracts['emailSendDraft']['res']> {
  if (!caller.can(AI_PERMS.send)) throw new HttpsError('permission-denied', 'You do not have permission to approve and send emails (ai.email_send)')
  const draftId = idArg(data, 'draft_id')
  const ref = deps.db.doc(`${AI_COLLECTIONS.drafts}/${draftId}`)
  const now = nowIso()

  // approval gate (transaction: two clicks cannot send twice)
  const draft = await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'Draft not found')
    const d = snap.data() as AiEmailDraft
    if (d.is_demo) throw new HttpsError('failed-precondition', 'Demo drafts are never sent.')
    if (d.status !== 'draft' && d.status !== 'approved')
      throw new HttpsError('failed-precondition', d.status === 'discarded' ? 'This draft was discarded.' : `This draft cannot be sent (status: ${d.status}).`)
    if (!validParties(d.to) || !d.to.length) throw new HttpsError('failed-precondition', 'The draft has no valid recipient.')
    if (!validParties(d.cc ?? [])) throw new HttpsError('failed-precondition', 'The draft has an invalid Cc address.')
    if (typeof d.body !== 'string' || !d.body.trim()) throw new HttpsError('failed-precondition', 'The draft is empty.')
    if (typeof d.subject !== 'string' || !d.subject.trim()) throw new HttpsError('failed-precondition', 'The draft has no subject.')
    tx.update(ref, { status: 'sending', approved_by: caller.uid, approved_at: now, updated_at: now, error: null })
    return d
  })
  await writeActivity(deps.db, caller.uid, 'draft_approved', `Approved reply "${draft.subject.slice(0, 120)}" for sending`, { table: AI_COLLECTIONS.drafts, id: draftId })

  const fail = async (message: string): Promise<never> => {
    const failed = { status: 'failed' as const, error: message.slice(0, 500), updated_at: nowIso() }
    await ref.update(failed)
    await writeAuditLog(deps.db, caller.uid, AI_COLLECTIONS.drafts, draftId, 'UPDATE', { ...draft, status: 'sending' }, { ...draft, ...failed, approved_by: caller.uid, approved_at: now })
    await writeActivity(deps.db, caller.uid, 'email_sent', `Sending "${draft.subject.slice(0, 120)}" failed: ${message}`, { table: AI_COLLECTIONS.drafts, id: draftId }, false)
    throw new HttpsError('aborted', message)
  }

  const email = (await deps.db.doc(`${AI_COLLECTIONS.emails}/${draft.email_id}`).get()).data() as AiEmail | undefined
  const account = (await deps.db.doc(`${AI_COLLECTIONS.accounts}/${draft.account_id}`).get()).data() as EmailAccount | undefined
  if (!account) return fail('The mailbox for this draft no longer exists.')
  if (account.is_demo || email?.is_demo) return fail('Demo emails are never sent.')
  if (account.status === 'disconnected') return fail('The mailbox is disconnected. Reconnect it in AI settings, then send again.')

  let providerMessageId: string | null = null
  let session: MailSession | null = null
  try {
    session = await deps.openSession(account)
    const res = await session.send({
      from: { name: account.display_name, address: account.address },
      to: draft.to,
      cc: draft.cc ?? [],
      subject: draft.subject,
      body: draft.body,
      inReplyTo: email?.message_id_header ?? null,
      references: email ? replyReferences(email) : null,
      threadId: account.provider === 'gmail' ? (email?.thread_id ?? draft.thread_id) : null,
      replyToProviderId: account.provider === 'microsoft' && email ? email.provider_message_id : null,
    })
    providerMessageId = res.providerMessageId
  } catch (e) {
    await session?.close().catch(() => undefined)
    return fail(`The email could not be sent: ${(e as Error)?.message ?? e}`)
  }
  await session.close().catch(() => undefined)

  const sentAt = nowIso()
  const patch = { status: 'sent' as const, sent_at: sentAt, provider_message_id: providerMessageId, error: null, updated_at: sentAt }
  await ref.update(patch)
  await writeAuditLog(deps.db, caller.uid, AI_COLLECTIONS.drafts, draftId, 'UPDATE', { ...draft }, { ...draft, ...patch, approved_by: caller.uid, approved_at: now })
  await writeActivity(deps.db, caller.uid, 'email_sent', `Sent reply "${draft.subject.slice(0, 120)}" to ${draft.to.map((p) => p.address).join(', ')}`, { table: AI_COLLECTIONS.drafts, id: draftId })
  return { ok: true, sent_at: sentAt }
}
