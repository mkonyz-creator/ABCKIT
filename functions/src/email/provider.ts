/** Provider adapter interface implemented by Gmail, Microsoft Graph and IMAP/SMTP. */
import type { EmailParty, EmailProvider } from '../shared/ai/contract.js'
import type { ParsedMessage } from './message.js'

export type Folder = 'inbox' | 'sent'

export interface FetchOptions {
  /** first sync: only messages after this instant */
  sinceIso: string
  /** max messages returned for this folder in this run */
  limit: number
}

export interface FetchResult {
  /** oldest first */
  messages: ParsedMessage[]
  /** cursor to store after the messages are written (unchanged when nothing new) */
  nextCursor: unknown
}

export interface SendRequest {
  from: EmailParty
  to: EmailParty[]
  cc: EmailParty[]
  subject: string
  body: string
  inReplyTo: string | null
  references: string | null
  threadId: string | null
  /** provider id of the message being answered (Graph createReply) */
  replyToProviderId: string | null
}

export interface MailSession {
  provider: EmailProvider
  fetchNew(folder: Folder, cursor: unknown, opts: FetchOptions): Promise<FetchResult>
  /** downloads one attachment of a stored message (null when no longer available) */
  downloadAttachment(providerMessageId: string, folder: Folder, attachmentName: string): Promise<{ data: Buffer; mime: string } | null>
  send(req: SendRequest): Promise<{ providerMessageId: string | null }>
  close(): Promise<void>
}
