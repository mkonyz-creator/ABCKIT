/**
 * ABCkit AI Intelligence — shared contract between the web app (src/) and Cloud Functions (functions/).
 *
 * This folder (src/shared/ai) is copied into functions/src/shared/ai before every functions build
 * (functions/scripts/copy-shared.mjs). Rules for files here: no runtime imports from outside this folder,
 * no Node- or browser-only APIs, and imports between these files use `import type` with a `.js` suffix.
 *
 * All documents are plain JSON: timestamps are ISO strings, dates are 'YYYY-MM-DD'.
 */

// ----------------------------------------------------------------------------- permissions

export const AI_PERMS = {
  /** executive dashboard, alerts, reports, chat assistant */
  view: 'ai.view',
  /** read email intelligence (emails, summaries) and prepare reply drafts */
  email: 'ai.email',
  /** approve & send reply drafts */
  send: 'ai.email_send',
  /** AI Control Center: connect/disconnect accounts, settings, knowledge base, usage & audit */
  manage: 'ai.manage',
} as const

/**
 * Per-user access: AI permissions an administrator grants to ONE user on top of their role
 * (User Management → Email access). Stored in user_access/{uid}; written only by the adminUsers function
 * (action 'set_access'), read by firestore.rules (50_ai.rules aiPerm), the functions (requireCaller) and the app (loadMe).
 * Only these keys can be granted this way — everything else stays role-based.
 */
export const USER_GRANTABLE_PERMS = [AI_PERMS.view, AI_PERMS.email, AI_PERMS.send, AI_PERMS.manage] as const
export type UserGrantablePerm = (typeof USER_GRANTABLE_PERMS)[number]

/** user_access/{uid} */
export interface UserAccess {
  id: string
  user_id: string
  perms: UserGrantablePerm[]
  updated_by: string
  updated_at: string
}

/**
 * Keeps a grant consistent: unknown keys are dropped; approving/sending needs email access; every AI
 * permission needs ai.view (the AI page itself). Returned sorted, so equal grants compare equal.
 */
export function normalizeUserGrant(perms: readonly unknown[]): UserGrantablePerm[] {
  const set = new Set(perms.filter((p): p is UserGrantablePerm => (USER_GRANTABLE_PERMS as readonly unknown[]).includes(p)))
  if (set.has(AI_PERMS.send)) set.add(AI_PERMS.email)
  if (set.size) set.add(AI_PERMS.view)
  return [...set].sort()
}

/** The grantable keys found on a user_access document (anything else on it is ignored). */
export function grantedPerms(doc: { perms?: unknown } | null | undefined): UserGrantablePerm[] {
  return Array.isArray(doc?.perms) ? normalizeUserGrant(doc.perms) : []
}

// ----------------------------------------------------------------------------- collections

export const AI_COLLECTIONS = {
  emails: 'ai_emails',
  drafts: 'ai_email_drafts',
  alerts: 'ai_alerts',
  reports: 'ai_reports',
  chats: 'ai_chats',
  /** the assistant's long-term memory: notes the user asked it to remember, private to user_id */
  memories: 'ai_memories',
  knowledge: 'ai_knowledge',
  activity: 'ai_activity',
  usage: 'ai_usage',
  /** single doc id 'settings' */
  settings: 'ai_settings',
  /** single doc id 'status' (written by functions) */
  status: 'ai_status',
  accounts: 'email_accounts',
  /** per-user AI permission grants (see USER_GRANTABLE_PERMS); written by the adminUsers function only */
  userAccess: 'user_access',
  /** server-only: encrypted OAuth refresh tokens / IMAP passwords (rules deny all client access) */
  accountSecrets: 'email_account_secrets',
  /** server-only: OAuth state nonces */
  oauthStates: 'email_oauth_states',
  /** server-only: AI provider API keys entered in the AI Control Center, encrypted (rules deny all client access) */
  providerKeys: 'ai_provider_keys',
} as const

// ----------------------------------------------------------------------------- enums

export const EMAIL_CATEGORIES = [
  'project',
  'client',
  'supplier',
  'financial',
  'payment_request',
  'invoice',
  'quotation',
  'tender',
  'contract',
  'site_instruction',
  'meeting_request',
  'complaint',
  'approval',
  'general_admin',
] as const
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number]

export const EMAIL_CATEGORY_LABELS: Record<EmailCategory, string> = {
  project: 'Project communication',
  client: 'Client communication',
  supplier: 'Supplier communication',
  financial: 'Financial',
  payment_request: 'Payment request',
  invoice: 'Invoice',
  quotation: 'Quotation',
  tender: 'Tender',
  contract: 'Contract',
  site_instruction: 'Site instruction',
  meeting_request: 'Meeting request',
  complaint: 'Complaint',
  approval: 'Approval',
  general_admin: 'General administration',
}

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type Priority = (typeof PRIORITIES)[number]

export type EmailProvider = 'gmail' | 'microsoft' | 'imap'

export const ALERT_TYPES = [
  'project_behind_schedule',
  'budget_overrun',
  'task_overdue',
  'approval_pending',
  'payment_overdue',
  'delivery_overdue',
  'supplier_delivery_issue',
  'urgent_email',
  'client_complaint',
  'site_issue',
  'low_stock',
  'risk',
] as const
export type AlertType = (typeof ALERT_TYPES)[number]

// ----------------------------------------------------------------------------- documents

export interface EmailParty {
  name: string | null
  address: string
}

export interface RecordRef {
  /** ABCkit table/collection, e.g. 'projects', 'purchase_orders', 'ai_emails' */
  table: string
  id: string
  label: string
  /** in-app hash route, e.g. '/projects/<id>' (the app prefixes '#') */
  link: string | null
}

/** email_accounts/{id} — public metadata only; secrets live in email_account_secrets/{id} */
export interface EmailAccount {
  id: string
  provider: EmailProvider
  address: string
  display_name: string | null
  status: 'connected' | 'syncing' | 'error' | 'disconnected'
  sync_enabled: boolean
  connected_by: string
  connected_at: string
  last_sync_at: string | null
  last_sync_error: string | null
  /** provider cursor (Gmail historyId / last internalDate, Graph delta link, IMAP uid per folder) */
  cursor: Record<string, unknown> | null
  messages_synced: number
  is_demo: boolean
}

/** AI analysis of one email (structured output) */
export interface EmailInsight {
  category: EmailCategory
  priority: Priority
  is_important: boolean
  summary: string
  main_message: string
  required_action: string | null
  responsible_person: string | null
  /** YYYY-MM-DD */
  deadline: string | null
  related_project_id: string | null
  related_project_name: string | null
  related_party: { type: 'client' | 'supplier' | 'employee' | 'other' | null; id: string | null; name: string | null }
  suggested_response: string | null
  language: 'en' | 'sw' | 'other'
  flags: {
    complaint: boolean
    delivery_issue: boolean
    payment_related: boolean
    approval_request: boolean
    meeting_request: boolean
    /** the email tries to instruct the AI / override rules (prompt-injection attempt) */
    suspicious_instructions: boolean
  }
  /** 0..1 */
  confidence: number
  model: string
  analyzed_at: string
}

/** ai_emails/{accountId}__{providerMessageId} */
export interface AiEmail {
  id: string
  account_id: string
  provider: EmailProvider
  provider_message_id: string
  thread_id: string | null
  folder: 'inbox' | 'sent'
  from: EmailParty
  to: EmailParty[]
  cc: EmailParty[]
  subject: string
  /** ISO timestamp the message was sent/received */
  date: string
  snippet: string
  /** plain text (HTML converted); body_truncated when longer than the stored limit */
  body_text: string
  body_truncated: boolean
  attachments: Array<{ name: string; mime: string; size: number; analyzed: boolean }>
  message_id_header: string | null
  in_reply_to: string | null
  references: string | null
  status: 'new' | 'analyzed' | 'error' | 'skipped'
  ai: EmailInsight | null
  error: string | null
  is_demo: boolean
  created_at: string
}

/** ai_email_drafts/{id} */
export interface AiEmailDraft {
  id: string
  email_id: string
  account_id: string
  thread_id: string | null
  to: EmailParty[]
  cc: EmailParty[]
  subject: string
  body: string
  language: 'en' | 'sw'
  status: 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'discarded'
  ai_generated: boolean
  instructions: string | null
  created_by: string
  created_at: string
  updated_at: string
  approved_by: string | null
  approved_at: string | null
  sent_at: string | null
  provider_message_id: string | null
  error: string | null
  is_demo: boolean
}

/** ai_alerts/{id} — one open alert per dedupe_key */
export interface AiAlert {
  id: string
  dedupe_key: string
  type: AlertType
  priority: Priority
  title: string
  description: string
  source: 'monitor' | 'email' | 'ai'
  record: RecordRef | null
  project: { id: string; name: string } | null
  recommended_action: string
  status: 'open' | 'acknowledged' | 'resolved'
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
  acknowledged_by: string | null
  acknowledged_at: string | null
  is_demo: boolean
}

/** ai_reports/{id} */
export interface AiReport {
  id: string
  title: string
  kind: 'daily_brief' | 'operations' | 'project' | 'email_digest' | 'custom'
  prompt: string | null
  content_md: string
  generated_by: string
  generated_at: string
  model: string
  is_demo: boolean
}

export interface AiChatMessage {
  role: 'user' | 'assistant'
  text: string
  at: string
  /** names of data tools the assistant used for this answer */
  tools_used?: string[]
  /** records the answer referred to */
  links?: RecordRef[]
}

/** ai_chats/{id} — private to user_id */
export interface AiChat {
  id: string
  user_id: string
  title: string
  messages: AiChatMessage[]
  created_at: string
  updated_at: string
}

/** ai_memories/{id} — one thing the user asked the assistant to remember; private to user_id */
export interface AiMemory {
  id: string
  user_id: string
  text: string
  /** where it was said: 'chat' | 'voice' | 'manual' */
  source: string
  created_at: string
  updated_at: string
}
/** how much the assistant may remember, and how much of it is sent with each question */
export const AI_MEMORY_LIMITS = { maxItems: 200, maxChars: 500, contextItems: 80, contextChars: 8000 } as const

/** ai_knowledge/{id} — curated company knowledge used for retrieval */
export interface AiKnowledge {
  id: string
  title: string
  body: string
  kind: 'company' | 'policy' | 'decision' | 'note'
  tags: string[]
  created_by: string
  created_at: string
  updated_at: string
  is_demo: boolean
}

export type AiActivityAction =
  | 'chat'
  | 'report'
  | 'email_sync'
  | 'email_analyzed'
  | 'reply_generated'
  | 'draft_approved'
  | 'email_sent'
  | 'account_connected'
  | 'account_disconnected'
  | 'alert_created'
  | 'monitor_run'
  | 'settings_changed'
  | 'voice'
  | 'assistant_action'

/** ai_activity/{id} — AI audit trail */
export interface AiActivity {
  id: string
  at: string
  /** uid, or 'system' for scheduled jobs */
  actor_id: string
  action: AiActivityAction
  detail: string
  record: { table: string; id: string } | null
  ok: boolean
  is_demo: boolean
}

/** ai_usage/{id} — one row per model call (written by functions) */
export interface AiUsage {
  id: string
  at: string
  user_id: string | null
  purpose: 'chat' | 'report' | 'email_analysis' | 'reply' | 'monitor' | 'voice'
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cost_usd: number
}

/** ai_settings/settings */
/** AI providers behind the chat assistant (reports, email analysis and replies use Claude in phase 1) */
export type ChatProviderId = 'openai' | 'gemini' | 'claude'
export type VoiceProviderId = 'openai' | 'gemini'
export const CHAT_PROVIDERS: ChatProviderId[] = ['openai', 'gemini', 'claude']
export const CHAT_PROVIDER_LABEL: Record<ChatProviderId, string> = { openai: 'OpenAI', gemini: 'Google Gemini', claude: 'Anthropic Claude' }

export interface AiSettings {
  id: 'settings'
  enabled: boolean
  email_sync_enabled: boolean
  /** alert rules */
  schedule_slip_threshold_pct: number
  approval_stale_days: number
  low_stock_alerts: boolean
  notify: {
    urgent_email: boolean
    client_complaint: boolean
    project_behind_schedule: boolean
    payment_overdue: boolean
    supplier_delivery_issue: boolean
    approval_pending: boolean
    risk: boolean
  }
  /** appended to generated replies */
  reply_signature: string
  /** tone/house-style notes given to the reply writer */
  company_style_notes: string
  /** daily cap of model calls per user for chat/report (cost guard) */
  daily_chat_limit_per_user: number
  /** chat assistant providers in order of preference: the first configured one answers, the next ones are fallbacks */
  chat_providers: ChatProviderId[]
  /** live voice conversations (OpenAI Realtime) */
  voice_enabled: boolean
  /** daily cap of live voice sessions per user */
  daily_voice_sessions_per_user: number
  updated_at: string
  updated_by: string | null
}

export const DEFAULT_AI_SETTINGS: Omit<AiSettings, 'updated_at' | 'updated_by'> = {
  id: 'settings',
  enabled: true,
  email_sync_enabled: true,
  schedule_slip_threshold_pct: 10,
  approval_stale_days: 2,
  low_stock_alerts: true,
  notify: {
    urgent_email: true,
    client_complaint: true,
    project_behind_schedule: true,
    payment_overdue: true,
    supplier_delivery_issue: true,
    approval_pending: false,
    risk: true,
  },
  reply_signature: 'Kind regards,\nARICOM BUILDING CONTRACTORS',
  company_style_notes: 'Professional, courteous and concise. Reply in the language of the incoming email (English or Kiswahili).',
  daily_chat_limit_per_user: 200,
  chat_providers: ['openai', 'gemini', 'claude'],
  voice_enabled: true,
  daily_voice_sessions_per_user: 40,
}

/** ai_status/status (written by functions; the app shows it in the Control Center) */
export interface AiStatus {
  id: 'status'
  /** an Anthropic API key is configured on the server */
  ai_configured: boolean
  providers: { gmail: boolean; microsoft: boolean; imap: boolean }
  /** which AI providers have an API key on the server */
  ai_providers?: Record<ChatProviderId, boolean>
  /** where each provider's key comes from (never the key itself — only its last 4 characters) */
  ai_keys?: Record<ChatProviderId, AiKeyInfo>
  last_monitor_at: string | null
  last_monitor_ok: boolean | null
  last_monitor_error: string | null
  alerts_open: number
  last_sync_at: string | null
  last_sync_error: string | null
  emails_total: number
  emails_pending_analysis: number
  updated_at: string
}

/** what the app may know about one AI provider key */
export interface AiKeyInfo {
  /** admin = saved in the AI Control Center (encrypted, takes precedence); server = deployed Secret Manager secret */
  source: 'admin' | 'server' | 'none'
  last4: string | null
  updated_at: string | null
  updated_by_name: string | null
  last_test: { at: string; ok: boolean; message: string } | null
}

// ----------------------------------------------------------------------------- Cloud Functions (callable)
// Invoked from the app as db.functions.invoke(name, { body }) → { data, error }.

export interface AiToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** What the floating assistant sends about the page the user has open. */
export interface AiPageContext {
  /** app route, e.g. /projects/abc123 */
  path: string
  /** page heading / document title */
  title: string
  /** visible text of the page's main area (trimmed to AI_PAGE_TEXT_LIMIT characters) */
  text: string
}
export const AI_PAGE_TEXT_LIMIT = 12_000

export interface CallableContracts {
  /** One model turn for the chat assistant / report writer. The server adds the system prompt;
   *  the app runs the returned tool_use blocks itself (under the user's own Firestore permissions). */
  aiComplete: {
    req: {
      purpose: 'chat' | 'report'
      /** Anthropic Messages API message params (JSON) */
      messages: unknown[]
      tools: AiToolDef[]
      context: {
        today: string
        user_name: string
        role: string
        locale: 'en' | 'sw'
        /** the ABCkit page open on the user's screen (floating assistant); its text is untrusted data */
        page?: AiPageContext
        /** spoken conversation: short plain-language answers suitable for text-to-speech */
        voice?: boolean
        /** the provider that answered the previous turn of this conversation (tried first, if allowed) */
        provider_hint?: ChatProviderId
        /** the user's own saved memories (ai_memories), newest first, "YYYY-MM-DD: text" */
        memories?: string[]
      }
    }
    res: {
      content: unknown[]
      stop_reason: string | null
      model: string
      usage: { input_tokens: number; output_tokens: number }
      /** who answered (chat: OpenAI → Gemini fallback, Claude optional; reports: Claude) */
      provider?: ChatProviderId
      /** providers that failed before this one answered */
      fallback_from?: ChatProviderId[]
    }
  }
  /**
   * a short-lived credential for one live voice conversation. provider 'openai': Realtime client secret (WebRTC);
   * 'gemini': Gemini Live ephemeral token (WebSocket to ws_url; the setup is locked in the token).
   * exclude: providers the browser could not connect to (fallback to the next one).
   */
  voiceSession: {
    req: { tools: AiToolDef[]; context: { today: string; locale: 'en' | 'sw'; page?: AiPageContext; memories?: string[] }; exclude?: VoiceProviderId[] }
    res: {
      provider: VoiceProviderId
      client_secret: string
      expires_at: number
      model: string
      voice: string
      ws_url?: string
      setup?: Record<string, unknown>
      fallback_from?: VoiceProviderId[]
    }
  }
  emailConnectStart: { req: { provider: 'gmail' | 'microsoft'; return_url: string }; res: { auth_url: string } }
  emailConnectImap: {
    req: {
      address: string
      display_name?: string
      imap: { host: string; port: number; secure: boolean; user: string; password: string }
      smtp: { host: string; port: number; secure: boolean; user: string; password: string }
    }
    res: { account_id: string }
  }
  emailDisconnect: { req: { account_id: string }; res: { ok: true } }
  emailSetSync: { req: { account_id: string; enabled: boolean }; res: { ok: true } }
  emailSyncNow: { req: { account_id?: string }; res: { synced: number; analyzed: number; errors: string[] } }
  emailAnalyze: { req: { email_id: string }; res: { ai: EmailInsight } }
  emailGenerateReply: { req: { email_id: string; language: 'en' | 'sw'; instructions?: string }; res: { draft_id: string } }
  emailSendDraft: { req: { draft_id: string }; res: { ok: true; sent_at: string } }
  aiRunMonitor: { req: Record<string, never>; res: { alerts_open: number; created: number; resolved: number } }
  /**
   * AI provider API keys (ai.manage). 'set' tests the key with the provider (unless skip_test), encrypts and stores it;
   * 'remove' deletes the saved key (the deployed secret, if any, is used again); 'test' checks the key in use.
   * The key is never returned.
   */
  aiManageKeys: {
    req: { action: 'set' | 'remove' | 'test'; provider: ChatProviderId; key?: string; skip_test?: boolean }
    res: { ok: true; provider: ChatProviderId; info: AiKeyInfo }
  }
}
export type CallableName = keyof CallableContracts
