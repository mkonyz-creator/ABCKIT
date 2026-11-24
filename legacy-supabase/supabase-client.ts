import { createClient } from '@supabase/supabase-js'
import { DEMO_URL, IS_DEMO } from '@/demo/flag'

/**
 * Only the public (anon / publishable) key is ever used in the browser.
 * Row Level Security in the database enforces every permission.
 * NEVER put a service-role key in a VITE_* variable — Vite inlines those into the bundle.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) as string | undefined

export const isDemo = IS_DEMO
export const isSupabaseConfigured = IS_DEMO || Boolean(url && anonKey)

if (!IS_DEMO && anonKey && /service_role/.test(atobSafe(anonKey.split('.')[1] ?? ''))) {
  throw new Error('A service-role key was supplied to the frontend. Use the anon/publishable key instead.')
}

/** Demo mode routes every API call to the in-browser PGlite backend (loaded lazily). */
const demoFetch: typeof fetch = async (input, init) => (await import('@/demo/server')).demoFetch(input, init)

export const supabase = createClient(IS_DEMO ? DEMO_URL : url || 'http://127.0.0.1:54321', IS_DEMO ? 'demo-anon-key' : anonKey || 'not-configured', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: !IS_DEMO,
    flowType: 'pkce',
    storageKey: 'abckit-auth',
  },
  global: { headers: { 'x-application-name': 'abckit-web' }, ...(IS_DEMO ? { fetch: demoFetch } : {}) },
})

function atobSafe(s: string) {
  try {
    return atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return ''
  }
}

/** Turns a storage signed/public URL into something an <img>/<a> can open (demo files live in IndexedDB). */
export async function viewableUrl(u: string) {
  if (!IS_DEMO) return u
  return (await import('@/demo/server')).demoViewableUrl(u)
}

/** Throws the Supabase error so React Query can surface it. */
export function unwrap<T>(res: { data: T | null; error: { message: string; code?: string; details?: string; hint?: string } | null }): T {
  if (res.error) throw res.error
  return res.data as T
}
