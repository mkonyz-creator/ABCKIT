/**
 * Core domain — ported from legacy-supabase/migrations/…0100_core.sql (+ core parts of …0500_roles_rls.sql):
 * roles & permissions (role doc keeps a `perms` array used by firestore.rules), profiles guard,
 * company settings, numbering, notifications, audit log, my_permissions().
 */
import { defineHooks, defineRpc, defineScope, enableAudit, extendTable, ownScope, type WriteCtx } from '../registry'
import { SERVER_TIME } from '../store'
import { SEED } from '../seed.generated'

enableAudit('profiles', 'role_permissions', 'company_settings', 'numbering_sequences')

// ---------------------------------------------------------------------------- auth extensions (Firebase era)
// profiles.username: optional sign-in name; usernames/{username} maps it to the account email for login lookup.
// session_revocations/{uid}.at: "sign out of all devices" — firestore.rules reject tokens issued before it.
// (own collection, always written with the server clock, so ordinary profile edits never touch it)
extendTable('profiles', {
  columns: { username: { type: 'text' } },
  uniques: [['username']],
})
extendTable('usernames', {
  pk: ['username'],
  columns: { username: { type: 'text', notNull: true }, user_id: { type: 'uuid', notNull: true }, email: { type: 'text', notNull: true } },
  fks: { user_id: { table: 'profiles', column: 'id', onDelete: 'cascade' } },
})
extendTable('session_revocations', {
  pk: ['user_id'],
  columns: { user_id: { type: 'uuid', notNull: true }, at: { type: 'timestamptz', notNull: true } },
  fks: { user_id: { table: 'profiles', column: 'id', onDelete: 'cascade' } },
})
defineScope('session_revocations', (me) => (me.can('users.manage') ? 'all' : [[{ field: 'user_id', value: me.uid }]]))
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/

// ---------------------------------------------------------------------------- read scopes
// Inactive users may read only their own profile; active users see the staff directory.
defineScope('profiles', (me) => (me.active ? 'all' : [[{ field: 'id', value: me.uid }]]))
defineScope('notifications', ownScope('user_id'))

// ---------------------------------------------------------------------------- roles & permissions

defineHooks('roles', {
  beforeInsert(row, ctx) {
    if (!Array.isArray(row.perms)) row.perms = []
    if (!/^[a-z_]+$/.test(String(row.key ?? ''))) ctx.fail('Role key must contain only lowercase letters and underscores', '23514')
  },
  beforeUpdate(row, old, ctx) {
    if (old.is_system && row.key !== old.key) ctx.fail('System roles cannot be renamed', '42501')
  },
  async beforeDelete(old, ctx) {
    if (old.is_system) ctx.fail('System roles cannot be deleted', '42501')
  },
})

async function permissionKey(ctx: WriteCtx, permissionId: string) {
  const p = await ctx.get('permissions', permissionId)
  return (p?.key as string) ?? permissionId
}

/** role_permissions is the editable matrix; roles/{id}.perms is its denormalised copy for security rules. */
defineHooks('role_permissions', {
  async afterInsert(row, ctx) {
    const role = await ctx.get('roles', row.role_id)
    if (!role) return ctx.fail('Role not found', '23503')
    const key = await permissionKey(ctx, row.permission_id)
    const perms = new Set<string>(role.perms ?? [])
    perms.add(key)
    await ctx.update('roles', role.id, { perms: [...perms].sort() })
  },
  async afterDelete(old, ctx) {
    const role = await ctx.get('roles', old.role_id)
    if (!role) return
    const key = await permissionKey(ctx, old.permission_id)
    await ctx.update('roles', role.id, { perms: (role.perms ?? []).filter((p: string) => p !== key) })
  },
})

// ---------------------------------------------------------------------------- profiles guard

const SELF_EDITABLE = new Set(['full_name', 'phone', 'job_title', 'avatar_url', 'last_seen_at', 'updated_at', 'username'])

function normaliseUsername(row: Record<string, any>, ctx: WriteCtx) {
  if (row.username === undefined) return
  const u = row.username == null ? '' : String(row.username).trim().toLowerCase()
  if (!u) {
    row.username = null
    return
  }
  if (u.includes('@')) ctx.fail('A username cannot contain "@"', '23514')
  if (!USERNAME_RE.test(u)) ctx.fail('Username: 3–30 characters, letters, digits, dot, dash or underscore', '23514')
  row.username = u
}

async function syncUsername(row: Record<string, any>, old: Record<string, any> | null, ctx: WriteCtx) {
  const before = old?.username ?? null
  const after = row.username ?? null
  if (before === after && (!after || old?.email === row.email)) return
  if (before && before !== after) await ctx.remove('usernames', before)
  if (after) {
    const taken = await ctx.get('usernames', after)
    if (taken && taken.user_id !== row.id) ctx.fail('That username is already taken', '23505')
    if (taken) await ctx.update('usernames', after, { email: row.email })
    else await ctx.insert('usernames', { username: after, user_id: row.id, email: row.email })
  }
}

defineHooks('profiles', {
  beforeInsert(row, ctx) {
    normaliseUsername(row, ctx)
  },
  async afterInsert(row, ctx) {
    await syncUsername(row, null, ctx)
  },
  async afterUpdate(row, old, ctx) {
    await syncUsername(row, old, ctx)
  },
  async beforeUpdate(row, old, ctx) {
    normaliseUsername(row, ctx)
    const sensitive = row.role_id !== old.role_id || row.is_active !== old.is_active || row.email !== old.email
    if (sensitive && !ctx.me.can('users.manage')) ctx.fail('Not authorised to change role, status or email', '42501')
    if (row.id === ctx.me.uid && row.is_active === false && old.is_active) ctx.fail('You cannot deactivate your own account', '42501')
    if (row.id === ctx.me.uid && !ctx.me.can('users.manage')) {
      for (const k of Object.keys(row)) if (JSON.stringify(row[k]) !== JSON.stringify(old[k]) && !SELF_EDITABLE.has(k)) ctx.fail(`You cannot change ${k}`, '42501')
    }
    // the last active super admin can never be demoted/deactivated
    if (old.role_id === 'super_admin' && old.is_active && (row.role_id !== old.role_id || !row.is_active)) {
      const supers = await ctx.select('profiles', [
        { kind: 'cmp', col: 'role_id', op: 'eq', value: 'super_admin' },
        { kind: 'cmp', col: 'is_active', op: 'eq', value: true },
      ])
      if (supers.filter((p) => p.id !== row.id).length < 1) ctx.fail('At least one active Super Administrator is required', '42501')
    }
    if (row.role_id === 'super_admin' && old.role_id !== 'super_admin' && ctx.me.roleKey !== 'super_admin')
      ctx.fail('Only a Super Administrator can grant the Super Administrator role', '42501')
  },
})

// ---------------------------------------------------------------------------- settings & numbering

defineHooks('company_settings', {
  beforeInsert(row, ctx) {
    void row
    ctx.fail('Company settings already exist; update them instead', '23505')
  },
  beforeUpdate(row, _old, ctx) {
    if (row.default_currency && !/^[A-Z]{3}$/.test(row.default_currency)) ctx.fail('Currency must be a 3-letter code', '23514')
    const m = Number(row.financial_year_start_month)
    if (!(m >= 1 && m <= 12)) ctx.fail('Financial year start month must be 1–12', '23514')
  },
  beforeDelete(_old, ctx) {
    ctx.fail('Company settings cannot be deleted', '42501')
  },
})

defineHooks('numbering_sequences', {
  beforeUpdate(row, _old, ctx) {
    if (!(Number(row.next_value) > 0)) ctx.fail('Next value must be positive', '23514')
    const p = Number(row.padding)
    if (!(p >= 1 && p <= 10)) ctx.fail('Padding must be 1–10', '23514')
  },
})

// ---------------------------------------------------------------------------- notifications
defineHooks('notifications', {
  beforeInsert(row) {
    const ok = ['info', 'success', 'warning', 'alert', 'task', 'approval']
    if (!ok.includes(row.type)) row.type = 'info'
  },
})

// ---------------------------------------------------------------------------- audit log is append-only
defineHooks('audit_logs', {
  beforeUpdate(_r, _o, ctx) {
    ctx.fail('Audit log entries cannot be changed', '42501')
  },
  beforeDelete(_o, ctx) {
    ctx.fail('Audit log entries cannot be deleted', '42501')
  },
})

// ---------------------------------------------------------------------------- RPCs

defineRpc('my_permissions', async (_args, ctx) => {
  if (!ctx.me.active) return []
  if (ctx.me.roleKey === 'super_admin') return SEED.permissions.map((p) => p.key)
  return [...ctx.me.perms]
})

defineRpc('has_permission', async (args, ctx) => ctx.me.can(String(args.perm)))

defineRpc('next_number', async (args, ctx) => ctx.nextNumber(String(args.seq_key)))

/** Revoke every session of the caller (or of another user, for users.manage) — see firestore.rules sessionValid(). */
defineRpc('revoke_sessions', async (args, ctx) => {
  const target = String(args.user_id ?? ctx.me.uid)
  if (target !== ctx.me.uid && !ctx.me.can('users.manage')) ctx.fail('Not authorised', '42501')
  const cur = await ctx.get('session_revocations', target)
  // the server clock decides (firestore.rules require at == request.time)
  if (cur) await ctx.update('session_revocations', target, { at: SERVER_TIME })
  else await ctx.insert('session_revocations', { user_id: target, at: SERVER_TIME })
  return true
})
