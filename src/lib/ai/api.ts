/**
 * Typed access to the AI callables (src/shared/ai/contract.ts CallableContracts).
 * Errors are surfaced as-is (e.g. "function not deployed", "AI is not configured") — never faked as success.
 */
import type { CallableContracts, CallableName } from '@/shared/ai/contract'

export interface Invoker {
  invoke(name: string, opts?: { body?: unknown }): Promise<{ data: any; error: any }>
}

export class AiCallError extends Error {
  code: string
  callable: string
  constructor(callable: string, message: string, code = '') {
    super(message)
    this.callable = callable
    this.code = code
  }
}

function messageOf(name: string, error: any): string {
  const raw = String(error?.message ?? error ?? 'Request failed')
  const code = String(error?.code ?? '')
  if (/server functions, which are not set up/i.test(raw))
    return 'The real AI is not switched on yet: ABCkit’s AI server functions are not deployed on this Firebase project (they need the Blaze plan + deploy, and an OpenAI or Google Gemini API key). To try it free on this computer, run the local server (npm run emulators + npm run dev:local) — see functions/AI_SETUP.md. Demo Mode shows how it works.'
  if (/not deployed|functions\/not-found/i.test(raw) || code === 'functions/not-found')
    return `The AI service is not available: the "${name}" Cloud Function is not deployed. ${raw.includes('Blaze') ? '' : 'Ask your administrator to deploy the AI functions.'}`.trim()
  if (code === 'functions/unauthenticated') return 'Your session has expired. Sign in again.'
  if (code === 'functions/permission-denied') return raw || 'Your role does not allow this AI action.'
  return raw
}

export async function callAi<N extends CallableName>(fns: Invoker, name: N, body: CallableContracts[N]['req']): Promise<CallableContracts[N]['res']> {
  const { data, error } = await fns.invoke(name, { body })
  if (error) throw new AiCallError(name, messageOf(name, error), String(error?.code ?? ''))
  if (data == null) throw new AiCallError(name, `The "${name}" function returned no data.`)
  return data as CallableContracts[N]['res']
}
