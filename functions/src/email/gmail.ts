/** Gmail REST adapter (no googleapis dependency). https://developers.google.com/gmail/api/reference/rest */
import { randomUUID } from 'node:crypto'
import { htmlToText } from './html.js'
import { b64urlDecode, b64urlEncode, bearer, decodeCharset, fetchJson, type FetchLike } from './http.js'
import { buildRfc2822, decodeMimeWords, firstAddress, makeSnippet, parseAddressList, toIso, truncateBody, type AttachmentMeta, type ParsedMessage } from './message.js'
import type { FetchOptions, FetchResult, Folder, MailSession, SendRequest } from './provider.js'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface GmailHeader {
  name: string
  value: string
}
export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}
export interface GmailMessage {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}

const header = (headers: GmailHeader[] | undefined, name: string): string | null => {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h ? h.value : null
}

function charsetOf(part: GmailPart): string | null {
  const ct = header(part.headers, 'Content-Type') ?? ''
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i)
  return m ? m[1] : null
}

/** Walks the MIME tree: first text/plain and text/html bodies + attachment metadata. */
export function walkGmailParts(root: GmailPart | undefined): { text: string | null; html: string | null; attachments: AttachmentMeta[] } {
  let text: string | null = null
  let html: string | null = null
  const attachments: AttachmentMeta[] = []
  const visit = (p: GmailPart) => {
    const mime = (p.mimeType ?? '').toLowerCase()
    const disp = (header(p.headers, 'Content-Disposition') ?? '').toLowerCase()
    const isAttachment = !!p.filename || disp.startsWith('attachment')
    if (p.parts?.length) {
      p.parts.forEach(visit)
      return
    }
    if (isAttachment) {
      attachments.push({
        name: decodeMimeWords(p.filename || 'attachment'),
        mime: mime || 'application/octet-stream',
        size: p.body?.size ?? 0,
        ref: p.body?.attachmentId ?? p.partId ?? null,
        inline: disp.startsWith('inline') && !!header(p.headers, 'Content-ID') && mime.startsWith('image/'),
      })
      return
    }
    if (!p.body?.data) return
    const decoded = decodeCharset(b64urlDecode(p.body.data), charsetOf(p))
    if (mime === 'text/plain' && text === null) text = decoded
    else if (mime === 'text/html' && html === null) html = decoded
  }
  if (root) visit(root)
  return { text, html, attachments }
}

export function parseGmailMessage(m: GmailMessage, folder: Folder): ParsedMessage {
  const h = m.payload?.headers
  const { text, html, attachments } = walkGmailParts(m.payload)
  const bodyText = text?.trim() ? text : html ? htmlToText(html) : ''
  const { body_text, body_truncated } = truncateBody(bodyText.trim())
  const internal = Number(m.internalDate ?? 0)
  const dateHeader = header(h, 'Date')
  return {
    provider_message_id: m.id,
    thread_id: m.threadId ?? null,
    folder,
    from: firstAddress(header(h, 'From')),
    to: parseAddressList(header(h, 'To')),
    cc: parseAddressList(header(h, 'Cc')),
    subject: decodeMimeWords(header(h, 'Subject') ?? '').trim(),
    date: internal ? new Date(internal).toISOString() : toIso(dateHeader),
    snippet: makeSnippet(body_text || m.snippet || ''),
    body_text,
    body_truncated,
    attachments,
    message_id_header: header(h, 'Message-ID') ?? header(h, 'Message-Id'),
    in_reply_to: header(h, 'In-Reply-To'),
    references: header(h, 'References'),
    cursor: internal,
  }
}

export class GmailSession implements MailSession {
  readonly provider = 'gmail' as const
  constructor(
    private readonly f: FetchLike,
    private readonly accessToken: string,
  ) {}

  private get<T>(path: string, what: string) {
    return fetchJson<T>(this.f, `${API}${path}`, { headers: bearer(this.accessToken), what })
  }

  async fetchNew(folder: Folder, cursor: unknown, opts: FetchOptions): Promise<FetchResult> {
    const lastMs = typeof cursor === 'number' && cursor > 0 ? cursor : Date.parse(opts.sinceIso)
    const q = `in:${folder === 'inbox' ? 'inbox' : 'sent'} after:${Math.floor(lastMs / 1000)}`
    const ids: string[] = []
    let pageToken: string | undefined
    // Gmail lists newest first; collect up to 5 pages, then process the oldest first
    for (let page = 0; page < 5; page++) {
      const qs = new URLSearchParams({ q, maxResults: '100' })
      if (pageToken) qs.set('pageToken', pageToken)
      const res = await this.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`/messages?${qs}`, 'Gmail list')
      for (const m of res.messages ?? []) ids.push(m.id)
      pageToken = res.nextPageToken
      if (!pageToken) break
    }
    const messages: ParsedMessage[] = []
    for (const id of ids.reverse()) {
      if (messages.length >= opts.limit) break
      const full = await this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`, 'Gmail message')
      if (Number(full.internalDate ?? 0) <= lastMs && typeof cursor === 'number') continue
      if (folder === 'inbox' && full.labelIds && !full.labelIds.includes('INBOX')) continue
      messages.push(parseGmailMessage(full, folder))
    }
    messages.sort((a, b) => Number(a.cursor) - Number(b.cursor))
    const max = messages.reduce((acc, m) => Math.max(acc, Number(m.cursor) || 0), typeof cursor === 'number' ? cursor : 0)
    return { messages, nextCursor: max || cursor || null }
  }

  async downloadAttachment(providerMessageId: string, _folder: Folder, attachmentName: string) {
    void _folder
    const full = await this.get<GmailMessage>(`/messages/${encodeURIComponent(providerMessageId)}?format=full`, 'Gmail message')
    const att = walkGmailParts(full.payload).attachments.find((a) => a.name === attachmentName)
    if (!att?.ref) return null
    const data = await this.get<{ data?: string }>(`/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(att.ref)}`, 'Gmail attachment')
    return data.data ? { data: b64urlDecode(data.data), mime: att.mime } : null
  }

  async send(req: SendRequest) {
    const domain = req.from.address.split('@')[1] || 'abckit.local'
    const raw = buildRfc2822({ ...req, messageId: `<${randomUUID()}@${domain}>` })
    const res = await fetchJson<{ id?: string }>(this.f, `${API}/messages/send`, {
      method: 'POST',
      headers: bearer(this.accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ raw: b64urlEncode(raw), ...(req.threadId ? { threadId: req.threadId } : {}) }),
      what: 'Gmail send',
    })
    return { providerMessageId: res.id ?? null }
  }

  async close() {}
}
