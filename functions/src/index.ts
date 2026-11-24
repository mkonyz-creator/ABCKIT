/**
 * ABCkit Cloud Functions.
 *
 * adminUsers — privileged user administration (replaces the Supabase edge function legacy-supabase/functions/admin-users).
 * The client calls it through db.functions.invoke('admin-users', { body }) (see src/backend/firebase.ts).
 *
 * Actions (caller must be signed in, have an active profile and hold `users.manage` or be a Super Administrator):
 *   { action: 'invite', email, full_name, role_key, redirect_to }
 *       → creates (or reuses) the Firebase Auth user and an ACTIVE profile with the chosen role.
 *         The client then sends the "set your password" email (sendPasswordResetEmail), so this returns
 *         { ok: true, user_id, needs_password_email: true }.
 *   { action: 'set_active', user_id, active }
 *       → flips profiles/{uid}.is_active and disables/enables the Auth user; deactivation also revokes
 *         refresh tokens so existing sessions stop refreshing.
 *   { action: 'set_password', user_id, password, sign_out? }
 *       → sets a new password for another user (policy: ≥ 10 chars, letters + digits). Only a Super Administrator
 *         may change a Super Administrator's password. Unless sign_out === false, all their sessions are ended.
 *         The password is never stored or logged; the audit log records only that it changed.
 *   { action: 'set_access', user_id, perms }
 *       → grants AI / email permissions (ai.view, ai.email, ai.email_send, ai.manage) to one user on top of their
 *         role, in user_access/{uid}. [] removes the grant. Not for yourself or a Super Administrator. Audited.
 *
 * ABCkit AI Intelligence (chat/report proxy, email accounts, sync, analysis, replies, monitoring) lives in
 * ./aiFunctions.ts and is re-exported below — see functions/AI_SETUP.md for the credentials it needs.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getAuth, type UserRecord } from 'firebase-admin/auth'
import { FieldValue, getFirestore, type Transaction } from 'firebase-admin/firestore'
import { logger, setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { AI_COLLECTIONS, grantedPerms, normalizeUserGrant, USER_GRANTABLE_PERMS } from './shared/ai/contract.js'

initializeApp()
setGlobalOptions({ region: process.env.FUNCTIONS_REGION || 'us-central1', maxInstances: 10 })

export * from './aiFunctions.js'

const db = getFirestore()
const auth = getAuth()

type Row = Record<string, unknown>

interface Caller {
  uid: string
  roleKey: string | null
  isSuper: boolean
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const SUPER = 'super_admin'

// ----------------------------------------------------------------------------- helpers

async function loadCaller(req: CallableRequest): Promise<Caller> {
  const uid = req.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in')
  const profile = (await db.doc(`profiles/${uid}`).get()).data()
  if (!profile || profile.is_active !== true) throw new HttpsError('permission-denied', 'Your account is not active')
  const role = profile.role_id ? (await db.doc(`roles/${String(profile.role_id)}`).get()).data() : undefined
  const roleKey = (role?.key as string | undefined) ?? null
  const perms = Array.isArray(role?.perms) ? (role!.perms as string[]) : []
  const isSuper = roleKey === SUPER
  if (!isSuper && !perms.includes('users.manage')) throw new HttpsError('permission-denied', 'You do not have permission to manage users')
  return { uid, roleKey, isSuper }
}

function auditLog(tx: Transaction, callerUid: string, action: 'INSERT' | 'UPDATE', recordId: string, oldData: Row | null, newData: Row, now: string) {
  const id = randomUUID()
  tx.set(db.doc(`audit_logs/${id}`), {
    id,
    table_name: 'profiles',
    record_id: recordId,
    action,
    old_data: oldData,
    new_data: newData,
    changed_by: callerUid,
    changed_at: now,
  })
}

/** Throws if `uid` is the only active Super Administrator (read inside the transaction). */
async function ensureAnotherSuperAdmin(tx: Transaction, uid: string) {
  const supers = await tx.get(db.collection('profiles').where('role_id', '==', SUPER).where('is_active', '==', true))
  if (supers.docs.filter((d) => d.id !== uid).length < 1)
    throw new HttpsError('failed-precondition', 'At least one active Super Administrator is required')
}

const isAuthError = (e: unknown, code: string) => (e as { code?: string })?.code === code || (e as { errorInfo?: { code?: string } })?.errorInfo?.code === code

function authMessage(e: unknown) {
  const code = (e as { code?: string })?.code ?? ''
  if (code === 'auth/invalid-email') return 'Invalid email'
  if (code === 'auth/email-already-exists') return 'A user with this email already exists'
  return (e as Error)?.message ?? 'Authentication service error'
}

// ----------------------------------------------------------------------------- actions

async function invite(caller: Caller, body: Row) {
  const email = String(body.email ?? '').trim().toLowerCase()
  const fullName = String(body.full_name ?? '').trim().slice(0, 200)
  const roleKey = String(body.role_key ?? 'employee').trim()
  if (!EMAIL_RE.test(email)) throw new HttpsError('invalid-argument', 'Invalid email')
  if (fullName.length < 2) throw new HttpsError('invalid-argument', 'Full name is required')
  if (!/^[a-z_]+$/.test(roleKey)) throw new HttpsError('invalid-argument', 'Unknown role')
  // role documents are keyed by the role key
  const role = await db.doc(`roles/${roleKey}`).get()
  if (!role.exists) throw new HttpsError('invalid-argument', 'Unknown role')
  if (roleKey === SUPER && !caller.isSuper)
    throw new HttpsError('permission-denied', 'Only a Super Administrator can invite a Super Administrator')

  // create the Auth user with a random password (they set their own through the password email), or reuse it
  let user: UserRecord
  let created = false
  try {
    user = await auth.getUserByEmail(email)
  } catch (e) {
    if (!isAuthError(e, 'auth/user-not-found')) throw new HttpsError('unknown', authMessage(e))
    try {
      user = await auth.createUser({ email, password: randomBytes(24).toString('base64url'), displayName: fullName, emailVerified: false, disabled: false })
      created = true
    } catch (err) {
      throw new HttpsError(isAuthError(err, 'auth/invalid-email') ? 'invalid-argument' : isAuthError(err, 'auth/email-already-exists') ? 'already-exists' : 'unknown', authMessage(err))
    }
  }

  const uid = user.uid
  const now = new Date().toISOString()
  try {
    await db.runTransaction(async (tx) => {
      const ref = db.doc(`profiles/${uid}`)
      const snap = await tx.get(ref)
      const old = snap.exists ? (snap.data() as Row) : null
      if (old?.role_id === SUPER) {
        if (!caller.isSuper) throw new HttpsError('permission-denied', 'Only a Super Administrator can change a Super Administrator account')
        if (roleKey !== SUPER && old.is_active === true) await ensureAnotherSuperAdmin(tx, uid)
      }
      const profile: Row = {
        id: uid,
        email,
        full_name: fullName,
        phone: old?.phone ?? null,
        job_title: old?.job_title ?? null,
        avatar_url: old?.avatar_url ?? null,
        role_id: roleKey,
        is_active: true,
        last_seen_at: old?.last_seen_at ?? null,
        created_at: (old?.created_at as string | undefined) ?? now,
        updated_at: now,
      }
      tx.set(ref, profile)
      auditLog(tx, caller.uid, old ? 'UPDATE' : 'INSERT', uid, old, profile, now)
    })
  } catch (e) {
    // do not leave a fresh Auth account behind without a profile
    if (created) await auth.deleteUser(uid).catch((err) => logger.warn('adminUsers: cleanup of new auth user failed', err))
    throw e
  }

  if (!created) {
    // re-inviting a known account: make sure it can sign in again
    const patch: { disabled?: boolean; displayName?: string } = {}
    if (user.disabled) patch.disabled = false
    if (!user.displayName) patch.displayName = fullName
    if (Object.keys(patch).length) await auth.updateUser(uid, patch)
  }

  logger.info('adminUsers.invite', { by: caller.uid, uid, role: roleKey, created })
  return { ok: true, user_id: uid, needs_password_email: true }
}

async function setActive(caller: Caller, body: Row) {
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  if (!userId || userId.includes('/')) throw new HttpsError('invalid-argument', 'user_id is required')
  if (typeof body.active !== 'boolean') throw new HttpsError('invalid-argument', 'active must be true or false')
  const active = body.active
  if (userId === caller.uid && !active) throw new HttpsError('failed-precondition', 'You cannot deactivate your own account')

  const now = new Date().toISOString()
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`profiles/${userId}`)
    const snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'User profile not found')
    const old = snap.data() as Row
    if (old.role_id === SUPER && !caller.isSuper)
      throw new HttpsError('permission-denied', 'Only a Super Administrator can activate or deactivate a Super Administrator')
    if (!active && old.role_id === SUPER && old.is_active === true) await ensureAnotherSuperAdmin(tx, userId)
    if (old.is_active === active) return
    const next = { ...old, is_active: active, updated_at: now }
    tx.set(ref, next)
    auditLog(tx, caller.uid, 'UPDATE', userId, old, next, now)
  })

  try {
    await auth.updateUser(userId, { disabled: !active })
    if (!active) await auth.revokeRefreshTokens(userId)
  } catch (e) {
    // a profile without an Auth account (e.g. imported data) — the profile flag alone still blocks all access
    if (!isAuthError(e, 'auth/user-not-found')) {
      logger.error('adminUsers.set_active: auth update failed', e)
      throw new HttpsError('aborted', `Profile updated, but the sign-in account could not be ${active ? 'enabled' : 'disabled'}: ${authMessage(e)}`)
    }
  }

  logger.info('adminUsers.set_active', { by: caller.uid, uid: userId, active })
  return { ok: true }
}

/** Same policy as the web app (src/pages/auth/AuthPages.tsx passwordProblem). */
function newPasswordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters'
  if (pw.length > 128) return 'Password is too long (max 128 characters)'
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Include both letters and numbers'
  return null
}

/**
 * An administrator sets a new password for another user. The password itself is never stored or logged;
 * the audit log only records that it was changed. By default every existing session of that user is ended
 * (refresh tokens revoked + session_revocations stamp, which firestore.rules enforce immediately).
 */
async function setPassword(caller: Caller, body: Row) {
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  if (!userId || userId.includes('/')) throw new HttpsError('invalid-argument', 'user_id is required')
  const password = typeof body.password === 'string' ? body.password : ''
  const problem = newPasswordProblem(password)
  if (problem) throw new HttpsError('invalid-argument', problem)
  if (userId === caller.uid) throw new HttpsError('failed-precondition', 'Change your own password from your Profile page')
  const signOut = body.sign_out !== false

  const snap = await db.doc(`profiles/${userId}`).get()
  if (!snap.exists) throw new HttpsError('not-found', 'User profile not found')
  const profile = snap.data() as Row
  if (profile.role_id === SUPER && !caller.isSuper)
    throw new HttpsError('permission-denied', 'Only a Super Administrator can change the password of a Super Administrator')

  try {
    await auth.updateUser(userId, { password })
  } catch (e) {
    if (isAuthError(e, 'auth/user-not-found')) throw new HttpsError('not-found', 'This user has no sign-in account')
    if (isAuthError(e, 'auth/invalid-password')) throw new HttpsError('invalid-argument', 'The password was rejected as too weak')
    logger.error('adminUsers.set_password: auth update failed', e)
    throw new HttpsError('unknown', authMessage(e))
  }

  const now = new Date().toISOString()
  const id = randomUUID()
  const batch = db.batch()
  if (signOut) batch.set(db.doc(`session_revocations/${userId}`), { user_id: userId, at: FieldValue.serverTimestamp() })
  batch.set(db.doc(`audit_logs/${id}`), {
    id,
    table_name: 'profiles',
    record_id: userId,
    action: 'UPDATE',
    old_data: null,
    new_data: { password_reset_by_admin: true, sessions_ended: signOut },
    changed_by: caller.uid,
    changed_at: now,
  })
  await batch.commit()
  if (signOut) await auth.revokeRefreshTokens(userId)

  logger.info('adminUsers.set_password', { by: caller.uid, uid: userId, signOut })
  return { ok: true, sessions_ended: signOut }
}

/**
 * Grants or removes AI / email permissions for ONE user on top of their role (User Management → Email access).
 * Only USER_GRANTABLE_PERMS can be granted; an empty list removes the grant. Not for your own account (no
 * self-escalation) and not for a Super Administrator (who already holds everything). Audited with before/after.
 */
async function setAccess(caller: Caller, body: Row) {
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  if (!userId || userId.includes('/') || userId.length > 128) throw new HttpsError('invalid-argument', 'user_id is required')
  if (!Array.isArray(body.perms) || body.perms.length > 20) throw new HttpsError('invalid-argument', 'perms must be a list')
  const unknown = body.perms.filter((p) => !(USER_GRANTABLE_PERMS as readonly unknown[]).includes(p))
  if (unknown.length) throw new HttpsError('invalid-argument', `These permissions cannot be granted per user: ${unknown.map(String).join(', ').slice(0, 200)}`)
  if (userId === caller.uid) throw new HttpsError('failed-precondition', 'You cannot change your own access — ask another administrator')
  const perms = normalizeUserGrant(body.perms)

  const now = new Date().toISOString()
  await db.runTransaction(async (tx) => {
    const profileSnap = await tx.get(db.doc(`profiles/${userId}`))
    if (!profileSnap.exists) throw new HttpsError('not-found', 'User profile not found')
    if (profileSnap.data()?.role_id === SUPER) throw new HttpsError('failed-precondition', 'A Super Administrator already has every permission')
    const ref = db.doc(`${AI_COLLECTIONS.userAccess}/${userId}`)
    const snap = await tx.get(ref)
    const old = snap.exists ? (snap.data() as Row) : null
    if (JSON.stringify(grantedPerms(old)) === JSON.stringify(perms)) return
    const next: Row | null = perms.length ? { id: userId, user_id: userId, perms, updated_by: caller.uid, updated_at: now } : null
    if (next) tx.set(ref, next)
    else tx.delete(ref)
    const id = randomUUID()
    tx.set(db.doc(`audit_logs/${id}`), {
      id,
      table_name: AI_COLLECTIONS.userAccess,
      record_id: userId,
      action: !old ? 'INSERT' : next ? 'UPDATE' : 'DELETE',
      old_data: old,
      new_data: next,
      changed_by: caller.uid,
      changed_at: now,
    })
  })

  logger.info('adminUsers.set_access', { by: caller.uid, uid: userId, perms })
  return { ok: true, perms }
}

// ----------------------------------------------------------------------------- callable

export const adminUsers = onCall(async (req) => {
  const caller = await loadCaller(req)
  const body = (req.data && typeof req.data === 'object' ? req.data : {}) as Row
  try {
    switch (body.action) {
      case 'invite':
        return await invite(caller, body)
      case 'set_active':
        return await setActive(caller, body)
      case 'set_password':
        return await setPassword(caller, body)
      case 'set_access':
        return await setAccess(caller, body)
      default:
        throw new HttpsError('invalid-argument', 'Unknown action')
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e
    logger.error('adminUsers: unexpected error', e)
    throw new HttpsError('internal', 'Unexpected server error')
  }
})
