/** Provider-neutral email message model + helpers shared by the Gmail / Graph / IMAP adapters. */
import type { AiEmail, EmailParty, EmailProvider } from '../shared/ai/contract.js'

export const BODY_LIMIT = 50_000
export const SNIPPET_LIMIT = 300

export interface AttachmentMeta {
  name: string
  mime: string
  size: number
  /** provider handle used to download the content later (Gmail attachmentId, Graph attachment id, IMAP part) */
  ref: string | null
  inline: boolean
}

export interface ParsedMessage {
  provider_message_id: string
  thread_id: string | null
  folder: 'inbox' | 'sent'
  from: EmailParty
  to: EmailParty[]
  cc: EmailParty[]
  subject: string
  date: string
  snippet: string
  body_text: string
  body_truncated: boolean
  attachments: AttachmentMeta[]
  message_id_header: string | null
  in_reply_to: string | null
  references: string | null
  /** sortable cursor value (ms epoch / ISO / uid) */
  cursor: number | string
  /** attachment contents already in memory (IMAP), keyed by ref */
  attachmentData?: Map<string, Buffer>
}

/** Firestore doc ids cannot contain '/'; provider ids are URI-encoded. */
export function emailDocId(accountId: string, providerMessageId: string): string {
  return `${accountId}__${encodeURIComponent(providerMessageId)}`
}

export function truncateBody(text: string): { body_text: string; body_truncated: boolean } {
  const clean = text.replace(/\u0000/g, '')
  return clean.length > BODY_LIMIT ? { body_text: clean.slice(0, BODY_LIMIT), body_truncated: true } : { body_text: clean, body_truncated: false }
}

export function makeSnippet(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > SNIPPET_LIMIT ? `${s.slice(0, SNIPPET_LIMIT - 1)}…` : s
}

/** Decodes RFC 2047 encoded-words (=?utf-8?B?...?= / =?iso-8859-1?Q?...?=) in a header value. */
export function decodeMimeWords(v: string): string {
  return v.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, charset: string, enc: string, data: string) => {
    try {
      const buf =
        enc.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
      const cs = charset.toLowerCase().split('*')[0]
      return new TextDecoder(cs === 'utf8' ? 'utf-8' : cs).decode(buf)
    } catch {
      return data
    }
  })
}

/** Parses an address list header ("Name" <a@b.c>, d@e.f, Group: x@y.z;) into parties. */
export function parseAddressList(header: string | null | undefined): EmailParty[] {
  if (!header) return []
  const value = decodeMimeWords(header)
  const out: EmailParty[] = []
  // split on commas/semicolons outside quotes and angle brackets
  let cur = ''
  let inQ = false
  let inA = false
  const parts: string[] = []
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '"' && value[i - 1] !== '\\') inQ = !inQ
    else if (!inQ && ch === '<') inA = true
    else if (!inQ && ch === '>') inA = false
    if (!inQ && !inA && (ch === ',' || ch === ';')) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  for (let p of parts) {
    p = p.trim()
    if (!p) continue
    // group syntax "Team: a@b.c" → drop the group label
    const colon = p.indexOf(':')
    const lt = p.indexOf('<')
    if (colon >= 0 && (lt < 0 || colon < lt) && !/["@]/.test(p.slice(0, colon))) p = p.slice(colon + 1).trim()
    if (!p) continue
    const m = p.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/)
    if (m) {
      const name = m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').trim()
      out.push({ name: name || null, address: m[2].trim().toLowerCase() })
    } else {
      const a = p.replace(/\(.*?\)/g, '').trim()
      if (/^[^\s@]+@[^\s@]+$/.test(a)) out.push({ name: null, address: a.toLowerCase() })
    }
  }
  return out
}

export function firstAddress(header: string | null | undefined): EmailParty {
  return parseAddressList(header)[0] ?? { name: null, address: '' }
}

/** Thread key for providers without native threads: root of References, else In-Reply-To, else own Message-ID. */
export function deriveThreadId(messageId: string | null, inReplyTo: string | null, references: string | null): string | null {
  const refs = (references ?? '').match(/<[^<>]+>/g)
  if (refs?.length) return refs[0]
  const irt = (inReplyTo ?? '').match(/<[^<>]+>/)
  if (irt) return irt[0]
  return messageId
}

export function toIso(v: unknown, fallback = new Date(0).toISOString()): string {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : fallback
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v).toISOString() : fallback
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t).toISOString() : fallback
  }
  return fallback
}

export function toAiEmail(accountId: string, provider: EmailProvider, m: ParsedMessage, now: string): AiEmail {
  return {
    id: emailDocId(accountId, m.provider_message_id),
    account_id: accountId,
    provider,
    provider_message_id: m.provider_message_id,
    thread_id: m.thread_id,
    folder: m.folder,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
    body_text: m.body_text,
    body_truncated: m.body_truncated,
    attachments: m.attachments.filter((a) => !a.inline).map((a) => ({ name: a.name, mime: a.mime, size: a.size, analyzed: false })),
    message_id_header: m.message_id_header,
    in_reply_to: m.in_reply_to,
    references: m.references,
    // sent items are kept as conversation context only; inbox items are analysed
    status: m.folder === 'sent' ? 'skipped' : 'new',
    ai: null,
    error: null,
    is_demo: false,
    created_at: now,
  }
}

// ----------------------------------------------------------------------------- outgoing (RFC 2822)

function encodeHeader(v: string): string {
  // RFC 2047 B-encoding when non-ASCII; strip CR/LF to prevent header injection
  const clean = v.replace(/[\r\n]+/g, ' ')
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

export function formatParty(p: EmailParty): string {
  const addr = p.address.replace(/[\r\n<>,;]/g, '')
  if (!p.name) return addr
  const name = encodeHeader(p.name)
  return name.startsWith('=?') ? `${name} <${addr}>` : `"${name.replace(/["\\]/g, '')}" <${addr}>`
}

export interface OutgoingMail {
  from: EmailParty
  to: EmailParty[]
  cc: EmailParty[]
  subject: string
  body: string
  inReplyTo: string | null
  references: string | null
  messageId: string
}

/** Builds a plain-text RFC 2822 message (UTF-8, base64 body). */
export function buildRfc2822(m: OutgoingMail, date = new Date()): string {
  const lines = [
    `From: ${formatParty(m.from)}`,
    `To: ${m.to.map(formatParty).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(formatParty).join(', ')}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo.replace(/[\r\n]+/g, ' ')}`] : []),
    ...(m.references ? [`References: ${m.references.replace(/[\r\n]+/g, ' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    (Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
  ]
  return lines.join('\r\n')
}

export function replySubject(subject: string): string {
  const s = subject.trim()
  return /^(re|jibu)\s*:/i.test(s) ? s : `Re: ${s || '(no subject)'}`
}

export function replyReferences(original: { message_id_header: string | null; references: string | null; in_reply_to: string | null }): string | null {
  const refs = (original.references ?? '').trim() || (original.in_reply_to ?? '').trim()
  const own = original.message_id_header?.trim()
  if (!own) return refs || null
  return refs ? `${refs} ${own}` : own
}
