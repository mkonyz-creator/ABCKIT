/**
 * Firebase initialisation + the auth / storage / functions adapters behind `db`.
 * Configuration comes from VITE_FIREBASE_* variables (.env.local). These web-config values are public by
 * design; security comes from Firebase Auth + firestore.rules + storage.rules.
 */
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import {
  browserLocalPersistence,
  browserSessionPersistence,
  confirmPasswordReset,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  getIdTokenResult,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  updateProfile,
  type Auth,
  type User,
} from 'firebase/auth'
import {
  clearIndexedDbPersistence,
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
  type Firestore,
} from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from 'firebase/functions'
import {
  connectStorageEmulator,
  deleteObject,
  getBlob,
  getDownloadURL,
  getMetadata,
  getStorage,
  list,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage'
import { createDb } from './client'
import { FirestoreStore } from './firestoreStore'
import { ensureProfile } from './session'
import {
  authError,
  INVALID_CREDENTIALS,
  setFlash,
  writeSessionMeta,
  type AuthApi,
  type AuthErrorShape,
  type AuthEvent,
  type Session,
  type SignOutReason,
} from './authTypes'
export type { Session, SessionUser } from './authTypes'

const env = import.meta.env
export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: env.VITE_FIREBASE_APP_ID as string | undefined,
}

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId)
const useEmulators = env.VITE_USE_EMULATORS === 'true'

let app: FirebaseApp
let fs: Firestore
let auth: Auth
let storage: FirebaseStorage
let functions: Functions

function initFirebase() {
  if (app) return
  app = initializeApp(firebaseConfig)
  fs = initializeFirestore(app, {
    ignoreUndefinedProperties: true,
    // offline reads for site devices; cleared on sign-out (shared devices)
    localCache: typeof indexedDB !== 'undefined' ? persistentLocalCache({ tabManager: persistentMultipleTabManager() }) : undefined,
  })
  auth = getAuth(app)
  storage = getStorage(app)
  functions = getFunctions(app, (env.VITE_FIREBASE_FUNCTIONS_REGION as string) || 'us-central1')
  if (useEmulators) {
    connectFirestoreEmulator(fs, '127.0.0.1', 8080)
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    connectStorageEmulator(storage, '127.0.0.1', 9199)
    connectFunctionsEmulator(functions, '127.0.0.1', 5001)
  }
}

// ----------------------------------------------------------------------------- auth adapter

const toSession = (u: User | null): Session | null =>
  u
    ? {
        user: {
          id: u.uid,
          email: u.email,
          user_metadata: { full_name: u.displayName },
          app_metadata: {},
          last_sign_in_at: u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).toISOString() : undefined,
          created_at: u.metadata.creationTime ? new Date(u.metadata.creationTime).toISOString() : undefined,
        },
        access_token: '',
      }
    : null

const AUTH_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': INVALID_CREDENTIALS,
  'auth/invalid-login-credentials': INVALID_CREDENTIALS,
  'auth/wrong-password': INVALID_CREDENTIALS,
  'auth/user-not-found': INVALID_CREDENTIALS,
  'auth/invalid-email': 'Invalid email address',
  'auth/user-disabled': 'This account has been deactivated. Contact your administrator.',
  'auth/too-many-requests': 'Too many failed attempts. Sign-in for this account is temporarily blocked — wait a few minutes or reset your password.',
  'auth/network-request-failed': 'Network error — check your connection',
  'auth/weak-password': 'Password is too weak',
  'auth/requires-recent-login': 'For security, sign out and sign in again before changing your password.',
  'auth/email-already-in-use': 'An account with this email already exists',
  'auth/expired-action-code': 'This link has expired. Request a new one.',
  'auth/invalid-action-code': 'This link is invalid or was already used. Request a new one.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled for this Firebase project (Authentication → Sign-in method).',
  'auth/configuration-not-found': 'Firebase Authentication is not set up for this project yet (Firebase console → Authentication → Get started).',
}
const toAuthError = (e: unknown): AuthErrorShape => {
  const code = (e as { code?: string })?.code ?? 'auth/error'
  return authError(AUTH_MESSAGES[code] ?? (e as Error)?.message ?? 'Authentication failed', code)
}

/** Firebase password-reset links carry ?mode=resetPassword&oobCode=… (custom action URL → this app). */
function resetCode(): string | null {
  if (typeof window === 'undefined') return null
  const search = new URLSearchParams(window.location.search || window.location.hash.split('?')[1] || '')
  return search.get('mode') === 'resetPassword' ? search.get('oobCode') : null
}

/** Reload on the login page, replacing the current history entry so Back cannot reopen a protected page. */
export function hardRedirectToLogin() {
  window.location.replace(`${window.location.pathname}${window.location.search}#/login`)
  window.location.reload()
}

interface FirebaseAuthDeps {
  onUser(u: User | null): Promise<void>
  lookupUsername(name: string): Promise<string | null>
  revokeAllSessions(): Promise<void>
}

function createAuthApi(deps: FirebaseAuthDeps): AuthApi {
  const listeners = new Set<(e: AuthEvent, s: Session | null) => void>()
  // listeners hear about a user only after their profile exists (first sign-in creates it)
  let resolveReady: () => void
  const ready = new Promise<void>((r) => (resolveReady = r))
  let chain = Promise.resolve()
  onAuthStateChanged(auth, (u) => {
    chain = chain.then(async () => {
      await deps.onUser(u).catch((e) => console.error('[auth] profile', e))
      resolveReady()
      const s = toSession(u)
      listeners.forEach((l) => l(u ? 'SIGNED_IN' : 'SIGNED_OUT', s))
    })
  })

  async function finishSignOut(reason: SignOutReason) {
    await signOut(auth).catch(() => undefined)
    writeSessionMeta(null)
    // shared site devices: drop the offline Firestore cache so the next user cannot read it
    try {
      await terminate(fs)
      await clearIndexedDbPersistence(fs)
    } catch {
      /* ignore */
    }
    try {
      await caches.delete('abckit-public-files')
    } catch {
      /* Cache API unavailable */
    }
    setFlash(reason)
    hardRedirectToLogin()
  }

  return {
    isDemo: false,
    async getSession() {
      await ready
      return { data: { session: toSession(auth.currentUser) }, error: null }
    },
    async getUser() {
      await ready
      return { data: { user: toSession(auth.currentUser)?.user ?? null }, error: null }
    },
    onAuthStateChange(cb) {
      listeners.add(cb)
      if (resetCode()) queueMicrotask(() => cb('PASSWORD_RECOVERY', null))
      return { data: { subscription: { unsubscribe: () => void listeners.delete(cb) } } }
    },
    async signInWithPassword({ email: identifier, password, remember = true }) {
      try {
        let email = identifier.trim()
        if (!email.includes('@')) {
          const found = await deps.lookupUsername(email.toLowerCase())
          // unknown username: same message and code as a wrong password
          if (!found) return { data: { user: null, session: null }, error: authError(INVALID_CREDENTIALS, 'auth/invalid-credential') }
          email = found
        }
        // Remember me → session survives browser restarts; otherwise it ends with the browser session
        await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence)
        const cred = await signInWithEmailAndPassword(auth, email, password)
        writeSessionMeta({ remember, lastActive: Date.now() })
        await deps.onUser(cred.user)
        await ready
        const session = toSession(cred.user)
        return { data: { user: session!.user, session }, error: null }
      } catch (e) {
        return { data: { user: null, session: null }, error: toAuthError(e) }
      }
    },
    async signOut(opts = {}) {
      if (opts.scope === 'global') {
        try {
          await deps.revokeAllSessions()
        } catch (e) {
          return { error: toAuthError(e) }
        }
      }
      await finishSignOut(opts.reason ?? (opts.scope === 'global' ? 'revoked' : 'user'))
      return { error: null }
    },
    async updateUser({ password }) {
      try {
        const code = resetCode()
        if (password && !auth.currentUser && code) {
          await confirmPasswordReset(auth, code, password)
          return { data: { user: null }, error: null }
        }
        if (!auth.currentUser) throw Object.assign(new Error('Not signed in'), { code: 'auth/requires-recent-login' })
        if (password) await updatePassword(auth.currentUser, password)
        return { data: { user: toSession(auth.currentUser)!.user }, error: null }
      } catch (e) {
        return { data: { user: null }, error: toAuthError(e) }
      }
    },
    async resetPasswordForEmail(email, opts = {}) {
      try {
        await sendPasswordResetEmail(auth, email, opts.redirectTo ? { url: opts.redirectTo.split('#')[0] } : undefined)
        return { data: {}, error: null }
      } catch (e) {
        // do not reveal whether the address exists
        if ((e as { code?: string })?.code === 'auth/user-not-found') return { data: {}, error: null }
        return { data: null, error: toAuthError(e) }
      }
    },
    async getSignedInAt() {
      const u = auth.currentUser
      if (!u) return null
      try {
        const t = await getIdTokenResult(u)
        return new Date(t.authTime).getTime()
      } catch {
        return u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).getTime() : null
      }
    },
  }
}

// ----------------------------------------------------------------------------- storage adapter
// Old Supabase buckets become top-level folders: documents/, site-photos/, project-photos/, branding/

function storageError(e: unknown) {
  const code = (e as { code?: string })?.code ?? ''
  const message =
    code === 'storage/unauthorized'
      ? 'Permission denied: your role cannot access this file'
      : code === 'storage/object-not-found'
        ? 'File not found'
        : code === 'storage/quota-exceeded'
          ? 'Storage quota exceeded'
          : ((e as Error)?.message ?? 'Storage error')
  return { message, code, statusCode: code === 'storage/unauthorized' ? '403' : '400' }
}

function createStorageApi() {
  return {
    from(bucket: string) {
      const r = (path: string) => ref(storage, `${bucket}/${path.replace(/^\/+/, '')}`)
      return {
        async upload(path: string, file: Blob, opts: { contentType?: string; upsert?: boolean; contentDisposition?: string } = {}) {
          try {
            await uploadBytes(r(path), file, { contentType: opts.contentType || file.type || undefined, contentDisposition: opts.contentDisposition })
            return { data: { path, fullPath: `${bucket}/${path}` }, error: null }
          } catch (e) {
            return { data: null, error: storageError(e) }
          }
        },
        /** Firebase download URLs are token URLs; access is still checked when the token is issued. */
        async createSignedUrl(path: string, _expiresIn: number, _opts?: { download?: string | boolean }) {
          try {
            return { data: { signedUrl: await getDownloadURL(r(path)) }, error: null }
          } catch (e) {
            return { data: null, error: storageError(e) }
          }
        },
        async createSignedUrls(paths: string[], _expiresIn: number) {
          const data = await Promise.all(
            paths.map(async (path) => {
              try {
                return { path, signedUrl: await getDownloadURL(r(path)), error: null }
              } catch (e) {
                return { path, signedUrl: '', error: storageError(e).message }
              }
            }),
          )
          return { data, error: null }
        },
        getPublicUrl(path: string) {
          const full = `${bucket}/${path.replace(/^\/+/, '')}`
          const b = firebaseConfig.storageBucket
          return { data: { publicUrl: `https://firebasestorage.googleapis.com/v0/b/${b}/o/${encodeURIComponent(full)}?alt=media` } }
        },
        async list(prefix = '', opts: { limit?: number; sortBy?: { column: string; order: 'asc' | 'desc' } } = {}) {
          try {
            const res = await list(r(prefix), { maxResults: Math.min(opts.limit ?? 1000, 1000) })
            const items = await Promise.all(
              res.items.map(async (it) => {
                const m = await getMetadata(it)
                return {
                  name: it.name,
                  id: it.fullPath,
                  created_at: m.timeCreated,
                  updated_at: m.updated,
                  metadata: { size: m.size, mimetype: m.contentType },
                }
              }),
            )
            if (opts.sortBy) {
              const { column, order } = opts.sortBy
              items.sort((a, b) => String((a as any)[column]).localeCompare(String((b as any)[column])) * (order === 'desc' ? -1 : 1))
            }
            return { data: items, error: null }
          } catch (e) {
            return { data: null, error: storageError(e) }
          }
        },
        async remove(paths: string[]) {
          try {
            await Promise.all(paths.map((p) => deleteObject(r(p)).catch((e) => (e?.code === 'storage/object-not-found' ? null : Promise.reject(e)))))
            return { data: paths.map((name) => ({ name })), error: null }
          } catch (e) {
            return { data: null, error: storageError(e) }
          }
        },
        async download(path: string) {
          try {
            return { data: await getBlob(r(path)), error: null }
          } catch (e) {
            return { data: null, error: storageError(e) }
          }
        },
      }
    },
  }
}

// ----------------------------------------------------------------------------- callable functions

export type StorageApi = ReturnType<typeof createStorageApi>
export type FunctionsApi = ReturnType<typeof createFunctionsApi>

const FUNCTION_NAMES: Record<string, string> = { 'admin-users': 'adminUsers' }

/** Error codes a callable returns when the function is simply not deployed (no Blaze plan yet). */
export const FUNCTION_MISSING_CODES = ['functions/not-found', 'functions/internal', 'functions/unavailable']

type FirebaseDb = Pick<ReturnType<typeof createDb>, 'me' | 'from'>
type InvokeResult = { data: any; error: { message: string; code: string; context: { json: () => Promise<unknown> } } | null }
const fnError = (message: string, code = 'functions/failed-precondition'): InvokeResult => ({ data: null, error: { message, code, context: { json: async () => ({ error: message }) } } })

/**
 * "Invite user" without Cloud Functions (Spark plan). The account is created through a second, in-memory
 * Firebase app instance, so the administrator stays signed in. Signed in as the new account, that instance
 * creates the account's own profile exactly as a self sign-up would (inactive Employee — the only thing
 * firestore.rules allow), then the administrator assigns the role and activates it under their own rules
 * (users.manage; only a Super Administrator may grant Super Administrator). The new user sets their
 * password through the reset email the Invite dialog sends next.
 */
export async function inviteWithoutFunctions(db: FirebaseDb, body: Record<string, unknown>): Promise<InvokeResult> {
  const email = String(body.email ?? '').trim().toLowerCase()
  const fullName = String(body.full_name ?? '').trim().slice(0, 200)
  const roleKey = String(body.role_key ?? 'employee').trim()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fnError('Invalid email')
  if (fullName.length < 2) return fnError('Full name is required')
  const me = await db.me()
  if (!me?.can('users.manage')) return fnError('You do not have permission to manage users')
  if (roleKey === 'super_admin' && me.roleKey !== 'super_admin') return fnError('Only a Super Administrator can invite a Super Administrator')
  const role = await db.from('roles').select('id').eq('id', roleKey).maybeSingle()
  if (role.error || !role.data) return fnError('Unknown role')

  const existing = await db.from('profiles').select('id').eq('email', email).maybeSingle()
  if (existing.error) return fnError(existing.error.message)
  let uid = (existing.data as { id: string } | null)?.id
  if (!uid) {
    const second = initializeApp(firebaseConfig, `abckit-invite-${crypto.randomUUID()}`)
    try {
      const secondAuth = initializeAuth(second, { persistence: inMemoryPersistence })
      const secondFs = initializeFirestore(second, { ignoreUndefinedProperties: true })
      if (useEmulators) {
        connectAuthEmulator(secondAuth, 'http://127.0.0.1:9099', { disableWarnings: true })
        connectFirestoreEmulator(secondFs, '127.0.0.1', 8080)
      }
      const tempPassword = `${crypto.randomUUID()}A1`
      let user: User
      try {
        user = (await createUserWithEmailAndPassword(secondAuth, email, tempPassword)).user
      } catch (e) {
        if ((e as { code?: string })?.code === 'auth/email-already-in-use')
          return fnError(`${email} already has a sign-in account but has never opened ABCkit. Ask them to sign in once (or use “Forgot password”), then activate them here.`, 'functions/already-exists')
        return fnError(toAuthError(e).message, (e as { code?: string })?.code ?? 'auth/error')
      }
      await updateProfile(user, { displayName: fullName }).catch(() => undefined)
      await ensureProfile(new FirestoreStore(secondFs), { uid: user.uid, email, displayName: fullName })
      await signOut(secondAuth)
      uid = user.uid
    } catch (e) {
      return fnError(`Could not create the account: ${(e as Error)?.message ?? e}`, 'functions/internal-fallback')
    } finally {
      await deleteApp(second).catch(() => undefined)
    }
  }

  const upd = await db.from('profiles').update({ role_id: roleKey, is_active: true, full_name: fullName }).eq('id', uid)
  if (upd.error) return fnError(`Account created, but the role could not be set: ${upd.error.message}`)
  return { data: { ok: true, user_id: uid, needs_password_email: true, without_functions: true }, error: null }
}

function createFunctionsApi(getDb: () => FirebaseDb) {
  return {
    async invoke(name: string, opts: { body?: unknown } = {}): Promise<InvokeResult> {
      try {
        // AI / email jobs can run for minutes (model calls, mailbox sync); server limit is 540 s
        const fn = httpsCallable(functions, FUNCTION_NAMES[name] ?? name, { timeout: 540_000 })
        const res = await fn(opts.body ?? {})
        return { data: res.data as any, error: null }
      } catch (e) {
        const code = (e as { code?: string })?.code ?? ''
        const missing = FUNCTION_MISSING_CODES.includes(code)
        const body = (opts.body ?? {}) as Record<string, unknown>
        // Spark plan: user invitations still work from the browser (see inviteWithoutFunctions)
        if (missing && name === 'admin-users' && body.action === 'invite') return inviteWithoutFunctions(getDb(), body)
        const message = missing
          ? 'This action needs ABCkit’s server functions, which are not set up yet (Firebase Blaze plan + deploy).'
          : ((e as Error)?.message ?? 'Function call failed')
        return fnError(message, code)
      }
    },
  }
}

// ----------------------------------------------------------------------------- the db client

/** Production backend: Firestore + Firebase Auth + Storage + Cloud Functions. */
export function createFirebaseDb() {
  initFirebase()
  const store = new FirestoreStore(fs)
  const db = createDb({
    store,
    currentUser: () => {
      const u = auth.currentUser
      return u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null
    },
    auth: createAuthApi({
      async onUser(u) {
        db.invalidateMe()
        if (!u) return
        await ensureProfile(store, { uid: u.uid, email: u.email, displayName: u.displayName })
        db.invalidateMe()
      },
      async lookupUsername(name) {
        try {
          const row = await store.get('usernames', name)
          return (row?.email as string) ?? null
        } catch {
          return null
        }
      },
      async revokeAllSessions() {
        const { error } = await db.rpc('revoke_sessions')
        if (error) throw Object.assign(new Error(error.message), { code: error.code })
      },
    }),
    storage: createStorageApi(),
    functions: createFunctionsApi((): FirebaseDb => db),
  })
  return db
}
