/**
 * Demo backend — the same engine, business rules and hooks as production, running on an in-memory
 * store persisted to this browser's IndexedDB. No network, no Firebase.
 *
 * Demo sign-in is a convenience, NOT security: the accounts and password are published on the demo
 * sign-in screen and the data lives in the visitor's browser. Firestore security rules are not evaluated.
 */
import { createStore, del, get, keys, set } from 'idb-keyval'
import {
  authError,
  INVALID_CREDENTIALS,
  newPasswordProblem,
  setFlash,
  writeSessionMeta,
  type AuthApi,
  type AuthEvent,
  type Session,
  type SignOutReason,
} from './authTypes'
import { AI_COLLECTIONS, normalizeUserGrant, USER_GRANTABLE_PERMS } from '../shared/ai/contract'
import { createDb } from './client'
import { demoFileBlob } from './demoFiles'
import { createDemoAiFunctions, isAiCallable } from './demoAiFunctions'
import { seedDemoAiData } from './demoAiSeed'
import { seedDemoData } from './demoSeed'
import type { FunctionsApi, StorageApi } from './firebase'
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from './mode'
import type { Row } from './registry'
import { seedDocuments } from './session'
import { MemoryStore, type Store, type StoreEq, type StoreQueryOpts, type StoreTx } from './store'

// v3: AI Intelligence sample data (demoAiSeed.ts)
const DATA_VERSION = 'demo-v4'
const dataStore = typeof indexedDB !== 'undefined' ? createStore('abckit-demo-data', 'kv') : null
const fileStore = typeof indexedDB !== 'undefined' ? createStore('abckit-demo-files', 'files') : null
const SESSION_KEY = 'abckit-demo-session'

interface DemoSessionState {
  uid: string
  email: string
  signedInAt: number
}

function readSession(): DemoSessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as DemoSessionState) : null
  } catch {
    return null
  }
}
function writeSession(s: DemoSessionState | null, remember = true) {
  try {
    localStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(SESSION_KEY)
    if (s) (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------------------- persisted store

class DemoStore implements Store {
  mem = new MemoryStore()
  private readyP: Promise<void> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private init: (mem: MemoryStore) => Promise<void>

  constructor(init: (mem: MemoryStore) => Promise<void>) {
    this.init = init
  }

  /** loads (or creates) the demo data on first use */
  get ready(): Promise<void> {
    this.readyP ??= this.load().then(async (loaded) => {
      if (!loaded) {
        await this.init(this.mem)
        await this.save()
      }
    })
    return this.readyP
  }

  private async load(): Promise<boolean> {
    if (!dataStore) return false
    const snap = await get<{ version: string; tables: Record<string, Array<[string, Row]>> }>('snapshot', dataStore)
    if (!snap || snap.version !== DATA_VERSION) return false
    for (const [t, rows] of Object.entries(snap.tables)) this.mem.data.set(t, new Map(rows))
    return true
  }

  async save() {
    if (!dataStore) return
    const tables: Record<string, Array<[string, Row]>> = {}
    for (const [t, m] of this.mem.data) tables[t] = [...m.entries()]
    await set('snapshot', { version: DATA_VERSION, tables }, dataStore)
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.save(), 150)
  }

  async query(table: string, eqs: StoreEq[], opts?: StoreQueryOpts) {
    await this.ready
    return this.mem.query(table, eqs, opts)
  }
  async get(table: string, id: string) {
    await this.ready
    return this.mem.get(table, id)
  }
  async transaction<T>(fn: (tx: StoreTx) => Promise<T>) {
    await this.ready
    const out = await this.mem.transaction(fn)
    this.scheduleSave()
    return out
  }
  listen(table: string, eqs: StoreEq[], cb: (rows: Row[]) => void) {
    return this.mem.listen(table, eqs, cb)
  }
}

/** Erase all demo data and files in this browser (next start re-creates the sample data). */
export async function resetDemoData() {
  if (dataStore) await del('snapshot', dataStore)
  if (fileStore) for (const k of await keys(fileStore)) await del(k, fileStore)
  writeSession(null)
  writeSessionMeta(null)
}

// ----------------------------------------------------------------------------- seeding

/** fills an empty store with the demo accounts and [DEMO] sample data (exported for tests) */
export async function initialiseDemoData(mem: MemoryStore) {
  const now = new Date().toISOString()
  const put = (t: string, id: string, row: Row) => {
    let c = mem.data.get(t)
    if (!c) mem.data.set(t, (c = new Map()))
    c.set(id, JSON.parse(JSON.stringify(row)))
  }
  for (const [t, id, row] of seedDocuments(now)) put(t, id, row)
  put('meta', 'bootstrap', { owner: 'demo', at: now })
  const company = mem.data.get('company_settings')!.get('1')!
  company.company_name = 'ARICOM BUILDING CONTRACTORS [DEMO]'
  for (const a of DEMO_ACCOUNTS) {
    const id = `demo-${a.role}`
    put('profiles', id, {
      id,
      full_name: a.name,
      email: a.email,
      username: a.username,
      phone: null,
      job_title: a.label,
      avatar_url: null,
      role_id: a.role,
      is_active: true,
      last_seen_at: null,
      created_at: now,
      updated_at: now,
    })
    put('usernames', a.username, { username: a.username, user_id: id, email: a.email })
  }
  // business data goes through the real engine + hooks, signed in as the demo super administrator
  const seeder = createDb({ store: mem, currentUser: () => ({ uid: 'demo-super_admin', email: 'admin@demo.abckit' }) })
  const asUser = (uid: string) => createDb({ store: mem, currentUser: () => ({ uid, email: `${uid}@demo.abckit` }) })
  await seedDemoData(seeder, asUser)
  await seedDemoAiData(mem, seeder, asUser)
}

// ----------------------------------------------------------------------------- the demo db

function slow<T>(v: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(v), 350))
}

export function createDemoDb() {
  const store = new DemoStore(initialiseDemoData)
  let current = readSession()
  const listeners = new Set<(e: AuthEvent, s: Session | null) => void>()

  const toSession = (s: DemoSessionState | null): Session | null =>
    s
      ? {
          user: {
            id: s.uid,
            email: s.email,
            user_metadata: {},
            app_metadata: { demo: true },
            last_sign_in_at: new Date(s.signedInAt).toISOString(),
          },
          access_token: 'demo',
        }
      : null

  async function finishSignOut(reason: SignOutReason) {
    writeSession(null)
    writeSessionMeta(null)
    current = null
    setFlash(reason)
    window.location.replace(`${window.location.pathname}${window.location.search}#/login`)
    window.location.reload()
  }

  const auth: AuthApi = {
    isDemo: true,
    async getSession() {
      await store.ready
      return { data: { session: toSession(current) }, error: null }
    },
    async getUser() {
      await store.ready
      return { data: { user: toSession(current)?.user ?? null }, error: null }
    },
    onAuthStateChange(cb) {
      listeners.add(cb)
      return { data: { subscription: { unsubscribe: () => void listeners.delete(cb) } } }
    },
    async signInWithPassword({ email: identifier, password, remember = true }) {
      await store.ready
      const id = identifier.trim().toLowerCase()
      const profiles = await store.mem.query('profiles', [])
      const p = profiles.find((x) => String(x.email).toLowerCase() === id || (x.username && String(x.username).toLowerCase() === id))
      // same generic message for unknown accounts and wrong passwords; small delay like a real server
      if (!p || password !== DEMO_PASSWORD) return slow({ data: { user: null, session: null }, error: authError(INVALID_CREDENTIALS, 'auth/invalid-credential') })
      current = { uid: p.id, email: p.email, signedInAt: Date.now() }
      writeSession(current, remember)
      writeSessionMeta({ remember, lastActive: Date.now() })
      db.invalidateMe()
      const s = toSession(current)
      listeners.forEach((l) => l('SIGNED_IN', s))
      return { data: { user: s!.user, session: s }, error: null }
    },
    async signOut(opts = {}) {
      await finishSignOut(opts.reason ?? (opts.scope === 'global' ? 'revoked' : 'user'))
      return { error: null }
    },
    async updateUser() {
      return { data: { user: null }, error: authError('Passwords cannot be changed in demo mode (all demo accounts use the published demo password).', 'demo/disabled') }
    },
    async resetPasswordForEmail() {
      return { data: null, error: authError(`Demo mode sends no email. All demo accounts use the password "${DEMO_PASSWORD}".`, 'demo/disabled') }
    },
    async getSignedInAt() {
      return current?.signedInAt ?? null
    },
  }

  // ---- files in IndexedDB
  const dataUrls = new Map<string, string>()
  const toDataUrl = (b: Blob) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result))
      r.onerror = () => rej(r.error)
      r.readAsDataURL(b)
    })
  const notFound = { message: 'File not found', code: 'storage/object-not-found', statusCode: '400' }

  const storage = {
    from(bucket: string) {
      const key = (p: string) => `${bucket}/${p.replace(/^\/+/, '')}`
      /** an uploaded file, or a generated [DEMO] sample file (demoFiles.ts), cached after the first use */
      const blobOf = async (path: string): Promise<Blob | null> => {
        const f = fileStore ? await get<{ blob: Blob }>(key(path), fileStore) : undefined
        if (f) return f.blob
        const sample = await demoFileBlob(bucket, path)
        if (sample && fileStore) await set(key(path), { blob: sample, created_at: new Date().toISOString() }, fileStore)
        return sample
      }
      return {
        async upload(path: string, file: Blob, opts: { contentType?: string; upsert?: boolean; contentDisposition?: string } = {}) {
          void opts
          if (fileStore) await set(key(path), { blob: file, created_at: new Date().toISOString() }, fileStore)
          if (bucket === 'branding') dataUrls.set(key(path), await toDataUrl(file))
          return { data: { path, fullPath: key(path) }, error: null }
        },
        async createSignedUrl(path: string, _expiresIn: number, _opts?: { download?: string | boolean }) {
          const blob = await blobOf(path)
          if (!blob) return { data: null, error: notFound }
          return { data: { signedUrl: URL.createObjectURL(blob) }, error: null }
        },
        async createSignedUrls(paths: string[], _expiresIn: number) {
          const data = await Promise.all(
            paths.map(async (path) => {
              const f = fileStore ? await get<{ blob: Blob }>(key(path), fileStore) : undefined
              return f ? { path, signedUrl: URL.createObjectURL(f.blob), error: null } : { path, signedUrl: '', error: 'File not found' }
            }),
          )
          return { data, error: null }
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: dataUrls.get(key(path)) ?? '' } }
        },
        async list(prefix = '', opts: { limit?: number; sortBy?: { column: string; order: 'asc' | 'desc' } } = {}) {
          const pre = key(prefix).replace(/\/?$/, '/')
          const all = fileStore ? ((await keys(fileStore)) as string[]).filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes('/')) : []
          const items = await Promise.all(
            all.map(async (k) => {
              const f = await get<{ blob: Blob; created_at: string }>(k, fileStore!)
              return {
                name: k.slice(pre.length),
                id: k,
                created_at: f?.created_at ?? '',
                updated_at: f?.created_at ?? '',
                metadata: { size: f?.blob.size ?? 0, mimetype: f?.blob.type ?? '' },
              }
            }),
          )
          if (opts.sortBy) {
            const { column, order } = opts.sortBy
            items.sort((a, b) => String((a as Row)[column]).localeCompare(String((b as Row)[column])) * (order === 'desc' ? -1 : 1))
          }
          return { data: items.slice(0, opts.limit ?? 1000), error: null }
        },
        async remove(paths: string[]) {
          if (fileStore) for (const p of paths) await del(key(p), fileStore)
          return { data: paths.map((name) => ({ name })), error: null }
        },
        async download(path: string) {
          const blob = await blobOf(path)
          return blob ? { data: blob, error: null } : { data: null, error: notFound }
        },
      }
    },
  } as unknown as StorageApi

  // ---- AI callables: local [DEMO] stand-ins (no model, no mailbox, nothing leaves the browser)
  const demoAi = createDemoAiFunctions({ db: () => db, store })

  // ---- admin-users function, emulated with the same checks
  const functions: FunctionsApi = {
    async invoke(name: string, opts: { body?: unknown } = {}) {
      const body = (opts.body ?? {}) as Record<string, any>
      const fail = (message: string) => ({ data: null, error: { message, code: 'functions/failed-precondition', context: { json: async () => ({ error: message }) } } })
      if (isAiCallable(name)) {
        await store.ready
        try {
          return await demoAi(name, body)
        } catch (e) {
          return fail((e as Error)?.message ?? String(e))
        }
      }
      if (name !== 'admin-users') return fail(`Function ${name} is not available in demo mode`)
      const me = await db.me()
      if (!me?.can('users.manage')) return fail('You do not have permission to manage users')
      if (body.action === 'invite') {
        const email = String(body.email ?? '').trim().toLowerCase()
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Invalid email')
        if (String(body.full_name ?? '').trim().length < 2) return fail('Full name is required')
        const role = await db.engine.getById('roles', String(body.role_key ?? 'employee'))
        if (!role) return fail('Unknown role')
        if (role.key === 'super_admin' && me.roleKey !== 'super_admin') return fail('Only a Super Administrator can invite a Super Administrator')
        const existing = await store.mem.query('profiles', [{ field: 'email', value: email }])
        if (existing.length) return fail('A user with this email already exists')
        const id = `demo-${crypto.randomUUID()}`
        const now = new Date().toISOString()
        await store.transaction(async (tx) => {
          tx.set('profiles', id, {
            id, email, full_name: String(body.full_name).trim(), username: null, phone: null, job_title: null, avatar_url: null,
            role_id: role.id, is_active: true, last_seen_at: null, created_at: now, updated_at: now,
          })
        })
        db.invalidateMe()
        return { data: { ok: true, user_id: id, needs_password_email: false, demo: true }, error: null }
      }
      if (body.action === 'set_active') {
        if (body.user_id === me.uid && !body.active) return fail('You cannot deactivate your own account')
        const { error } = await db.from('profiles').update({ is_active: !!body.active }).eq('id', String(body.user_id))
        return error ? fail(error.message) : { data: { ok: true }, error: null }
      }
      if (body.action === 'set_password') {
        // same checks as the real function; demo sign-in always uses DEMO_PASSWORD, so nothing is actually changed
        const userId = String(body.user_id ?? '')
        const problem = newPasswordProblem(String(body.password ?? ''))
        if (problem) return fail(problem)
        if (userId === me.uid) return fail('Change your own password from your Profile page')
        const target = await db.engine.getById('profiles', userId)
        if (!target) return fail('User profile not found')
        if (target.role_id === 'super_admin' && me.roleKey !== 'super_admin') return fail('Only a Super Administrator can change the password of a Super Administrator')
        return { data: { ok: true, sessions_ended: body.sign_out !== false, demo: true }, error: null }
      }
      if (body.action === 'set_access') {
        // same checks as the real function (functions/src/index.ts setAccess), written to this browser only
        const userId = String(body.user_id ?? '')
        if (!Array.isArray(body.perms)) return fail('perms must be a list')
        const unknown = body.perms.filter((p: unknown) => !(USER_GRANTABLE_PERMS as readonly unknown[]).includes(p))
        if (unknown.length) return fail(`These permissions cannot be granted per user: ${unknown.join(', ')}`)
        if (userId === me.uid) return fail('You cannot change your own access — ask another administrator')
        const target = await db.engine.getById('profiles', userId)
        if (!target) return fail('User profile not found')
        if (target.role_id === 'super_admin') return fail('A Super Administrator already has every permission')
        const perms = normalizeUserGrant(body.perms)
        const now = new Date().toISOString()
        await store.transaction(async (tx) => {
          const old = await tx.get(AI_COLLECTIONS.userAccess, userId)
          const next = perms.length ? { id: userId, user_id: userId, perms, updated_by: me.uid, updated_at: now } : null
          if (next) tx.set(AI_COLLECTIONS.userAccess, userId, next)
          else tx.delete(AI_COLLECTIONS.userAccess, userId)
          const logId = crypto.randomUUID()
          tx.set('audit_logs', logId, {
            id: logId, table_name: AI_COLLECTIONS.userAccess, record_id: userId, action: !old ? 'INSERT' : next ? 'UPDATE' : 'DELETE',
            old_data: old, new_data: next, changed_by: me.uid, changed_at: now,
          })
        })
        return { data: { ok: true, perms, demo: true }, error: null }
      }
      return fail('Unknown action')
    },
  } as FunctionsApi

  const db = createDb({
    store,
    currentUser: () => (current ? { uid: current.uid, email: current.email } : null),
    auth,
    storage,
    functions,
  })
  return db
}
