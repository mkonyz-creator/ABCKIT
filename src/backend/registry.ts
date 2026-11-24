/**
 * Business-logic registry for the Firestore backend.
 *
 * The old PostgreSQL backend enforced rules with triggers, views and RPC functions.
 * Here each domain module (src/backend/domains/*.ts) registers the equivalent TypeScript:
 *   - hooks:  run inside the same Firestore transaction as the write (before = validate/mutate, after = side effects)
 *   - views:  computed read-only "tables" (e.g. project_financials)
 *   - rpcs:   functions called with db.rpc(name, args)
 *   - scopes: how a non-company-wide user's list query is split so Firestore security rules accept it
 *   - inherit: fields copied from a parent row on insert (denormalised for security rules, e.g. project_id)
 *
 * Firestore security rules (firestore.rules) remain the real enforcement layer; hooks keep data consistent.
 */
import type { Filter } from './filters'
import { TABLES } from './schema.generated'
import type { ColumnSchema, ForeignKey } from './types'

export type Row = Record<string, any>

export interface Me {
  uid: string
  email: string | null
  profile: Row | null
  roleKey: string | null
  active: boolean
  perms: Set<string>
  /** company-wide project visibility (projects.view_all or super admin) */
  viewAll: boolean
  /** projects this user can access through membership / PM assignment / creation */
  projectIds: string[]
  can(perm: string): boolean
}

/** A simple equality constraint that is pushed down to Firestore. */
export interface Eq {
  field: string
  value: unknown
}

export interface ReadCtx {
  me: Me | null
  /** run a select through the full engine (filters, scopes, rules) */
  select(table: string, filters?: Filter[], opts?: { select?: string }): Promise<Row[]>
  /** fetch one row by id/primary key (null when missing or not readable) */
  getById(table: string, id: string): Promise<Row | null>
}

export interface WriteCtx extends ReadCtx {
  me: Me
  now: string
  today: string
  /** read inside the transaction (sees this transaction's pending writes) */
  get(table: string, id: string): Promise<Row | null>
  /** queue writes in the same transaction; they run through the same hooks */
  insert(table: string, row: Row): Promise<Row>
  update(table: string, id: string, patch: Row): Promise<Row>
  remove(table: string, id: string): Promise<void>
  nextNumber(seqKey: string): Promise<string>
  notifyUser(userId: string | null | undefined, title: string, body: string | null, type: NotificationType, link: string | null): Promise<void>
  notifyPermission(perm: string, title: string, body: string | null, type: NotificationType, link: string | null): Promise<void>
  notificationEnabled(setting: string): Promise<boolean>
  /** throw a PostgREST-shaped error (message shown to the user) */
  fail(message: string, code?: string): never
}

export type NotificationType = 'info' | 'success' | 'warning' | 'alert' | 'task' | 'approval'

export interface Hooks {
  /** mutate `row` in place (defaults, numbering, validation) */
  beforeInsert?(row: Row, ctx: WriteCtx): Promise<void> | void
  beforeUpdate?(row: Row, old: Row, ctx: WriteCtx): Promise<void> | void
  beforeDelete?(old: Row, ctx: WriteCtx): Promise<void> | void
  afterInsert?(row: Row, ctx: WriteCtx): Promise<void> | void
  afterUpdate?(row: Row, old: Row, ctx: WriteCtx): Promise<void> | void
  afterDelete?(old: Row, ctx: WriteCtx): Promise<void> | void
}

/**
 * Scope: returns the Firestore query variants needed for this caller.
 *  - 'all'   → one unconstrained query
 *  - Eq[][]  → union of queries, each with these equality constraints (empty array = no access)
 */
export type Scope = (me: Me) => 'all' | Eq[][]

export interface Inherit {
  /** fk column on this table */
  via: string
  /** parent table */
  from: string
  /** fields copied: { childField: parentField } */
  fields: Record<string, string>
}

export type ViewFn = (ctx: ReadCtx) => Promise<Row[]>
export type RpcFn = (args: Record<string, any>, ctx: WriteCtx) => Promise<unknown>

const hooks = new Map<string, Hooks[]>()
const views = new Map<string, ViewFn>()
const rpcs = new Map<string, RpcFn>()
const scopes = new Map<string, Scope>()
const inherits = new Map<string, Inherit[]>()
const audited = new Set<string>()
const generated = new Map<string, Record<string, (r: Row) => unknown>>()

export function defineHooks(table: string, h: Hooks) {
  hooks.set(table, [...(hooks.get(table) ?? []), h])
}
export function defineView(name: string, fn: ViewFn) {
  views.set(name, fn)
}
export function defineRpc(name: string, fn: RpcFn) {
  rpcs.set(name, fn)
}
export function defineScope(table: string, fn: Scope) {
  scopes.set(table, fn)
}
export function defineInherit(table: string, i: Inherit) {
  inherits.set(table, [...(inherits.get(table) ?? []), i])
}
export function enableAudit(...tables: string[]) {
  for (const t of tables) audited.add(t)
}
/** generated (computed, stored) columns: recomputed on every insert/update */
export function defineGenerated(table: string, cols: Record<string, (r: Row) => unknown>) {
  generated.set(table, { ...(generated.get(table) ?? {}), ...cols })
}

export const registry = {
  hooks: (t: string) => hooks.get(t) ?? [],
  view: (t: string) => views.get(t),
  rpc: (n: string) => rpcs.get(n),
  scope: (t: string) => scopes.get(t),
  inherits: (t: string) => inherits.get(t) ?? [],
  isAudited: (t: string) => audited.has(t),
  generated: (t: string) => generated.get(t) ?? {},
  viewNames: () => [...views.keys()],
}

// ----------------------------------------------------------------------------- helpers for scopes

/** Standard project scope: company-wide viewers see all; others see their projects (+ optional own-row fields). */
export function projectScope(opts: { field?: string; nullable?: boolean; own?: string[] } = {}): Scope {
  const field = opts.field ?? 'project_id'
  return (me) => {
    if (me.viewAll) return 'all'
    const out: Eq[][] = me.projectIds.map((pid) => [{ field, value: pid }])
    if (opts.nullable) out.push([{ field, value: null }])
    for (const f of opts.own ?? []) out.push([{ field: f, value: me.uid }])
    return out
  }
}

/** Rows visible only by an ownership field (e.g. notifications.user_id). */
export function ownScope(field: string): Scope {
  return (me) => [[{ field, value: me.uid }]]
}

export function round2(n: unknown) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// ----------------------------------------------------------------------------- schema extensions

/**
 * Add columns/tables that did not exist in the original SQL schema (used by the Firebase-era features:
 * usernames, session revocation). Mutates the generated schema at start-up, before any query runs.
 */
export function extendTable(
  table: string,
  ext: { columns?: Record<string, ColumnSchema>; uniques?: string[][]; pk?: string[]; fks?: Record<string, ForeignKey> },
) {
  const t = (TABLES[table] ??= { columns: {}, pk: ext.pk ?? ['id'], fks: {}, uniques: [] })
  Object.assign(t.columns, ext.columns ?? {})
  Object.assign(t.fks, ext.fks ?? {})
  if (ext.pk) t.pk = ext.pk
  for (const u of ext.uniques ?? []) if (!t.uniques.some((x) => x.join() === u.join())) t.uniques.push(u)
}
