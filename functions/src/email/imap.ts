/** IMAP (imapflow + mailparser) + SMTP (nodemailer) adapter for mailboxes connected with an app password. */
import { randomUUID } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import nodemailer from 'nodemailer'
import type { EmailParty } from '../shared/ai/contract.js'
import { ProviderAuthError } from './http.js'
import { htmlToText } from './html.js'
import { deriveThreadId, makeSnippet, toIso, truncateBody, type AttachmentMeta, type ParsedMessage } from './message.js'
import type { FetchOptions, FetchResult, Folder, MailSession, SendRequest } from './provider.js'

export interface ServerConfig {
  host: string
  port: number
  secure: boolean
  user: string
}
export interface ImapAccountConfig {
  address: string
  display_name: string | null
  imap: ServerConfig & { password: string }
  smtp: ServerConfig & { password: string }
}

interface FolderCursor {
  path: string
  uidValidity: string
  lastUid: number
}

function parties(v: AddressObject | AddressObject[] | undefined): EmailParty[] {
  const list = Array.isArray(v) ? v : v ? [v] : []
  const out: EmailParty[] = []
  const walk = (items: Array<{ address?: string; name?: string; group?: any[] }>) => {
    for (const a of items) {
      if (a.group) walk(a.group)
      else if (a.address) out.push({ name: a.name?.trim() || null, address: a.address.toLowerCase() })
    }
  }
  for (const o of list) walk(o.value ?? [])
  return out
}

export function imapMessageId(path: string, uidValidity: string, uid: number): string {
  return `${path}:${uidValidity}:${uid}`
}

/** mailparser output → provider-neutral message (pure; tested with raw RFC 822 fixtures). */
export function parseMailparserMessage(mail: ParsedMail, folder: Folder, providerMessageId: string, uid: number, internalDate?: Date | string | null): ParsedMessage {
  const text = mail.text?.trim() ? mail.text : mail.html ? htmlToText(mail.html) : ''
  const { body_text, body_truncated } = truncateBody(text.trim())
  const references = Array.isArray(mail.references) ? mail.references.join(' ') : (mail.references ?? null)
  const messageId = mail.messageId ?? null
  const inReplyTo = mail.inReplyTo ?? null
  const attachmentData = new Map<string, Buffer>()
  const attachments: AttachmentMeta[] = mail.attachments.map((a, i) => {
    const ref = String(i)
    if (Buffer.isBuffer(a.content)) attachmentData.set(ref, a.content)
    return {
      name: a.filename || `attachment-${i + 1}`,
      mime: (a.contentType || 'application/octet-stream').toLowerCase(),
      size: a.size ?? (Buffer.isBuffer(a.content) ? a.content.length : 0),
      ref,
      inline: a.contentDisposition === 'inline' && !!a.cid && a.related === true,
    }
  })
  return {
    provider_message_id: providerMessageId,
    thread_id: deriveThreadId(messageId, inReplyTo, references),
    folder,
    from: parties(mail.from)[0] ?? { name: null, address: '' },
    to: parties(mail.to),
    cc: parties(mail.cc),
    subject: (mail.subject ?? '').trim(),
    date: toIso(mail.date ?? internalDate ?? null),
    snippet: makeSnippet(body_text),
    body_text,
    body_truncated,
    attachments,
    message_id_header: messageId,
    in_reply_to: inReplyTo,
    references,
    cursor: uid,
    attachmentData,
  }
}

const isAuthFailure = (e: unknown) => {
  const err = e as { authenticationFailed?: boolean; responseStatus?: string; code?: string; message?: string }
  return err?.authenticationFailed === true || err?.code === 'EAUTH' || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(err?.message ?? '')
}

export function newImapClient(cfg: ImapAccountConfig['imap']): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    connectionTimeout: 30_000,
  } as ConstructorParameters<typeof ImapFlow>[0])
}

/** Logs in to IMAP and SMTP once to prove the settings work (used before saving an account). */
export async function verifyImapAccount(cfg: ImapAccountConfig): Promise<void> {
  const client = newImapClient(cfg.imap)
  try {
    await client.connect()
  } catch (e) {
    throw new Error(isAuthFailure(e) ? 'IMAP login failed: check the username and app password.' : `Could not connect to the IMAP server: ${(e as Error)?.message ?? e}`)
  } finally {
    await client.logout().catch(() => undefined)
  }
  const transport = nodemailer.createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure, auth: { user: cfg.smtp.user, pass: cfg.smtp.password } })
  try {
    await transport.verify()
  } catch (e) {
    throw new Error(isAuthFailure(e) ? 'SMTP login failed: check the username and app password.' : `Could not connect to the SMTP server: ${(e as Error)?.message ?? e}`)
  } finally {
    transport.close()
  }
}

export class ImapSession implements MailSession {
  readonly provider = 'imap' as const
  private client: ImapFlow | null = null
  constructor(private readonly cfg: ImapAccountConfig) {}

  private async connect(): Promise<ImapFlow> {
    if (this.client) return this.client
    const c = newImapClient(this.cfg.imap)
    try {
      await c.connect()
    } catch (e) {
      if (isAuthFailure(e)) throw new ProviderAuthError('IMAP login failed — the app password may have been revoked. Reconnect the account.')
      throw e
    }
    this.client = c
    return c
  }

  private async folderPath(folder: Folder): Promise<string | null> {
    if (folder === 'inbox') return 'INBOX'
    const c = await this.connect()
    const list = await c.list()
    return list.find((m) => m.specialUse === '\\Sent')?.path ?? list.find((m) => /^(sent|sent items|sent mail|\[gmail\]\/sent mail)$/i.test(m.path))?.path ?? null
  }

  async fetchNew(folder: Folder, cursor: unknown, opts: FetchOptions): Promise<FetchResult> {
    const path = await this.folderPath(folder)
    if (!path) return { messages: [], nextCursor: cursor ?? null }
    const c = await this.connect()
    const lock = await c.getMailboxLock(path, { readOnly: true })
    try {
      const box = c.mailbox
      if (!box) return { messages: [], nextCursor: cursor ?? null }
      const uidValidity = String(box.uidValidity)
      const prev = cursor as FolderCursor | null
      let uids: number[]
      if (prev && prev.uidValidity === uidValidity && prev.path === path && prev.lastUid > 0) {
        const found = await c.search({ uid: `${prev.lastUid + 1}:*` }, { uid: true })
        uids = (found || []).filter((u) => u > prev.lastUid)
      } else {
        const found = await c.search({ since: new Date(opts.sinceIso) }, { uid: true })
        uids = found || []
      }
      uids.sort((a, b) => a - b)
      uids = uids.slice(0, opts.limit)
      const messages: ParsedMessage[] = []
      for (const uid of uids) {
        const msg = await c.fetchOne(String(uid), { uid: true, source: true, internalDate: true }, { uid: true })
        if (!msg || !msg.source) continue
        const mail = await simpleParser(msg.source)
        messages.push(parseMailparserMessage(mail, folder, imapMessageId(path, uidValidity, uid), uid, msg.internalDate ?? null))
      }
      const lastUid = messages.reduce((acc, m) => Math.max(acc, Number(m.cursor)), prev && prev.uidValidity === uidValidity ? prev.lastUid : 0)
      const next: FolderCursor = { path, uidValidity, lastUid }
      return { messages, nextCursor: lastUid ? next : (cursor ?? null) }
    } finally {
      lock.release()
    }
  }

  async downloadAttachment(providerMessageId: string, _folder: Folder, attachmentName: string) {
    void _folder
    const m = providerMessageId.match(/^(.*):([^:]+):(\d+)$/)
    if (!m) return null
    const [, path, uidValidity, uid] = m
    const c = await this.connect()
    const lock = await c.getMailboxLock(path, { readOnly: true })
    try {
      if (!c.mailbox || String(c.mailbox.uidValidity) !== uidValidity) return null
      const msg = await c.fetchOne(uid, { uid: true, source: true }, { uid: true })
      if (!msg || !msg.source) return null
      const mail = await simpleParser(msg.source)
      const att = mail.attachments.find((a) => a.filename === attachmentName)
      return att && Buffer.isBuffer(att.content) ? { data: att.content, mime: (att.contentType || 'application/octet-stream').toLowerCase() } : null
    } finally {
      lock.release()
    }
  }

  async send(req: SendRequest) {
    const s = this.cfg.smtp
    const transport = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.password } })
    const fmt = (p: EmailParty) => (p.name ? { name: p.name, address: p.address } : p.address)
    try {
      const domain = req.from.address.split('@')[1] || 'abckit.local'
      const info = await transport.sendMail({
        from: fmt(req.from),
        to: req.to.map(fmt),
        cc: req.cc.map(fmt),
        subject: req.subject,
        text: req.body,
        messageId: `<${randomUUID()}@${domain}>`,
        ...(req.inReplyTo ? { inReplyTo: req.inReplyTo } : {}),
        ...(req.references ? { references: req.references } : {}),
      })
      return { providerMessageId: info.messageId ?? null }
    } catch (e) {
      if (isAuthFailure(e)) throw new ProviderAuthError('SMTP login failed — the app password may have been revoked. Reconnect the account.')
      throw e
    } finally {
      transport.close()
    }
  }

  async close() {
    if (this.client) await this.client.logout().catch(() => undefined)
    this.client = null
  }
}
