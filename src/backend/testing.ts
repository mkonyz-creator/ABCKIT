/**
 * Test harness: the real engine + domain hooks on an in-memory store (no Firebase needed).
 * Security rules are NOT evaluated here — test those with the Firestore emulator (tests/rules).
 */
import { createDb } from './client'
import type { Row } from './registry'
import { seedDocuments, type AuthUser } from './session'
import { MemoryStore } from './store'

export function createTestDb() {
  const store = new MemoryStore()
  let current: AuthUser | null = null
  const db = createDb({ store, currentUser: () => current })
  const now = new Date().toISOString()
  for (const [t, id, row] of seedDocuments(now)) {
    let c = store.data.get(t)
    if (!c) store.data.set(t, (c = new Map()))
    c.set(id, JSON.parse(JSON.stringify(row)))
  }
  let n = 0

  /** create an auth user + profile directly (bypassing hooks); returns the uid */
  function addUser(roleKey: string, opts: { active?: boolean; name?: string; email?: string } = {}) {
    const uid = `u${++n}-${roleKey}`
    let c = store.data.get('profiles')
    if (!c) store.data.set('profiles', (c = new Map()))
    c.set(uid, {
      id: uid,
      full_name: opts.name ?? `${roleKey} user`,
      email: opts.email ?? `${uid}@test.local`,
      phone: null,
      job_title: null,
      avatar_url: null,
      role_id: roleKey,
      is_active: opts.active ?? true,
      last_seen_at: null,
      created_at: now,
      updated_at: now,
    })
    return uid
  }

  function as(uid: string | null) {
    current = uid ? { uid, email: `${uid}@test.local` } : null
    db.invalidateMe()
    return db
  }

  const raw = {
    get: (table: string, id: string): Row | undefined => store.data.get(table)?.get(id),
    all: (table: string): Row[] => [...(store.data.get(table)?.values() ?? [])],
    put: (table: string, id: string, row: Row) => {
      let c = store.data.get(table)
      if (!c) store.data.set(table, (c = new Map()))
      c.set(id, row)
    },
  }

  return { db, store, addUser, as, raw }
}

/** unwrap a {data,error} result in tests, throwing a readable error */
export function ok<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new Error(`${res.error.code}: ${res.error.message}`)
  return res.data
}

/**
 * The Demo Mode data set (demo accounts + [DEMO] business + AI sample data) on an in-memory store,
 * with the demo AI callables wired in. `as(uid)` switches the signed-in demo user (e.g. 'demo-managing_director').
 */
export async function createDemoTestDb() {
  const { initialiseDemoData } = await import('./demo')
  const { createDemoAiFunctions } = await import('./demoAiFunctions')
  const store = new MemoryStore()
  await initialiseDemoData(store)
  let current: AuthUser | null = null
  // eslint-disable-next-line prefer-const
  let db: ReturnType<typeof createDb>
  const ai = createDemoAiFunctions({ db: () => db, store })
  db = createDb({ store, currentUser: () => current, functions: { invoke: (name, opts) => ai(name, (opts?.body ?? {}) as Record<string, any>) } })
  function as(uid: string | null) {
    current = uid ? { uid, email: `${uid}@demo.abckit` } : null
    db.invalidateMe()
    return db
  }
  const raw = {
    get: (table: string, id: string): Row | undefined => store.data.get(table)?.get(id),
    all: (table: string): Row[] => [...(store.data.get(table)?.values() ?? [])],
  }
  return { db, store, as, raw }
}
