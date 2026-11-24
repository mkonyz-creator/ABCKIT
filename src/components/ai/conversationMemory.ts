/**
 * The floating assistant remembers its conversation: every exchange (typed or spoken) is saved as the user's private
 * chat (ai_chats), so it survives a reload, shows in AI → Chat and can be searched later (search_my_memory).
 */
import type { AiChat, AiChatMessage } from '@/shared/ai/contract'

export interface Turn {
  role: 'user' | 'assistant'
  text: string
  page?: string
  voice?: boolean
  /** when it was said (ISO) */
  at?: string
}

/** a conversation younger than this is reopened when the app is loaded again (older ones stay in AI → Chat) */
export const RESUME_WITHIN_MS = 12 * 3600_000

/** the panel's turns as a saved chat; null when the user has said nothing yet */
export function turnsToChat(turns: Turn[], now = new Date().toISOString()): { title: string; messages: AiChatMessage[] } | null {
  const messages = turns.filter((m) => m.text.trim()).map((m) => ({ role: m.role, text: m.text, at: m.at ?? now }))
  const first = messages.find((m) => m.role === 'user')
  if (!first) return null
  return { title: first.text.replace(/\s+/g, ' ').trim().slice(0, 80), messages }
}

/** what decides whether the saved copy is up to date (the times are not part of it) */
export const chatKey = (messages: AiChatMessage[]) => JSON.stringify(messages.map((m) => [m.role, m.text]))

/** the last conversation, if recent enough to carry on with */
export function resumeTurns(chat: Pick<AiChat, 'messages' | 'updated_at'> | null | undefined, now = Date.now()): Turn[] | null {
  if (!chat || !Array.isArray(chat.messages) || !chat.messages.length) return null
  if (!(now - Date.parse(chat.updated_at) <= RESUME_WITHIN_MS)) return null
  return chat.messages.map((m) => ({ role: m.role, text: m.text, at: m.at }))
}
