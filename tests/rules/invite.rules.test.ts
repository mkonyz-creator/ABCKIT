/**
 * "Invite user" without Cloud Functions (Spark plan): the real inviteWithoutFunctions() against the Auth +
 * Firestore emulators and the real firestore.rules. Run with npm run test:rules.
 * Safety: refuses to run unless the app is configured for the emulators with a demo-* project id.
 */
import { initializeApp } from 'firebase/app'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@/backend/client'
import { FirestoreStore } from '@/backend/firestoreStore'
import { ensureProfile } from '@/backend/session'

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-abckit'
const HOST = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')
const PORT = Number(HOST[1])
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'
let n = 0

function client(uid: string) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake' }, `inv-${++n}`)
  const fs = getFirestore(app)
  connectFirestoreEmulator(fs, HOST[0], PORT, { mockUserToken: { sub: uid, user_id: uid, email: `${uid}@t.local`, auth_time: Math.floor(Date.now() / 1000) } as any })
  const store = new FirestoreStore(fs)
  const db = createDb({ store, currentUser: () => ({ uid, email: `${uid}@t.local` }) })
  return { store, db }
}

let invite: typeof import('@/backend/firebase').inviteWithoutFunctions

beforeAll(async () => {
  const env = import.meta.env
  if (env.VITE_USE_EMULATORS !== 'true' || !String(env.VITE_FIREBASE_PROJECT_ID).startsWith('demo-'))
    throw new Error('invite.rules.test must run against the emulators (VITE_USE_EMULATORS=true, demo-* project) — see package.json test:rules')
  invite = (await import('@/backend/firebase')).inviteWithoutFunctions
  await fetch(`http://${HOST[0]}:${PORT}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' })
  // first user = Super Administrator (bootstrap)
  const boss = client('boss')
  await ensureProfile(boss.store, { uid: 'boss', email: 'boss@t.local', displayName: 'Boss' })
})

describe('invite user without Cloud Functions', () => {
  it('creates the sign-in account and an active profile with the chosen role; the admin stays signed in', async () => {
    const admin = client('boss')
    const res = await invite(admin.db, { email: 'New.Person@T.local', full_name: 'New Person', role_key: 'accountant' })
    expect(res.error).toBeNull()
    expect(res.data).toMatchObject({ ok: true, needs_password_email: true })
    const uid = res.data.user_id as string
    expect(uid).toBeTruthy()
    const { data: p } = await admin.db.from('profiles').select('*').eq('id', uid).single()
    expect(p).toMatchObject({ email: 'new.person@t.local', full_name: 'New Person', role_id: 'accountant', is_active: true })

    // the account really exists in Firebase Auth (emulator)
    const lookup = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=fake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: [uid] }),
    }).then((r) => r.json())
    expect(lookup.users?.[0]?.email).toBe('new.person@t.local')

    // inviting the same email again updates the existing profile (no second account)
    const again = await invite(admin.db, { email: 'new.person@t.local', full_name: 'New Person', role_key: 'storekeeper' })
    expect(again.data?.user_id).toBe(uid)
    const { data: p2 } = await admin.db.from('profiles').select('role_id').eq('id', uid).single()
    expect(p2?.role_id).toBe('storekeeper')
  })

  it('refuses callers without users.manage, and non-super admins granting Super Administrator', async () => {
    const admin = client('boss')
    // an active Administrator (users.manage, not super) and an active accountant
    for (const [uid, role] of [['sysadmin', 'administrator'], ['acc', 'accountant']] as const) {
      const c = client(uid)
      await ensureProfile(c.store, { uid, email: `${uid}@t.local`, displayName: uid })
      await admin.db.from('profiles').update({ role_id: role, is_active: true }).eq('id', uid)
    }
    const acc = await invite(client('acc').db, { email: 'x1@t.local', full_name: 'X One', role_key: 'employee' })
    expect(acc.error?.message).toMatch(/permission/)
    const sys = await invite(client('sysadmin').db, { email: 'x2@t.local', full_name: 'X Two', role_key: 'super_admin' })
    expect(sys.error?.message).toMatch(/Only a Super Administrator/)
    const okSys = await invite(client('sysadmin').db, { email: 'x3@t.local', full_name: 'X Three', role_key: 'site_supervisor' })
    expect(okSys.error).toBeNull()
  })

  it('explains what to do when the email already has a sign-in account but no ABCkit profile', async () => {
    await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'orphan@t.local', password: 'Orphan12345', returnSecureToken: true }),
    })
    const res = await invite(client('boss').db, { email: 'orphan@t.local', full_name: 'Orphan User', role_key: 'employee' })
    expect(res.error?.message).toMatch(/already has a sign-in account/)
  })

  it('validates input', async () => {
    const admin = client('boss').db
    expect((await invite(admin, { email: 'bad', full_name: 'A B', role_key: 'employee' })).error?.message).toMatch(/Invalid email/)
    expect((await invite(admin, { email: 'a@t.local', full_name: 'A', role_key: 'employee' })).error?.message).toMatch(/Full name/)
    expect((await invite(admin, { email: 'a@t.local', full_name: 'A B', role_key: 'no_such_role' })).error?.message).toMatch(/Unknown role/)
  })
})
