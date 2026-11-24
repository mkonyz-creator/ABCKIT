/** Microsoft Graph mail adapter (Outlook.com / Microsoft 365). https://learn.microsoft.com/graph/api/resources/message */
import type { EmailParty } from '../shared/ai/contract.js'
import { htmlToText } from './html.js'
import { bearer, fetchJson, type FetchLike } from './http.js'
import { deriveThreadId, makeSnippet, toIso, truncateBody, type AttachmentMeta, type ParsedMessage } from './message.js'
import type { FetchOptions, FetchResult, Folder, MailSession, SendRequest } from './provider.js'

const API = 'https://graph.microsoft.com/v1.0/me'
const SELECT =
  'id,conversationId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,internetMessageId,internetMessageHeaders,hasAttachments'

interface GraphRecipient {
  emailAddress?: { name?: string | null; address?: string | null }
}
export interface GraphMessage {
  id: string
  conversationId?: string | null
  subject?: string | null
  from?: GraphRecipient | null
  sender?: GraphRecipient | null
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  receivedDateTime?: string | null
  sentDateTime?: string | null
  bodyPreview?: string | null
  body?: { contentType?: string; content?: string } | null
  internetMessageId?: string | null
  internetMessageHeaders?: Array<{ name: string; value: string }> | null
  hasAttachments?: boolean
}
export interface GraphAttachment {
  id: string
  name?: string | null
  contentType?: string | null
  size?: number | null
  isInline?: boolean | null
  '@odata.type'?: string
  contentBytes?: string
}

function party(r: GraphRecipient | null | undefined): EmailParty | null {
  const a = r?.emailAddress?.address?.trim()
  if (!a) return null
  return { name: r?.emailAddress?.name?.trim() || null, address: a.toLowerCase() }
}

export function parseGraphMessage(m: GraphMessage, folder: Folder, attachments: GraphAttachment[] = []): ParsedMessage {
  const hdr = (n: string) => m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null
  const raw = m.body?.content ?? ''
  const text = (m.body?.contentType ?? '').toLowerCase() === 'html' ? htmlToText(raw) : raw.replace(/\r\n?/g, '\n')
  const { body_text, body_truncated } = truncateBody(text.trim())
  const when = folder === 'sent' ? (m.sentDateTime ?? m.receivedDateTime) : (m.receivedDateTime ?? m.sentDateTime)
  const messageId = m.internetMessageId ?? hdr('Message-ID')
  const inReplyTo = hdr('In-Reply-To')
  const references = hdr('References')
  return {
    provider_message_id: m.id,
    thread_id: m.conversationId ?? deriveThreadId(messageId, inReplyTo, references),
    folder,
    from: party(m.from) ?? party(m.sender) ?? { name: null, address: '' },
    to: (m.toRecipients ?? []).map(party).filter((p): p is EmailParty => !!p),
    cc: (m.ccRecipients ?? []).map(party).filter((p): p is EmailParty => !!p),
    subject: (m.subject ?? '').trim(),
    date: toIso(when),
    snippet: makeSnippet(body_text || m.bodyPreview || ''),
    body_text,
    body_truncated,
    attachments: attachments.map(
      (a): AttachmentMeta => ({
        name: a.name || 'attachment',
        mime: (a.contentType || 'application/octet-stream').toLowerCase(),
        size: a.size ?? 0,
        ref: a.id,
        inline: a.isInline === true,
      }),
    ),
    message_id_header: messageId,
    in_reply_to: inReplyTo,
    references,
    // the cursor follows receivedDateTime (the $filter / $orderby field)
    cursor: toIso(m.receivedDateTime ?? when),
  }
}

export class GraphSession implements MailSession {
  readonly provider = 'microsoft' as const
  constructor(
    private readonly f: FetchLike,
    private readonly accessToken: string,
  ) {}

  private get<T>(url: string, what: string) {
    return fetchJson<T>(this.f, url.startsWith('https://') ? url : `${API}${url}`, {
      headers: bearer(this.accessToken, { Prefer: 'outlook.body-content-type="text"' }),
      what,
    })
  }

  private listAttachments(id: string) {
    return this.get<{ value?: GraphAttachment[] }>(`/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size,isInline`, 'Outlook attachments').then((r) => r.value ?? [])
  }

  async fetchNew(folder: Folder, cursor: unknown, opts: FetchOptions): Promise<FetchResult> {
    const since = typeof cursor === 'string' && cursor ? cursor : opts.sinceIso
    const box = folder === 'inbox' ? 'inbox' : 'sentitems'
    // OData wants %20 (not '+') for spaces
    const qs = Object.entries({
      $filter: `receivedDateTime gt ${new Date(since).toISOString()}`,
      $orderby: 'receivedDateTime asc',
      $top: String(Math.min(50, opts.limit)),
      $select: SELECT,
    })
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    let url: string | undefined = `/mailFolders/${box}/messages?${qs}`
    const messages: ParsedMessage[] = []
    while (url && messages.length < opts.limit) {
      const res: { value?: GraphMessage[]; '@odata.nextLink'?: string } = await this.get(url, 'Outlook list')
      for (const m of res.value ?? []) {
        if (messages.length >= opts.limit) break
        const atts = m.hasAttachments ? await this.listAttachments(m.id) : []
        messages.push(parseGraphMessage(m, folder, atts))
      }
      url = res['@odata.nextLink']
    }
    const max = messages.reduce<string>((acc, m) => (String(m.cursor) > acc ? String(m.cursor) : acc), typeof cursor === 'string' ? cursor : '')
    return { messages, nextCursor: max || cursor || null }
  }

  async downloadAttachment(providerMessageId: string, _folder: Folder, attachmentName: string) {
    void _folder
    const list = await this.listAttachments(providerMessageId)
    const att = list.find((a) => a.name === attachmentName)
    if (!att) return null
    const full = await this.get<GraphAttachment>(`/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(att.id)}`, 'Outlook attachment')
    if (!full.contentBytes) return null // item / reference attachments carry no bytes
    return { data: Buffer.from(full.contentBytes, 'base64'), mime: (full.contentType || att.contentType || 'application/octet-stream').toLowerCase() }
  }

  async send(req: SendRequest) {
    const recipients = (list: EmailParty[]) => list.map((p) => ({ emailAddress: { address: p.address, ...(p.name ? { name: p.name } : {}) } }))
    const headers = bearer(this.accessToken, { 'Content-Type': 'application/json' })
    if (req.replyToProviderId) {
      // reply in the same conversation: createReply → set our body/recipients → send
      const draft = await fetchJson<{ id: string }>(this.f, `${API}/messages/${encodeURIComponent(req.replyToProviderId)}/createReply`, {
        method: 'POST',
        headers,
        body: '{}',
        what: 'Outlook createReply',
      })
      await fetchJson(this.f, `${API}/messages/${encodeURIComponent(draft.id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ subject: req.subject, body: { contentType: 'Text', content: req.body }, toRecipients: recipients(req.to), ccRecipients: recipients(req.cc) }),
        what: 'Outlook update reply',
      })
      await fetchJson(this.f, `${API}/messages/${encodeURIComponent(draft.id)}/send`, { method: 'POST', headers, body: '', what: 'Outlook send' })
      return { providerMessageId: draft.id }
    }
    await fetchJson(this.f, `${API}/sendMail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: { subject: req.subject, body: { contentType: 'Text', content: req.body }, toRecipients: recipients(req.to), ccRecipients: recipients(req.cc) },
        saveToSentItems: true,
      }),
      what: 'Outlook sendMail',
    })
    return { providerMessageId: null }
  }

  async close() {}
}
