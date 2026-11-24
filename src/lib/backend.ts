/**
 * Backend entry point for the app: Firebase in production, or the browser-only Demo Mode.
 * `db` keeps the call shapes of the supabase-js client this app was written against —
 * see src/backend/ for the engine, business rules and security model.
 */
export { db, isBackendConfigured, IS_DEMO, DEMO_ACCOUNTS, DEMO_PASSWORD, enterDemo, exitDemo } from '@/backend'
export type { Session } from '@/backend'
export { resetDemoData } from '@/backend/demo'

/** Throws the backend error so React Query can surface it. */
export function unwrap<T>(res: { data: T | null; error: { message: string; code?: string; details?: string | null; hint?: string | null } | null }): T {
  if (res.error) throw res.error
  return res.data as T
}

/** Storage URLs from Firebase are directly viewable. Kept for call-site compatibility. */
export async function viewableUrl(u: string) {
  return u
}
