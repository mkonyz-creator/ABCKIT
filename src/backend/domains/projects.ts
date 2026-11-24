/**
 * Projects domain — ported from legacy-supabase/migrations/…0200_projects_boq.sql, the documents / tasks part of
 * …0400_hr_finance_docs_tasks.sql and the matching RLS policies of …0500_roles_rls.sql
 * (enforced for real in firebase/rules/20_projects.rules; file access in storage.rules):
 *
 *   clients, projects (code numbering, PM auto-membership), project_members, BOQs (numbering, approval
 *   permission + stamp, approved = locked, amount = qty × rate, boq_totals, duplicate_boq), documents with
 *   version history, tasks (completion, assignment notification, idempotent overdue reminders).
 *
 * Hooks run in the browser inside the write transaction. They keep honest clients consistent and give the
 * same error messages PostgreSQL gave; the security rules are what a modified client cannot bypass.
 */
import type { Filter } from '../filters'
import {
  defineGenerated,
  defineHooks,
  defineInherit,
  defineRpc,
  defineScope,
  defineView,
  enableAudit,
  projectScope,
  round2,
  type Eq,
  type Me,
  type ReadCtx,
  type Row,
  type Scope,
  type WriteCtx,
} from '../registry'

enableAudit('clients', 'projects', 'project_members', 'boqs', 'boq_sections', 'boq_items', 'documents', 'document_versions', 'tasks')

// ============================================================================ helpers

const eq = (col: string, value: unknown): Filter => ({ kind: 'cmp', col, op: 'eq', value })
const changed = (row: Row, old: Row, col: string) => JSON.stringify(row[col] ?? null) !== JSON.stringify(old[col] ?? null)

function rls(ctx: WriteCtx, table: string): never {
  return ctx.fail(`new row violates row-level security policy for table "${table}"`, '42501')
}

/** true when every changed column is in `allowed` (updated_at always ignored) */
function onlyChanged(row: Row, old: Row, allowed: string[]) {
  for (const k of new Set([...Object.keys(row), ...Object.keys(old)])) {
    if (k === 'updated_at' || allowed.includes(k)) continue
    if (changed(row, old, k)) return false
  }
  return true
}

/** can_access_project(): company-wide viewers, the PM, listed members (+ projects created in this transaction) */
async function canAccess(ctx: WriteCtx, pid: unknown): Promise<boolean> {
  if (pid == null) return true
  if (!ctx.me.active) return false
  if (ctx.me.viewAll || ctx.me.projectIds.includes(String(pid))) return true
  const p = await ctx.get('projects', String(pid))
  if (p && (p.project_manager_id === ctx.me.uid || p.created_by === ctx.me.uid)) return true
  return !!(await ctx.get('project_members', `${pid}__${ctx.me.uid}`))
}

/**
 * Rows being deleted in this transaction. The engine runs a parent's beforeDelete, then cascades to the
 * children, then removes the parent — children use this to recognise a cascade (PostgreSQL FK actions bypassed
 * RLS and saw the parent already gone).
 */
const deleting = new WeakMap<WriteCtx, Set<string>>()
const markDeleting = (ctx: WriteCtx, table: string, id: unknown) => {
  let s = deleting.get(ctx)
  if (!s) deleting.set(ctx, (s = new Set()))
  s.add(`${table}/${id}`)
}
const isDeleting = (ctx: WriteCtx, table: string, id: unknown) => id != null && !!deleting.get(ctx)?.has(`${table}/${id}`)

/** an FK column was nulled because the referenced row is being deleted (ON DELETE SET NULL) */
function fkNulledByCascade(ctx: WriteCtx, row: Row, old: Row, fks: Record<string, string>) {
  const cols = Object.keys(fks).filter((c) => changed(row, old, c))
  return cols.length > 0 && onlyChanged(row, old, cols) && cols.every((c) => row[c] == null && isDeleting(ctx, fks[c], old[c]))
}

/**
 * CHECK constraints from the SQL table definitions (the engine only enforces NOT NULL / UNIQUE / FK cascades).
 * Like SQL CHECKs they pass on NULL; NOT NULL columns are rejected by the engine afterwards (23502).
 */
type Check = [name: string, ok: (r: Row) => boolean]
function defineChecks(table: string, list: Check[]) {
  const run = (row: Row, ctx: WriteCtx) => {
    for (const [name, ok] of list) if (!ok(row)) ctx.fail(`new row for relation "${table}" violates check constraint "${table}_${name}_check"`, '23514')
  }
  defineHooks(table, { beforeInsert: run, beforeUpdate: (row, _old, ctx) => run(row, ctx) })
}
const len = (col: string, min: number, max: number): Check => [
  col,
  (r) => r[col] == null || (typeof r[col] === 'string' && [...r[col]].length >= min && [...r[col]].length <= max),
]
const oneOf = (col: string, values: string[]): Check => [col, (r) => r[col] == null || values.includes(r[col])]
const atLeast = (col: string, min: number): Check => [col, (r) => r[col] == null || Number(r[col]) >= min]
const between = (col: string, min: number, max: number): Check => [col, (r) => r[col] == null || (Number(r[col]) >= min && Number(r[col]) <= max)]
const currency: Check = ['currency', (r) => r.currency == null || /^[A-Z]{3}$/.test(String(r.currency))]
const dateOrder = (name: string, from: string, to: string): Check => [name, (r) => r[from] == null || r[to] == null || String(r[to]) >= String(r[from])]

/** to_char(d, 'DD Mon YYYY') */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function formatDay(d: string) {
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${day} ${MONTHS[Number(m) - 1] ?? m} ${y}`
}
const localDay = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ============================================================================ read scopes
// projects: company-wide → everything; others → one query per accessible project id (+ own PM / creator rows)
defineScope('projects', (me) => {
  if (me.viewAll) return 'all'
  return [
    ...me.projectIds.map((id) => [{ field: 'id', value: id }]),
    [{ field: 'project_manager_id', value: me.uid }],
    [{ field: 'created_by', value: me.uid }],
  ]
})
defineScope('project_members', projectScope({ own: ['user_id'] }))
defineScope('boqs', projectScope())
defineScope('boq_sections', projectScope())
defineScope('boq_items', projectScope())
defineScope('tasks', projectScope({ nullable: true, own: ['assigned_to'] }))

/**
 * documents / document_versions: the read rule also depends on access_level, so the query must pin it
 * unless the caller may read every level (documents.restricted).
 */
export const documentScope: Scope = (me: Me) => {
  if (!me.can('documents.view')) return []
  const levels = me.can('documents.restricted') ? null : me.viewAll ? ['project', 'management'] : ['project']
  const projects: (string | null)[] | null = me.viewAll ? null : [...me.projectIds, null]
  if (!levels && !projects) return 'all'
  const out: Eq[][] = []
  for (const p of projects ?? [undefined]) {
    for (const l of levels ?? [undefined]) {
      const v: Eq[] = []
      if (p !== undefined) v.push({ field: 'project_id', value: p })
      if (l !== undefined) v.push({ field: 'access_level', value: l })
      out.push(v)
    }
  }
  return out
}
defineScope('documents', documentScope)
defineScope('document_versions', documentScope)

// ---- denormalised parent fields used by the security rules
defineInherit('boq_sections', { via: 'boq_id', from: 'boqs', fields: { project_id: 'project_id' } })
// boq_id follows the section (was trigger a_boq_items_sync); project_id rides along for the rules
defineInherit('boq_items', { via: 'section_id', from: 'boq_sections', fields: { boq_id: 'boq_id', project_id: 'project_id' } })
defineInherit('document_versions', { via: 'document_id', from: 'documents', fields: { project_id: 'project_id', access_level: 'access_level' } })

// ============================================================================ clients

defineChecks('clients', [
  len('name', 1, 200),
  oneOf('client_type', ['company', 'government', 'individual', 'ngo']),
  ['email', (r) => r.email == null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)],
])
defineHooks('clients', {
  beforeInsert(_row, ctx) {
    if (!ctx.me.can('clients.manage')) rls(ctx, 'clients')
  },
  beforeUpdate(_row, _old, ctx) {
    if (!ctx.me.can('clients.manage')) rls(ctx, 'clients')
  },
  beforeDelete(old, ctx) {
    if (!ctx.me.can('clients.manage')) rls(ctx, 'clients')
    markDeleting(ctx, 'clients', old.id)
  },
})

// ============================================================================ projects

defineChecks('projects', [
  len('name', 2, 200),
  atLeast('contract_value', 0),
  atLeast('budget', 0),
  currency,
  oneOf('status', ['planning', 'active', 'on_hold', 'completed', 'cancelled']),
  between('progress', 0, 100),
  dateOrder('dates', 'start_date', 'end_date'),
])

/** The PM is also listed as a member, so storage.rules can check project access with one document read. */
async function ensurePmMember(row: Row, ctx: WriteCtx) {
  if (!row.project_manager_id) return
  if (await ctx.get('project_members', `${row.id}__${row.project_manager_id}`)) return
  await ctx.insert('project_members', { project_id: row.id, user_id: row.project_manager_id, member_role: 'project_manager' })
}

defineHooks('projects', {
  async beforeInsert(row, ctx) {
    if (!ctx.me.can('projects.manage')) rls(ctx, 'projects')
    if (row.code == null || row.code === '') row.code = await ctx.nextNumber('project')
  },
  async beforeUpdate(row, old, ctx) {
    if (ctx.me.can('projects.manage') && (await canAccess(ctx, old.id))) return
    // approved site report rolls its progress onto the project (was SECURITY DEFINER)
    if (ctx.me.can('site.approve') && onlyChanged(row, old, ['progress']) && (await canAccess(ctx, old.id))) return
    if (fkNulledByCascade(ctx, row, old, { client_id: 'clients', project_manager_id: 'profiles' })) return
    rls(ctx, 'projects')
  },
  async beforeDelete(old, ctx) {
    if (ctx.me.roleKey !== 'super_admin') rls(ctx, 'projects')
    markDeleting(ctx, 'projects', old.id)
  },
  afterInsert: ensurePmMember,
  async afterUpdate(row, old, ctx) {
    if (row.project_manager_id !== old.project_manager_id) await ensurePmMember(row, ctx)
  },
})

// ============================================================================ project members

const MEMBER_ROLES = ['project_manager', 'site_engineer', 'quantity_surveyor', 'supervisor', 'storekeeper', 'member']
defineChecks('project_members', [oneOf('member_role', MEMBER_ROLES)])

/**
 * Denormalised for storage.rules (Cloud Storage rules may read only two Firestore documents): the member's
 * role and that role's permission list. Firestore rules verify both against profiles/roles on every write.
 */
async function memberDenorm(row: Row, ctx: WriteCtx) {
  const prof = await ctx.get('profiles', String(row.user_id))
  const role = prof?.role_id ? await ctx.get('roles', String(prof.role_id)) : null
  row.role_id = prof?.role_id ?? null
  row.perms = Array.isArray(role?.perms) ? [...role!.perms] : []
}

async function mayManageMembers(row: Row, ctx: WriteCtx) {
  if (!ctx.me.can('projects.manage')) return false
  if (await canAccess(ctx, row.project_id)) return true
  // PM auto-membership while the project itself is being created / re-assigned in this transaction
  const p = await ctx.get('projects', String(row.project_id))
  return row.member_role === 'project_manager' && p?.project_manager_id === row.user_id
}

defineHooks('project_members', {
  async beforeInsert(row, ctx) {
    if (!(await mayManageMembers(row, ctx))) rls(ctx, 'project_members')
    await memberDenorm(row, ctx)
  },
  async beforeUpdate(row, old, ctx) {
    await memberDenorm(row, ctx)
    if (onlyChanged(row, old, ['role_id', 'perms'])) return // re-sync after a role / permission change
    if (!(await mayManageMembers(row, ctx))) rls(ctx, 'project_members')
  },
  async beforeDelete(old, ctx) {
    if (isDeleting(ctx, 'projects', old.project_id) || isDeleting(ctx, 'profiles', old.user_id)) return
    if (!ctx.me.can('projects.manage') || !(await canAccess(ctx, old.project_id))) rls(ctx, 'project_members')
  },
})

// keep the denormalised role / perms of memberships current (core tables, so registered here)
defineHooks('profiles', {
  async afterUpdate(row, old, ctx) {
    if (row.role_id === old.role_id) return
    const ms = await ctx.select('project_members', [eq('user_id', row.id)])
    for (const m of ms) await ctx.update('project_members', `${m.project_id}__${m.user_id}`, {})
  },
  beforeDelete(old, ctx) {
    markDeleting(ctx, 'profiles', old.id)
  },
})
defineHooks('roles', {
  async afterUpdate(row, old, ctx) {
    if (JSON.stringify(row.perms ?? []) === JSON.stringify(old.perms ?? [])) return
    const ms = await ctx.select('project_members', [eq('role_id', row.id)])
    for (const m of ms) await ctx.update('project_members', `${m.project_id}__${m.user_id}`, {})
  },
})

// ============================================================================ BOQ

const LOCKED = 'This BOQ is approved and locked. Create a revision to change it.'

defineChecks('boqs', [
  len('title', 2, 200),
  currency,
  ['taxes', (r) => r.taxes == null || Array.isArray(r.taxes)],
  oneOf('status', ['draft', 'submitted', 'approved', 'superseded']),
])

function stampApproval(row: Row, ctx: WriteCtx) {
  if (!ctx.me.can('boq.approve')) ctx.fail('Not authorised to approve BOQs', '42501')
  row.approved_by = ctx.me.uid
  row.approved_at = ctx.now
}

defineHooks('boqs', {
  async beforeInsert(row, ctx) {
    if (!ctx.me.can('boq.manage') || !(await canAccess(ctx, row.project_id))) rls(ctx, 'boqs')
    if (row.number == null || row.number === '') row.number = await ctx.nextNumber('boq')
    if (row.status === 'approved') stampApproval(row, ctx)
    else row.approved_by = row.approved_at = null
  },
  async beforeUpdate(row, old, ctx) {
    if (!(ctx.me.can('boq.manage') || ctx.me.can('boq.approve')) || !(await canAccess(ctx, old.project_id))) rls(ctx, 'boqs')
    if (row.project_id !== old.project_id) ctx.fail('A BOQ cannot be moved to another project; create a new BOQ instead', '42501')
    if (old.status === 'approved') {
      // locked: the only change left is marking it superseded (by an approver)
      if (!onlyChanged(row, old, ['status']) || !['approved', 'superseded'].includes(row.status)) ctx.fail(LOCKED, '42501')
      if (row.status === 'superseded' && !ctx.me.can('boq.approve')) ctx.fail('Not authorised to supersede approved BOQs', '42501')
      return
    }
    if (row.status === 'approved') stampApproval(row, ctx)
    else {
      row.approved_by = old.approved_by
      row.approved_at = old.approved_at
    }
  },
  async beforeDelete(old, ctx) {
    if (!isDeleting(ctx, 'projects', old.project_id) && (!ctx.me.can('boq.manage') || !(await canAccess(ctx, old.project_id)))) rls(ctx, 'boqs')
    markDeleting(ctx, 'boqs', old.id)
  },
})

/** boq_lock_guard(): approved BOQs reject section / item changes (except when the BOQ itself is deleted) */
async function boqGuard(table: string, boqId: unknown, ctx: WriteCtx) {
  if (isDeleting(ctx, 'boqs', boqId)) return
  const boq = boqId == null ? null : await ctx.get('boqs', String(boqId))
  if (!boq) ctx.fail(`BOQ ${boqId} not found or not accessible`, '23503')
  if (!ctx.me.can('boq.manage') || !(await canAccess(ctx, boq.project_id))) rls(ctx, table)
  if (boq.status === 'approved') ctx.fail(LOCKED, '42501')
}

defineChecks('boq_sections', [len('title', 1, 200)])
defineHooks('boq_sections', {
  async beforeInsert(row, ctx) {
    await boqGuard('boq_sections', row.boq_id, ctx)
  },
  async beforeUpdate(row, old, ctx) {
    if (row.boq_id !== old.boq_id) ctx.fail('A section cannot be moved to another BOQ', '42501')
    await boqGuard('boq_sections', row.boq_id, ctx)
  },
  async beforeDelete(old, ctx) {
    await boqGuard('boq_sections', old.boq_id, ctx)
    markDeleting(ctx, 'boq_sections', old.id)
  },
})

defineChecks('boq_items', [len('description', 1, 1000), atLeast('quantity', 0), atLeast('rate', 0)])
defineGenerated('boq_items', { amount: (r) => round2((Number(r.quantity) || 0) * (Number(r.rate) || 0)) })
defineHooks('boq_items', {
  async beforeInsert(row, ctx) {
    await boqGuard('boq_items', row.boq_id, ctx)
  },
  async beforeUpdate(row, old, ctx) {
    if (row.boq_id !== old.boq_id) ctx.fail('An item can only move between sections of the same BOQ', '42501')
    await boqGuard('boq_items', row.boq_id, ctx)
  },
  async beforeDelete(old, ctx) {
    await boqGuard('boq_items', old.boq_id, ctx)
  },
})

/** boq_totals view: Amount = Qty × Rate ; Grand Total = Subtotal + Σ taxes */
export function boqTotalsRow(boq: Row, items: Row[]) {
  const subtotal = round2(items.reduce((s, i) => s + (Number(i.amount) || 0), 0))
  const rate = (Array.isArray(boq.taxes) ? boq.taxes : []).reduce((s: number, t: Row) => s + (Number(t?.rate) || 0), 0)
  return {
    boq_id: boq.id,
    project_id: boq.project_id,
    subtotal,
    tax_rate_total: rate,
    tax_amount: round2((subtotal * rate) / 100),
    grand_total: round2(subtotal * (1 + rate / 100)),
    item_count: items.length,
  }
}

defineView('boq_totals', async (ctx: ReadCtx) => {
  const [boqs, items] = await Promise.all([ctx.select('boqs'), ctx.select('boq_items', [], { select: 'boq_id,amount' })])
  const byBoq = new Map<string, Row[]>()
  for (const i of items) byBoq.set(String(i.boq_id), [...(byBoq.get(String(i.boq_id)) ?? []), i])
  return boqs.map((b) => boqTotalsRow(b, byBoq.get(String(b.id)) ?? []))
})

/** duplicate_boq(p_boq, p_title): copy a BOQ (sections + items) as a new draft revision */
defineRpc('duplicate_boq', async (args, ctx) => {
  const src = args.p_boq ? await ctx.get('boqs', String(args.p_boq)) : null
  if (!src) return ctx.fail('BOQ not found')
  const copy = await ctx.insert('boqs', {
    project_id: src.project_id,
    title: args.p_title ?? `${src.title} (Revision)`,
    description: src.description,
    currency: src.currency,
    taxes: src.taxes,
  })
  const [sections, items] = await Promise.all([ctx.select('boq_sections', [eq('boq_id', src.id)]), ctx.select('boq_items', [eq('boq_id', src.id)])])
  const bySort = (a: Row, b: Row) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.created_at).localeCompare(String(b.created_at))
  for (const s of sections.sort(bySort)) {
    const ns = await ctx.insert('boq_sections', { boq_id: copy.id, code: s.code, title: s.title, sort_order: s.sort_order })
    for (const i of items.filter((x) => x.section_id === s.id).sort(bySort))
      await ctx.insert('boq_items', {
        section_id: ns.id,
        item_code: i.item_code,
        description: i.description,
        unit: i.unit,
        quantity: i.quantity,
        rate: i.rate,
        sort_order: i.sort_order,
      })
  }
  return copy.id
})

// ============================================================================ access helpers as RPCs

defineRpc('my_project_ids', async (_args, ctx) => {
  if (!ctx.me.active) return []
  if (!ctx.me.viewAll) return [...ctx.me.projectIds]
  return (await ctx.select('projects', [], { select: 'id' })).map((p) => p.id)
})
defineRpc('can_access_project', async (args, ctx) => canAccess(ctx, args.pid ?? null))

// ============================================================================ documents

/** text[] columns: the generated schema default is the PostgreSQL literal '{}'; store a real array */
function pgArray(v: unknown): unknown {
  if (Array.isArray(v) || v == null || typeof v !== 'string') return v
  const inner = v.trim().replace(/^\{|\}$/g, '')
  return inner === '' ? [] : inner.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
}
defineHooks('documents', {
  beforeInsert(row) {
    row.tags = pgArray(row.tags)
  },
  beforeUpdate(row) {
    row.tags = pgArray(row.tags)
  },
})

const DOC_CATEGORIES = ['contract', 'drawing', 'boq', 'invoice', 'receipt', 'site_report', 'permit', 'technical', 'photo', 'correspondence', 'other']
defineChecks('documents', [
  len('title', 1, 300),
  oneOf('category', DOC_CATEGORIES),
  oneOf('access_level', ['project', 'management', 'restricted']),
  ['tags', (r) => r.tags == null || Array.isArray(r.tags)],
])

/** can_read_document(project, access_level) */
async function canReadDocument(ctx: WriteCtx, d: Row) {
  const me = ctx.me
  if (!me.can('documents.view') || !(await canAccess(ctx, d.project_id))) return false
  return (
    d.access_level === 'project' ||
    (d.access_level === 'management' && (me.can('documents.restricted') || me.can('projects.view_all'))) ||
    (d.access_level === 'restricted' && me.can('documents.restricted'))
  )
}

/** a new version moving the document's current_* columns (was the SECURITY DEFINER version trigger) */
const versioning = new WeakMap<WriteCtx, Set<string>>()

defineHooks('documents', {
  async beforeInsert(row, ctx) {
    if (!ctx.me.can('documents.manage') || !(await canAccess(ctx, row.project_id))) rls(ctx, 'documents')
    Object.assign(row, { current_version: 0, current_path: null, file_name: null, mime_type: null, size_bytes: null })
  },
  async beforeUpdate(row, old, ctx) {
    if (!ctx.me.can('documents.manage') || !(await canReadDocument(ctx, old)) || !(await canAccess(ctx, row.project_id))) rls(ctx, 'documents')
    if (!versioning.get(ctx)?.has(String(old.id)))
      for (const k of ['current_version', 'current_path', 'file_name', 'mime_type', 'size_bytes']) row[k] = old[k]
  },
  async beforeDelete(old, ctx) {
    if (!isDeleting(ctx, 'projects', old.project_id)) {
      const mine = old.created_by === ctx.me.uid || ctx.me.can('documents.restricted')
      if (!ctx.me.can('documents.manage') || !mine || !(await canReadDocument(ctx, old))) rls(ctx, 'documents')
    }
    markDeleting(ctx, 'documents', old.id)
  },
})

defineChecks('document_versions', [['size_bytes', (r) => r.size_bytes == null || (Number(r.size_bytes) >= 0 && Number(r.size_bytes) <= 52428800)]])
defineHooks('document_versions', {
  async beforeInsert(row, ctx) {
    const doc = await ctx.get('documents', String(row.document_id))
    if (!doc || !ctx.me.can('documents.manage') || !(await canReadDocument(ctx, doc))) rls(ctx, 'document_versions')
    row.version = (Number(doc.current_version) || 0) + 1
    let s = versioning.get(ctx)
    if (!s) versioning.set(ctx, (s = new Set()))
    s.add(String(doc.id))
    await ctx.update('documents', String(doc.id), {
      current_version: row.version,
      current_path: row.storage_path,
      file_name: row.file_name,
      mime_type: row.mime_type ?? null,
      size_bytes: row.size_bytes ?? null,
    })
    s.delete(String(doc.id))
  },
  beforeUpdate(row, old, ctx) {
    // immutable; only the denormalised copies of the document's project / access level follow the document
    if (!onlyChanged(row, old, ['project_id', 'access_level'])) ctx.fail('Document versions cannot be changed; upload a new version', '42501')
  },
  beforeDelete(old, ctx) {
    if (!isDeleting(ctx, 'documents', old.document_id)) ctx.fail('Document versions cannot be deleted', '42501')
  },
})

// ============================================================================ tasks

defineChecks('tasks', [
  len('title', 2, 300),
  oneOf('priority', ['low', 'medium', 'high', 'critical']),
  oneOf('status', ['todo', 'in_progress', 'review', 'blocked', 'done']),
  between('progress', 0, 100),
  dateOrder('dates', 'start_date', 'due_date'),
])

async function mayManageTask(ctx: WriteCtx, projectId: unknown) {
  return ctx.me.can('tasks.manage') && (await canAccess(ctx, projectId))
}

/** tasks_before(): done ⇒ 100 % + completed_at; anything else clears completed_at */
function completion(row: Row, old: Row | null, ctx: WriteCtx) {
  if (row.status === 'done') {
    row.progress = 100
    row.completed_at = old && old.status === 'done' ? (old.completed_at ?? ctx.now) : ctx.now
  } else row.completed_at = null
}

async function notifyAssignee(row: Row, old: Row | null, ctx: WriteCtx) {
  if (!row.assigned_to || row.assigned_to === ctx.me.uid) return
  if (old && old.assigned_to === row.assigned_to) return
  if (!(await ctx.notificationEnabled('task_assigned'))) return
  await ctx.notifyUser(row.assigned_to, 'New task assigned', `${row.title}${row.due_date ? ` — due ${formatDay(row.due_date)}` : ''}`, 'task', `/tasks?task=${row.id}`)
}

defineHooks('tasks', {
  async beforeInsert(row, ctx) {
    if (!(await mayManageTask(ctx, row.project_id))) rls(ctx, 'tasks')
    completion(row, null, ctx)
  },
  async beforeUpdate(row, old, ctx) {
    const manager = (await mayManageTask(ctx, old.project_id)) && (await mayManageTask(ctx, row.project_id))
    const assignee = ctx.me.active && old.assigned_to === ctx.me.uid && row.assigned_to === ctx.me.uid && !changed(row, old, 'project_id')
    if (!manager && !assignee && !fkNulledByCascade(ctx, row, old, { assigned_to: 'profiles' })) rls(ctx, 'tasks')
    completion(row, old, ctx)
  },
  async beforeDelete(old, ctx) {
    const cascade = isDeleting(ctx, 'projects', old.project_id) || isDeleting(ctx, 'tasks', old.parent_id)
    if (!cascade && !(await mayManageTask(ctx, old.project_id))) rls(ctx, 'tasks')
    markDeleting(ctx, 'tasks', old.id)
  },
  afterInsert: (row, ctx) => notifyAssignee(row, null, ctx),
  afterUpdate: (row, old, ctx) => notifyAssignee(row, old, ctx),
})

/**
 * notify_overdue_tasks(): idempotent overdue reminder (one per task per day).
 * PostgreSQL ran it as SECURITY DEFINER for every user; notifications are private to their recipient in
 * Firestore, so the de-duplication check is only possible for the caller's own notifications. The app calls
 * this at sign-in, so each assignee gets their reminders when they open the app.
 */
defineRpc('notify_overdue_tasks', async (_args, ctx) => {
  if (!ctx.me.active) return 0
  if (!(await ctx.notificationEnabled('overdue_tasks'))) return 0
  const tasks = (await ctx.select('tasks', [eq('assigned_to', ctx.me.uid)])).filter(
    (t) => t.status !== 'done' && t.due_date && String(t.due_date) < ctx.today,
  )
  if (!tasks.length) return 0
  const sent = await ctx.select('notifications', [eq('user_id', ctx.me.uid), eq('title', 'Task overdue')])
  const today = new Set(sent.filter((n) => localDay(n.created_at) === ctx.today).map((n) => n.link))
  let n = 0
  for (const t of tasks) {
    const link = `/tasks?task=${t.id}`
    if (today.has(link)) continue
    await ctx.notifyUser(t.assigned_to, 'Task overdue', `${t.title} was due ${formatDay(t.due_date)}`, 'alert', link)
    n++
  }
  return n
})
