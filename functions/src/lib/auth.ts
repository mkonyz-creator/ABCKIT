/**
 * Caller authorisation for the AI callables — same model as adminUsers and firestore.rules:
 * profiles/{uid} must exist and be active; profiles.role_id → roles/{role_id}; roles.perms holds permission keys;
 * the role key 'super_admin' holds every permission.
 */
import { HttpsError } from 'firebase-functions/v2/https'
import { AI_COLLECTIONS, grantedPerms, USER_GRANTABLE_PERMS } from '../shared/ai/contract.js'
import type { Db, Row } from './admin.js'

export const SUPER_ADMIN = 'super_admin'

export interface AiCaller {
  uid: string
  name: string
  email: string | null
  roleKey: string | null
  isSuper: boolean
  perms: string[]
  can(perm: string): boolean
}

export function roleHas(role: Row | undefined | null, perm: string): boolean {
  if (!role) return false
  if (role.key === SUPER_ADMIN || role.id === SUPER_ADMIN) return true
  return Array.isArray(role.perms) && role.perms.includes(perm)
}

/** Loads the caller and requires at least one of `anyOf` (empty list = any active user). */
export async function requireCaller(db: Db, uid: string | undefined | null, anyOf: string[]): Promise<AiCaller> {
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in')
  const profile = (await db.doc(`profiles/${uid}`).get()).data()
  if (!profile || profile.is_active !== true) throw new HttpsError('permission-denied', 'Your account is not active')
  const [roleSnap, accessSnap] = await Promise.all([
    profile.role_id ? db.doc(`roles/${String(profile.role_id)}`).get() : Promise.resolve(null),
    db.doc(`${AI_COLLECTIONS.userAccess}/${uid}`).get(),
  ])
  const role = roleSnap?.data()
  const roleKey = (role?.key as string | undefined) ?? null
  // role permissions + the AI permissions granted to this user individually (User Management → Email access)
  const perms = [...new Set([...(Array.isArray(role?.perms) ? (role!.perms as string[]) : []), ...grantedPerms(accessSnap.data())])]
  const isSuper = roleKey === SUPER_ADMIN
  const can = (p: string) => isSuper || perms.includes(p)
  if (anyOf.length && !anyOf.some(can)) throw new HttpsError('permission-denied', `You do not have permission for this action (${anyOf.join(' or ')})`)
  return {
    uid,
    name: String(profile.full_name ?? profile.email ?? 'User'),
    email: (profile.email as string | undefined) ?? null,
    roleKey,
    isSuper,
    perms,
    can,
  }
}

/** Active users holding `perm` (via role perms, super_admin, or an individual grant) — notification recipients. */
export async function usersWithPerm(db: Db, perm: string): Promise<string[]> {
  const grantable = (USER_GRANTABLE_PERMS as readonly string[]).includes(perm)
  const [roles, profiles, grants] = await Promise.all([
    db.collection('roles').get(),
    db.collection('profiles').where('is_active', '==', true).get(),
    grantable ? db.collection(AI_COLLECTIONS.userAccess).get() : Promise.resolve(null),
  ])
  const ok = new Set<string>()
  for (const r of roles.docs) {
    const data = { id: r.id, ...r.data() }
    if (roleHas(data, perm)) ok.add(r.id)
  }
  const granted = new Set((grants?.docs ?? []).filter((g) => (grantedPerms(g.data()) as string[]).includes(perm)).map((g) => g.id))
  return profiles.docs.filter((p) => ok.has(String(p.data().role_id ?? '')) || granted.has(p.id)).map((p) => p.id)
}
