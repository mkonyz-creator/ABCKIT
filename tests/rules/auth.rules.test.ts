/**
 * Authentication & core security rules, end-to-end against the Firestore emulator with the real
 * firestore.rules and the real engine/FirestoreStore. Run: npm run test:rules (needs Java 21+).
 */
import { initializeApp } from 'firebase/app'
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, setDoc, updateDoc, type Firestore } from 'firebase/firestore'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@/backend/client'
import { FirestoreStore } from '@/backend/firestoreStore'
import { ensureProfile } from '@/backend/session'

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-abckit'
const HOST = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')
const PORT = Number(HOST[1])
const nowSec = () => Math.floor(Date.now() / 1000)
let n = 0

/** a Firestore client signed in as `uid` with a token issued at `authTime` (seconds) */
function client(uid: string | null, authTime = nowSec()) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake' }, `app-${++n}`)
  const fs = getFirestore(app)
  connectFirestoreEmulator(fs, HOST[0], PORT, uid ? { mockUserToken: { sub: uid, user_id: uid, email: `${uid}@t.local`, auth_time: authTime } as any } : undefined)
  const store = new FirestoreStore(fs)
  const db = createDb({ store, currentUser: () => (uid ? { uid, email: `${uid}@t.local` } : null) })
  return { fs, store, db }
}

async function denied(p: Promise<unknown>) {
  let err: any = null
  try {
    await p
  } catch (e) {
    err = e
  }
  expect(err, 'expected the write/read to be denied').not.toBeNull()
  expect(String(err?.code ?? err?.message)).toMatch(/permission-denied|42501|Permission denied/i)
}

const ok = <T,>(r: { data: T; error: any }) => {
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}

beforeAll(async () => {
  await fetch(`http://${HOST[0]}:${PORT}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
})

describe('first-run bootstrap and account creation', () => {
  it('the very first user becomes the active Super Administrator and seeds roles/settings', async () => {
    const { store } = client('first')
    const p = await ensureProfile(store, { uid: 'first', email: 'first@t.local', displayName: 'First Admin' })
    expect(p).toMatchObject({ role_id: 'super_admin', is_active: true })
    const { fs } = client('first')
    expect((await getDoc(doc(fs, 'roles', 'super_admin'))).exists()).toBe(true)
    expect((await getDoc(doc(fs, 'roles', 'administrator'))).exists()).toBe(true)
    expect((await getDocs(collection(fs, 'material_categories'))).size).toBe(12)
  })

  it('later users get an inactive Employee profile, and cannot grant themselves more', async () => {
    const { store, fs } = client('second')
    const p = await ensureProfile(store, { uid: 'second', email: 'second@t.local' })
    expect(p).toMatchObject({ role_id: 'employee', is_active: false })
    // a third user cannot self-create an active admin profile
    const third = client('third')
    await denied(setDoc(doc(third.fs, 'profiles', 'third'), { id: 'third', email: 'third@t.local', role_id: 'super_admin', is_active: true }))
    // a pending (inactive) user can read their own profile but no business data or staff directory
    expect((await getDoc(doc(fs, 'profiles', 'second'))).exists()).toBe(true)
    await denied(getDocs(collection(fs, 'projects')))
    await denied(getDoc(doc(fs, 'profiles', 'first')))
    // and cannot activate themselves
    await denied(updateDoc(doc(fs, 'profiles', 'second'), { is_active: true }))
  })

  it('an administrator activates the account; the user still cannot escalate their role', async () => {
    const admin = client('first')
    ok(await admin.db.from('profiles').update({ is_active: true, role_id: 'site_engineer' }).eq('id', 'second'))
    const user = client('second')
    await denied(updateDoc(doc(user.fs, 'profiles', 'second'), { role_id: 'super_admin' }))
    const r = await user.db.from('profiles').update({ role_id: 'managing_director' }).eq('id', 'second')
    expect(r.error?.code).toBe('42501')
    // allowed self-service fields
    ok(await user.db.from('profiles').update({ phone: '+255 700 000 000' }).eq('id', 'second'))
  })
})

describe('session lifetime and revocation (server-side)', () => {
  it('rejects tokens from a sign-in older than 30 days', async () => {
    const stale = client('first', nowSec() - 31 * 24 * 3600)
    await denied(getDocs(collection(stale.fs, 'roles')))
    const fresh = client('first')
    expect((await getDocs(collection(fresh.fs, 'roles'))).size).toBeGreaterThan(0)
  })

  it('"sign out of all devices" invalidates every session issued before it', async () => {
    const before = client('second', nowSec() - 60)
    expect((await getDocs(collection(before.fs, 'roles'))).size).toBeGreaterThan(0)
    // revocation must use the server clock: a client-chosen timestamp is refused
    await denied(setDoc(doc(before.fs, 'session_revocations', 'second'), { user_id: 'second', at: '2000-01-01T00:00:00.000Z' }))
    ok(await before.db.rpc('revoke_sessions'))
    // the old session is now locked out of everything that needs an active account
    await denied(getDocs(collection(before.fs, 'roles')))
    // a new sign-in (later auth_time) works again
    const after = client('second', nowSec() + 5)
    expect((await getDocs(collection(after.fs, 'roles'))).size).toBeGreaterThan(0)
  })

  it('signed-out (anonymous) clients cannot read anything except a username lookup', async () => {
    const anon = client(null)
    await denied(getDocs(collection(anon.fs, 'profiles')))
    await denied(getDoc(doc(anon.fs, 'company_settings', '1')))
    await denied(getDocs(collection(anon.fs, 'projects')))
  })
})

describe('usernames (sign in with username)', () => {
  it('maps a username to the account email; lookups are single-document only', async () => {
    const user = client('second', nowSec() + 10)
    ok(await user.db.from('profiles').update({ username: 'eng.second' }).eq('id', 'second'))
    const anon = client(null)
    const snap = await getDoc(doc(anon.fs, 'usernames', 'eng.second'))
    expect(snap.data()).toMatchObject({ user_id: 'second', email: 'second@t.local' })
    await denied(getDocs(collection(anon.fs, 'usernames'))) // no listing of all usernames/emails
  })

  it('cannot point a username at someone else or at a different email', async () => {
    const user = client('second', nowSec() + 10)
    await denied(setDoc(doc(user.fs, 'usernames', 'boss'), { username: 'boss', user_id: 'first', email: 'first@t.local' }))
    await denied(setDoc(doc(user.fs, 'usernames', 'me2'), { username: 'me2', user_id: 'second', email: 'attacker@evil.test' }))
  })
})

describe('notifications and audit log', () => {
  it('users only see their own notifications; audit entries cannot be forged or read without audit.view', async () => {
    const admin = client('first')
    ok(await admin.db.from('notifications').insert({ user_id: 'first', title: 'For admin only' }))
    const user = client('second', nowSec() + 10)
    const mine = ok(await user.db.from('notifications').select('*'))
    expect(mine.every((x: any) => x.user_id === 'second')).toBe(true)
    await denied(getDocs(collection(user.fs, 'notifications')))
    await denied(setDoc(doc(user.fs, 'audit_logs', 'fake'), { id: 'fake', table_name: 'x', action: 'INSERT', changed_by: 'first', changed_at: 'now' }))
    await denied(getDocs(collection(user.fs, 'audit_logs')))
    expect((await getDocs(collection(admin.fs, 'audit_logs'))).size).toBeGreaterThan(0)
  })
})
