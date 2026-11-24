/**
 * Hooks and actions shared by the AI Intelligence tabs. Data is read through `db` under the signed-in user's
 * own permissions; the model is reached only through the callables (src/lib/ai/api.ts).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'
import { db, IS_DEMO, unwrap } from '@/lib/backend'
import { callAi } from '@/lib/ai/api'
import { detectLanguage } from '@/lib/ai/demoAssistant'
import { runAssistant, type ApiMessage, type LoopResult, type LoopStep } from '@/lib/ai/loop'
import { createToolEnv, executeTool, memoryContext, toolDefinitions, type ActionConfirm } from '@/lib/ai/tools'
import { AI_COLLECTIONS as C, DEFAULT_AI_SETTINGS, type AiPageContext, type AiReport, type ChatProviderId, type AiSettings, type AiStatus, type CallableContracts, type CallableName } from '@/shared/ai/contract'
import { useAuth } from '@/providers/AuthProvider'

export { C }

/** every AI query key starts with 'ai' (or the collection name), so one invalidation refreshes the module */
export const AI_KEY = 'ai'

export function useAiInvalidate() {
  const qc = useQueryClient()
  return useCallback(
    (...tables: string[]) =>
      Promise.all([qc.invalidateQueries({ queryKey: [AI_KEY] }), ...tables.map((t) => qc.invalidateQueries({ queryKey: [t] }))]),
    [qc],
  )
}

/** typed callable */
export function useCallable() {
  return useCallback(<N extends CallableName>(name: N, body: CallableContracts[N]['req']) => callAi(db.functions, name, body), [])
}

export function useAiSettings() {
  const { can } = useAuth()
  return useQuery({
    queryKey: [C.settings, 'doc'],
    enabled: can('ai.view'),
    queryFn: async () => {
      const rows = unwrap(await db.from(C.settings).select('*').eq('id', 'settings')) as AiSettings[]
      const base: AiSettings = { ...DEFAULT_AI_SETTINGS, updated_at: '', updated_by: null }
      return { exists: rows.length > 0, settings: rows[0] ? { ...base, ...rows[0], notify: { ...base.notify, ...(rows[0].notify ?? {}) } } : base }
    },
  })
}

export function useAiStatus() {
  const { can } = useAuth()
  return useQuery({
    queryKey: [C.status, 'doc'],
    enabled: can('ai.view'),
    queryFn: async () => ((unwrap(await db.from(C.status).select('*').eq('id', 'status')) as AiStatus[])[0] ?? null),
  })
}

/**
 * Live updates without polling: new alerts / newly synced emails (status 'new') arrive through the
 * realtime listener and refresh the module's cached queries.
 */
export function useAiLive() {
  const { can, session } = useAuth()
  const invalidate = useAiInvalidate()
  const canView = can('ai.view')
  const canEmail = can('ai.email')
  useEffect(() => {
    if (!session || !canView) return
    let t: ReturnType<typeof setTimeout> | null = null
    const bump = (table: string) => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void invalidate(table, C.status), 400)
    }
    const ch = db.channel('ai-live').on('postgres_changes', { event: 'INSERT', schema: 'public', table: C.alerts, filter: 'status=eq.open' }, () => bump(C.alerts))
    if (canEmail) ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: C.emails, filter: 'status=eq.new' }, () => bump(C.emails))
    ch.subscribe()
    return () => {
      if (t) clearTimeout(t)
      void db.removeChannel(ch)
    }
  }, [session, canView, canEmail, invalidate])
}

// ----------------------------------------------------------------------------- assistant runs

export interface AskOptions {
  purpose: 'chat' | 'report'
  messages: ApiMessage[]
  onStep?: (s: LoopStep) => void
  userName: string
  role: string
  /** floating assistant: the page on screen, spoken answers, and the language the user speaks */
  page?: AiPageContext
  voice?: boolean
  locale?: 'en' | 'sw'
  signal?: AbortSignal
  /** lets the assistant perform confirmed actions (create task, purchase request…); without it, it is read-only */
  confirm?: (req: ActionConfirm) => Promise<boolean>
  /** provider that answered the previous question of this conversation */
  providerHint?: ChatProviderId
}

export async function askAssistant(o: AskOptions): Promise<LoopResult> {
  const env = await createToolEnv(db, { fns: db.functions, confirm: o.confirm })
  const last = o.messages[o.messages.length - 1]
  const lastText = typeof last?.content === 'string' ? last.content : ''
  // the assistant's long-term memory of this user goes with every chat question
  const memories = o.purpose === 'chat' ? await memoryContext(db, env.me.uid) : []
  return runAssistant({
    fns: db.functions,
    purpose: o.purpose,
    messages: o.messages,
    tools: toolDefinitions(env.me, { actions: !!o.confirm }),
    context: {
      today: env.today,
      user_name: o.userName,
      role: o.role,
      locale: o.locale ?? detectLanguage(lastText),
      ...(o.page ? { page: o.page } : {}),
      ...(o.voice ? { voice: true } : {}),
      ...(o.providerHint ? { provider_hint: o.providerHint } : {}),
      ...(memories.length ? { memories } : {}),
    },
    execute: (name, input) => executeTool(name, input, env),
    onStep: o.onStep,
    signal: o.signal,
  })
}

export const REPORT_PROMPTS = {
  daily_brief: {
    title: 'Daily brief',
    prompt:
      "Write today's daily brief for management: what is happening across the company today — projects behind schedule, overdue tasks, pending approvals, overdue payments, supplier deliveries, important emails, site issues and open alerts. Finish with the recommended priorities for today.",
  },
  operations: {
    title: 'Operations report',
    prompt: 'Give me a complete company operations report: projects and schedule, approvals, procurement and deliveries, finance (receivables, payables, budgets), site issues and safety, stock, workforce, alerts and risks, with recommendations.',
  },
  email_digest: {
    title: 'Email digest',
    prompt: 'Write an email digest: summarize all important communications from this week, grouped by category, with the required actions, responsible people and deadlines, and flag anything suspicious.',
  },
} as const

export function projectPrompt(p: { id: string; name: string }) {
  return `Analyse the project "${p.name}" (id ${p.id}): schedule versus time elapsed, budget use, open and overdue tasks, pending approvals, recent site issues, related emails and alerts. Give the main risks and recommended actions.`
}

/** runs the report writer, saves the result in ai_reports and records an ai_activity 'report' row */
export async function generateReport(o: { kind: AiReport['kind']; title: string; prompt: string; userName: string; role: string; onStep?: (s: LoopStep) => void }) {
  let result: LoopResult | null = null
  let error: unknown = null
  try {
    result = await askAssistant({ purpose: 'report', messages: [{ role: 'user', content: o.prompt }], onStep: o.onStep, userName: o.userName, role: o.role })
  } catch (e) {
    error = e
  }
  await db.from(C.activity).insert({ action: 'report', detail: `${o.title}${error ? ` — failed: ${(error as Error)?.message ?? error}` : ''}`.slice(0, 500), ok: !error, is_demo: IS_DEMO })
  if (error || !result) throw error
  const heading = result.text.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const report = unwrap(
    await db
      .from(C.reports)
      .insert({ title: (heading || `${o.title} – ${new Date().toISOString().slice(0, 10)}`).slice(0, 200), kind: o.kind, prompt: o.prompt, content_md: result.text, model: result.model, is_demo: IS_DEMO })
      .select()
      .single(),
  ) as AiReport
  return { report, result }
}
