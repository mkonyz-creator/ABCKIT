/**
 * Who is calling: profile, role, permissions and accessible projects (cached per user).
 * Also bootstraps a brand-new Firebase project: the very first user to sign in seeds the
 * roles / permission matrix / settings / numbering and becomes the active Super Administrator.
 * Later users get an inactive "employee" profile until an administrator activates them.
 */
import { AI_COLLECTIONS, grantedPerms } from '../shared/ai/contract'
import type { Me, Row } from './registry'
import { EXTRA_GRANTS, EXTRA_PERMISSIONS, EXTRA_ROLES } from './seed.extra'
import { SEED } from './seed.generated'
import { TABLES } from './schema.generated'
import { isPermissionDenied, type Store } from './store'

export interface AuthUser {
  uid: string
  email: string | null
  displayName?: string | null
}

const ALL_PERMS = [...SEED.permissions.map((p) => p.key), ...EXTRA_PERMISSIONS.map((p) => p.key)]

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p
  } catch (e) {
    if (isPermissionDenied(e)) return fallback
    throw e
  }
}

export async function loadMe(store: Store, user: AuthUser): Promise<Me> {
  const profile = await safe(store.get('profiles', user.uid), null)
  const [role, access] = await Promise.all([
    profile?.role_id ? safe(store.get('roles', String(profile.role_id)), null) : Promise.resolve(null),
    // AI / email permissions granted to this user individually (User Management → Email access)
    profile?.is_active ? safe(store.get(AI_COLLECTIONS.userAccess, user.uid), null) : Promise.resolve(null),
  ])
  const active = !!profile?.is_active
  const roleKey: string | null = role?.key ?? null
  const isSuper = active && roleKey === 'super_admin'
  const perms = new Set<string>(!active ? [] : isSuper ? ALL_PERMS : [...((role?.perms as string[]) ?? []), ...grantedPerms(access)])
  const viewAll = isSuper || perms.has('projects.view_all')
  let projectIds: string[] = []
  if (active && !viewAll) {
    const [members, managed, created] = await Promise.all([
      safe(store.query('project_members', [{ field: 'user_id', value: user.uid }]), [] as Row[]),
      safe(store.query('projects', [{ field: 'project_manager_id', value: user.uid }]), [] as Row[]),
      safe(store.query('projects', [{ field: 'created_by', value: user.uid }]), [] as Row[]),
    ])
    projectIds = [...new Set([...members.map((m) => m.project_id), ...managed.map((p) => p.id), ...created.map((p) => p.id)])]
  }
  return {
    uid: user.uid,
    email: user.email,
    profile,
    roleKey,
    active,
    perms,
    viewAll,
    projectIds,
    can: (perm) => isSuper || perms.has(perm),
  }
}

/** Tables whose changes alter what the current user may see. */
export const ACCESS_TABLES = new Set(['profiles', 'roles', 'role_permissions', 'project_members', 'projects', AI_COLLECTIONS.userAccess])

export function createMeCache(store: Store, currentUser: () => AuthUser | null) {
  let cache: { uid: string; p: Promise<Me> } | null = null
  return {
    get(): Promise<Me | null> {
      const u = currentUser()
      if (!u) return Promise.resolve(null)
      if (cache?.uid !== u.uid) {
        const p = loadMe(store, u)
        cache = { uid: u.uid, p }
        // an inactive result is not kept: it is also what a failed / refused profile read looks like (e.g. a token
        // refresh failing for a moment), and keeping it would lock an active user out until a reload.
        // Activation by an administrator is picked up on the next call too.
        p.then(
          (me) => {
            if (!me.active && cache?.p === p) cache = null
          },
          () => {
            if (cache?.p === p) cache = null
          },
        )
      }
      return cache.p
    },
    invalidate() {
      cache = null
    },
  }
}

// ----------------------------------------------------------------------------- bootstrap

function columnDefaults(table: string): Row {
  const row: Row = {}
  for (const [col, c] of Object.entries(TABLES[table].columns)) {
    if (c.default?.kind === 'value') row[col] = JSON.parse(JSON.stringify(c.default.value))
    else if (!c.generated) row[col] = null
  }
  return row
}

export function seedDocuments(now: string) {
  const docs: Array<[string, string, Row]> = []
  const grants = new Map<string, string[]>()
  const matrix: Array<readonly [string, string]> = [...SEED.matrix, ...EXTRA_GRANTS.filter(([r]) => SEED.roles.some((x) => x.key === r))]
  for (const [role, perm] of matrix) grants.set(role, [...(grants.get(role) ?? []), perm])
  for (const r of SEED.roles)
    docs.push(['roles', r.key, { id: r.key, key: r.key, name: r.name, description: r.description, is_system: r.is_system, perms: grants.get(r.key) ?? [], created_at: now }])
  for (const p of [...SEED.permissions, ...EXTRA_PERMISSIONS]) docs.push(['permissions', p.key, { id: p.key, key: p.key, module: p.module, description: p.description }])
  for (const r of EXTRA_ROLES) {
    const perms = [...r.perms, ...EXTRA_GRANTS.filter(([role]) => role === r.key).map(([, p]) => p)]
    docs.push(['roles', r.key, { id: r.key, key: r.key, name: r.name, description: r.description, is_system: true, perms, created_at: now }])
    for (const perm of perms) docs.push(['role_permissions', `${r.key}__${perm}`, { role_id: r.key, permission_id: perm }])
  }
  for (const [role, perm] of matrix)
    docs.push(['role_permissions', `${role}__${perm}`, { role_id: role, permission_id: perm }])
  SEED.materialCategories.forEach((name, i) => {
    const id = `cat-${String(i + 1).padStart(2, '0')}`
    docs.push(['material_categories', id, { id, name }])
  })
  docs.push(['company_settings', '1', { ...columnDefaults('company_settings'), id: 1, updated_at: now }])
  for (const n of SEED.numbering)
    docs.push(['numbering_sequences', n.key, { ...columnDefaults('numbering_sequences'), key: n.key, label: n.label, prefix: n.prefix }])
  return docs
}

/**
 * Make sure the signed-in user has a profile. Returns the profile row.
 * Firestore rules allow: (a) the very first user to create the seed + an active super_admin profile,
 * guarded by meta/bootstrap; (b) anyone else to create only their own inactive employee profile.
 */
export async function ensureProfile(store: Store, user: AuthUser): Promise<Row | null> {
  const existing = await safe(store.get('profiles', user.uid), null)
  if (existing) return existing
  const now = new Date().toISOString()
  const fullName = user.displayName?.trim() || (user.email ?? '').split('@')[0]
  const base = {
    ...columnDefaults('profiles'),
    id: user.uid,
    email: user.email ?? '',
    full_name: fullName,
    created_at: now,
    updated_at: now,
  }
  return store.transaction(async (tx) => {
    const boot = await tx.get('meta', 'bootstrap')
    const again = await tx.get('profiles', user.uid)
    if (again) return again
    if (!boot) {
      for (const [t, id, row] of seedDocuments(now)) tx.set(t, id, row)
      tx.set('meta', 'bootstrap', { owner: user.uid, at: now })
      const profile = { ...base, role_id: 'super_admin', is_active: true }
      tx.set('profiles', user.uid, profile)
      return profile
    }
    const profile = { ...base, role_id: 'employee', is_active: false }
    tx.set('profiles', user.uid, profile)
    return profile
  })
}
