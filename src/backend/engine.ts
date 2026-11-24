/**
 * Query + mutation engine: executes PostgREST-shaped requests against a Store (Firestore in production).
 *
 * Reads:  equality filters are pushed down to Firestore; the caller's scope (see registry.ts) splits the
 *         query so security rules can verify it; everything else (ilike, or, ranges, ordering, joins) runs here.
 *         A query the rules reject returns no rows — the same behaviour Row Level Security had.
 * Writes: every insert/update/delete runs in one Firestore transaction together with the side effects
 *         its hooks queue (numbering, stock ledger, notifications, audit log, cascades).
 */
import { matches, type Filter } from './filters'
import { registry, type Eq, type Me, type NotificationType, type ReadCtx, type Row, type WriteCtx } from './registry'
import { TABLES } from './schema.generated'
import { parseSelect, type EmbedNode, type SelectNode } from './select'
import { isPermissionDenied, PermissionDenied, type Store, type StoreEq, type StoreTx } from './store'

export class DbError extends Error {
  code: string
  details: string | null
  hint: string | null
  constructor(message: string, code = 'P0001', details: string | null = null) {
    super(message)
    this.code = code
    this.details = details
    this.hint = null
  }
}

export interface OrderSpec {
  column: string
  ascending: boolean
  nullsFirst?: boolean
}

export interface SelectRequest {
  table: string
  select?: string
  filters?: Filter[]
  order?: OrderSpec[]
  limit?: number
  offset?: number
}

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
export { uuid }

const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)))
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function schemaOf(table: string) {
  return TABLES[table]
}

/** Firestore document id for a row: the primary key (composite keys joined with "__"). */
export function docIdOf(table: string, row: Row): string {
  const pk = TABLES[table]?.pk?.length ? TABLES[table].pk : ['id']
  const parts = pk.map((k) => row[k])
  if (parts.some((p) => p === undefined || p === null || p === '')) throw new DbError(`Missing primary key for ${table}`, '23502')
  return parts.map(String).join('__')
}

/** Default read scope: tables with a project_id column are project-scoped, everything else is global. */
function defaultScope(table: string, me: Me): 'all' | Eq[][] {
  const col = TABLES[table]?.columns.project_id
  if (!col) return 'all'
  if (me.viewAll) return 'all'
  const out: Eq[][] = me.projectIds.map((pid) => [{ field: 'project_id', value: pid }])
  if (!col.notNull) out.push([{ field: 'project_id', value: null }])
  return out
}

/** Top-level equality / IN filters that can be pushed down to Firestore. */
function pushdown(filters: Filter[]): { eqs: StoreEq[]; complete: boolean } {
  const eqs: StoreEq[] = []
  let complete = true
  for (const f of filters) {
    if (f.kind === 'cmp' && !f.negate && !f.col.includes('.')) {
      if (f.op === 'eq' && f.value !== null && f.value !== undefined && typeof f.value !== 'object') {
        eqs.push({ field: f.col, value: f.value })
        continue
      }
      if (f.op === 'is' && (f.value === null || f.value === 'null')) {
        eqs.push({ field: f.col, value: null })
        continue
      }
      if (f.op === 'in' && Array.isArray(f.value) && f.value.length > 0 && f.value.length <= 30 && !eqs.some((e) => e.op === 'in')) {
        eqs.push({ field: f.col, value: f.value, op: 'in' })
        continue
      }
    }
    complete = false
  }
  return { eqs, complete }
}

/** Typed comparison for equality pushdown: Firestore is type-strict ("5" != 5). */
function coerceEq(table: string, e: StoreEq): StoreEq {
  const type = TABLES[table]?.columns[e.field]?.type ?? ''
  const conv = (v: unknown) => {
    if (v === null || v === undefined) return null
    if (/^(int|bigint|numeric|smallint|real|double)/.test(type)) return typeof v === 'string' ? Number(v) : v
    if (type === 'boolean') return v === true || v === 'true'
    if (/^(text|uuid|date|timestamptz)/.test(type)) return typeof v === 'number' ? String(v) : v
    return v
  }
  return e.op === 'in' ? { ...e, value: (e.value as unknown[]).map(conv) } : { ...e, value: conv(e.value) }
}

function mergeEqs(a: StoreEq[], b: Eq[]): StoreEq[] | null {
  const out = [...a]
  for (const s of b) {
    const same = out.find((x) => x.field === s.field)
    if (!same) {
      out.push({ field: s.field, value: s.value })
      continue
    }
    if (same.op === 'in') {
      const vals = (same.value as unknown[]).filter((v) => v === s.value)
      if (!vals.length) return null
      Object.assign(same, { op: '==', value: s.value })
    } else if ((same.value ?? null) !== (s.value ?? null)) return null
  }
  return out
}

function sortRows(rows: Row[], order: OrderSpec[]) {
  if (!order.length) return rows
  return rows.sort((a, b) => {
    for (const o of order) {
      const av = a[o.column]
      const bv = b[o.column]
      const an = av === null || av === undefined
      const bn = bv === null || bv === undefined
      if (an || bn) {
        if (an && bn) continue
        const nullsFirst = o.nullsFirst ?? !o.ascending
        return (an ? -1 : 1) * (nullsFirst ? 1 : -1)
      }
      let c: number
      if (typeof av === 'number' && typeof bv === 'number') c = av - bv
      else c = String(av).localeCompare(String(bv), undefined, { numeric: false, sensitivity: 'variant' })
      if (c !== 0) return o.ascending ? c : -c
    }
    return 0
  })
}

// ============================================================================= Engine

export class Engine {
  store: Store
  private meLoader: () => Promise<Me | null>
  private onWrite: (tables: Set<string>) => void
  constructor(store: Store, meLoader: () => Promise<Me | null>, onWrite: (tables: Set<string>) => void = () => undefined) {
    this.store = store
    this.meLoader = meLoader
    this.onWrite = onWrite
  }

  me() {
    return this.meLoader()
  }

  readCtx(me: Me | null): ReadCtx {
    return {
      me,
      select: (table, filters = [], opts = {}) => this.select({ table, filters, select: opts.select }),
      getById: (table, id) => this.getById(table, id),
    }
  }

  async getById(table: string, id: string): Promise<Row | null> {
    if (registry.view(table)) {
      const rows = await this.fetchRows(table, [{ kind: 'cmp', col: 'id', op: 'eq', value: id }])
      return rows[0] ?? null
    }
    try {
      return await this.store.get(table, id)
    } catch (e) {
      if (isPermissionDenied(e)) return null
      throw e
    }
  }

  /** Raw rows of a table/view after filters (no ordering, embeds or projection). */
  async fetchRows(table: string, filters: Filter[], push?: { order?: OrderSpec[]; limit?: number }): Promise<Row[]> {
    const view = registry.view(table)
    const me = await this.me()
    if (view) {
      const rows = await view(this.readCtx(me))
      return rows.filter((r) => filters.every((f) => matches(r, f)))
    }
    if (!TABLES[table]) throw new DbError(`Unknown table "${table}"`, '42P01')
    const { eqs, complete } = pushdown(filters)
    const typed = eqs.map((e) => coerceEq(table, e))
    const scope = !me ? 'all' : (registry.scope(table)?.(me) ?? defaultScope(table, me))
    const variants: StoreEq[][] = []
    if (scope === 'all') variants.push(typed)
    else
      for (const s of scope) {
        const merged = mergeEqs(typed, s)
        if (merged) variants.push(merged)
      }
    // order/limit can only be pushed down for a single unfiltered query (no composite index needed)
    const canPush = variants.length === 1 && complete && variants[0].length === 0 && push?.order?.length === 1 && push.limit
    const results = await Promise.all(
      variants.map(async (v) => {
        try {
          return await this.store.query(
            table,
            v,
            canPush ? { orderBy: { field: push!.order![0].column, ascending: push!.order![0].ascending }, limit: push!.limit } : undefined,
          )
        } catch (e) {
          if (isPermissionDenied(e)) return [] as Row[]
          throw e
        }
      }),
    )
    const seen = new Set<string>()
    const out: Row[] = []
    for (const rows of results)
      for (const r of rows) {
        const id = docIdOf(table, r)
        if (seen.has(id)) continue
        seen.add(id)
        out.push(r)
      }
    return out.filter((r) => filters.every((f) => matches(r, f)))
  }

  async select(req: SelectRequest): Promise<Row[]> {
    const node = parseSelect(req.select)
    const pushable = req.limit !== undefined && !node.embeds.some((e) => e.inner)
    let rows = await this.fetchRows(req.table, req.filters ?? [], {
      order: req.order,
      limit: pushable ? req.limit! + (req.offset ?? 0) : undefined,
    })
    rows = sortRows(rows, req.order ?? [])
    rows = await this.project(req.table, rows, node)
    if (req.offset) rows = rows.slice(req.offset)
    if (req.limit !== undefined) rows = rows.slice(0, req.limit)
    return rows
  }

  /** Apply column projection and embeds (joins) to rows of `table`. */
  async project(table: string, rows: Row[], node: SelectNode): Promise<Row[]> {
    if (!rows.length) return rows
    const embedded = await Promise.all(node.embeds.map((e) => this.embed(table, rows, e)))
    let out = rows.map((r, i) => {
      const o: Row = node.star || (!node.columns.length && !node.embeds.length) ? { ...r } : {}
      for (const c of node.columns) o[c.alias] = r[c.name] ?? null
      node.embeds.forEach((e, k) => (o[e.alias] = embedded[k][i]))
      return o
    })
    node.embeds.forEach((e) => {
      if (e.inner) out = out.filter((o) => (Array.isArray(o[e.alias]) ? o[e.alias].length > 0 : o[e.alias] != null))
    })
    return out
  }

  private resolveEmbed(parent: string, e: EmbedNode): { mode: 'one' | 'many'; col: string } {
    const ps = TABLES[parent]
    const cs = TABLES[e.table]
    if (e.hint) {
      const h = e.hint.replace(/_fkey$/, '')
      if (ps && h.startsWith(`${parent}_`) && ps.fks[h.slice(parent.length + 1)]) return { mode: 'one', col: h.slice(parent.length + 1) }
      if (cs && h.startsWith(`${e.table}_`) && cs.fks[h.slice(e.table.length + 1)]) return { mode: 'many', col: h.slice(e.table.length + 1) }
      if (ps?.fks[e.hint]) return { mode: 'one', col: e.hint }
      if (cs?.fks[e.hint]) return { mode: 'many', col: e.hint }
    }
    const fwd = Object.entries(ps?.fks ?? {}).filter(([, fk]) => fk.table === e.table)
    if (fwd.length === 1) return { mode: 'one', col: fwd[0][0] }
    if (fwd.length > 1) {
      const pick = fwd.find(([c]) => c === `${e.alias}_id` || c === e.alias)
      if (pick) return { mode: 'one', col: pick[0] }
      throw new DbError(`Ambiguous embed ${parent} → ${e.table}; add a !hint`, 'PGRST201')
    }
    const back = Object.entries(cs?.fks ?? {}).filter(([, fk]) => fk.table === parent)
    if (back.length >= 1) return { mode: 'many', col: back[0][0] }
    throw new DbError(`No relationship between ${parent} and ${e.table}`, 'PGRST200')
  }

  private async embed(parent: string, rows: Row[], e: EmbedNode): Promise<unknown[]> {
    const { mode, col } = this.resolveEmbed(parent, e)
    if (mode === 'one') {
      const ids = [...new Set(rows.map((r) => r[col]).filter((v) => v != null).map(String))]
      const fetched = await Promise.all(ids.map((id) => this.getById(e.table, id)))
      const found = fetched.filter((r): r is Row => !!r)
      const projected = await this.project(e.table, found, e.select)
      const refCol = TABLES[parent]?.fks[col]?.column ?? 'id'
      const byId = new Map<string, Row>()
      found.forEach((r, i) => byId.set(String(r[refCol]), projected[i]))
      return rows.map((r) => (r[col] == null ? null : (byId.get(String(r[col])) ?? null)))
    }
    // one-to-many: children whose `col` points at the parent's id
    const parentKey = TABLES[e.table]?.fks[col]?.column ?? 'id'
    const ids = [...new Set(rows.map((r) => r[parentKey]).filter((v) => v != null))]
    const children: Row[] = []
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30)
      children.push(...(await this.fetchRows(e.table, [{ kind: 'cmp', col, op: 'in', value: chunk }])))
    }
    const projected = await this.project(e.table, children, { ...e.select, columns: [...e.select.columns] })
    const groups = new Map<string, Row[]>()
    children.forEach((c, i) => {
      const k = String(c[col])
      groups.set(k, [...(groups.get(k) ?? []), projected[i]])
    })
    return rows.map((r) => groups.get(String(r[parentKey])) ?? [])
  }

  // =========================================================================== writes

  async write<T>(fn: (ctx: WriteSession) => Promise<T>): Promise<T> {
    const me = await this.me()
    if (!me) throw new PermissionDenied('Not signed in')
    let touched = new Set<string>()
    const out = await this.store.transaction(async (tx) => {
      const s = new WriteSession(this, tx, me)
      const r = await fn(s)
      s.flush()
      touched = s.touched
      return r
    })
    this.onWrite(touched)
    return out
  }

  /**
   * Run an RPC. It first runs against plain (non-transactional) reads; if it queued no writes the result
   * is returned directly (works offline from the Firestore cache). Otherwise it is re-run in a transaction.
   */
  async rpc<T>(fn: (ctx: WriteSession) => Promise<T>): Promise<T> {
    const me = await this.me()
    if (!me) throw new PermissionDenied('Not signed in')
    const store = this.store
    const dry = new WriteSession(this, { get: (t, id) => store.get(t, id), set: () => undefined, delete: () => undefined }, me)
    const out = await fn(dry)
    if (dry.pending.size === 0) return out
    return this.write(fn)
  }

  async insert(table: string, rows: Row[], opts: { onConflict?: string[]; ignoreDuplicates?: boolean; upsert?: boolean } = {}) {
    // upsert on non-key columns: find existing rows first (outside the transaction)
    const existing = new Map<number, Row>()
    if (opts.upsert) {
      const pk = TABLES[table]?.pk ?? ['id']
      const conflict = opts.onConflict?.length ? opts.onConflict : pk
      await Promise.all(
        rows.map(async (r, i) => {
          if (conflict.some((c) => r[c] === undefined || r[c] === null)) return
          if (conflict.join() === pk.join()) {
            const hit = await this.getById(table, docIdOf(table, r))
            if (hit) existing.set(i, hit)
          } else {
            const hit = await this.fetchRows(
              table,
              conflict.map((c) => ({ kind: 'cmp' as const, col: c, op: 'eq' as const, value: r[c] })),
            )
            if (hit[0]) existing.set(i, hit[0])
          }
        }),
      )
    }
    return this.write(async (s) => {
      const out: Row[] = []
      for (let i = 0; i < rows.length; i++) {
        const hit = existing.get(i)
        if (hit) {
          if (opts.ignoreDuplicates) continue
          out.push(await s.update(table, docIdOf(table, hit), rows[i]))
        } else out.push(await s.insert(table, rows[i]))
      }
      return out
    })
  }

  async update(table: string, patch: Row, filters: Filter[]) {
    const targets = await this.fetchRows(table, filters)
    if (!targets.length) return []
    return this.write(async (s) => {
      const out: Row[] = []
      for (const t of targets) out.push(await s.update(table, docIdOf(table, t), patch))
      return out
    })
  }

  async delete(table: string, filters: Filter[]) {
    const targets = await this.fetchRows(table, filters)
    if (!targets.length) return []
    return this.write(async (s) => {
      for (const t of targets) await s.remove(table, docIdOf(table, t))
      return targets
    })
  }
}

// ============================================================================= write session

const SKIP_AUDIT_COMPARE = new Set(['updated_at', 'last_seen_at'])

export class WriteSession implements WriteCtx {
  pending = new Map<string, { table: string; id: string; row: Row | null }>()
  touched = new Set<string>()
  now = new Date().toISOString()
  today = todayStr()
  private depth = 0

  private engine: Engine
  private tx: StoreTx
  me: Me
  constructor(engine: Engine, tx: StoreTx, me: Me) {
    this.engine = engine
    this.tx = tx
    this.me = me
  }

  // ---- ReadCtx
  select(table: string, filters: Filter[] = [], opts: { select?: string } = {}) {
    return this.engine.select({ table, filters, select: opts.select })
  }
  getById(table: string, id: string) {
    return this.get(table, id)
  }

  fail(message: string, code = 'P0001'): never {
    throw new DbError(message, code)
  }

  async get(table: string, id: string): Promise<Row | null> {
    const key = `${table}/${id}`
    const p = this.pending.get(key)
    if (p) return clone(p.row)
    if (registry.view(table)) return this.engine.getById(table, id)
    try {
      return await this.tx.get(table, id)
    } catch (e) {
      if (isPermissionDenied(e)) return null
      throw e
    }
  }

  private put(table: string, id: string, row: Row | null) {
    this.pending.set(`${table}/${id}`, { table, id, row: row ? clone(row) : null })
    this.touched.add(table)
  }

  flush() {
    for (const { table, id, row } of this.pending.values()) {
      if (row) this.tx.set(table, id, row)
      else this.tx.delete(table, id)
    }
  }

  private guardDepth() {
    if (++this.depth > 50) throw new DbError('Trigger recursion limit reached', '54001')
  }

  private applyDefaults(table: string, row: Row) {
    const schema = TABLES[table]
    for (const [col, c] of Object.entries(schema.columns)) {
      if (row[col] !== undefined || c.generated) continue
      const d = c.default
      if (!d) row[col] = null
      else if (d.kind === 'uuid') row[col] = uuid()
      else if (d.kind === 'uid') row[col] = this.me.uid
      else if (d.kind === 'now') row[col] = this.now
      else if (d.kind === 'today') row[col] = this.today
      else if (d.kind === 'value') row[col] = clone(d.value)
      else row[col] = null
    }
    if (schema.columns.id?.identity && row.id == null) row.id = uuid()
  }

  /** Postgres coerced input types; Firestore stores what it is given, so coerce by column type. */
  private coerce(table: string, row: Row) {
    for (const [col, c] of Object.entries(TABLES[table].columns)) {
      const v = row[col]
      if (v === undefined || v === null) continue
      const t = c.type
      if (/^(int|bigint|smallint|numeric|real|double)/.test(t)) {
        if (v === '') row[col] = null
        else if (typeof v !== 'number') {
          const n = Number(v)
          if (Number.isNaN(n)) throw new DbError(`invalid input syntax for type numeric: "${v}" (column ${col})`, '22P02')
          row[col] = n
        }
        if (/^(int|bigint|smallint)$/.test(t) && typeof row[col] === 'number') row[col] = Math.trunc(row[col])
      } else if (t === 'boolean') {
        if (typeof v !== 'boolean') row[col] = v === 'true' || v === 't' || v === 1 || v === '1'
      } else if (t === 'date' || t === 'timestamptz' || t === 'uuid') {
        if (v === '') row[col] = null
        else if (t === 'date' && typeof v === 'string' && v.length > 10 && /^\d{4}-\d{2}-\d{2}T/.test(v)) row[col] = v.slice(0, 10)
      }
    }
  }

  private applyGenerated(table: string, row: Row) {
    for (const [col, fn] of Object.entries(registry.generated(table))) row[col] = fn(row)
  }

  private validate(table: string, row: Row) {
    for (const [col, c] of Object.entries(TABLES[table].columns)) {
      if (c.notNull && !c.generated && (row[col] === null || row[col] === undefined))
        throw new DbError(`null value in column "${col}" of relation "${table}" violates not-null constraint`, '23502')
    }
  }

  /** UNIQUE constraints other than the primary key (checked against what the caller can read). */
  private async checkUnique(table: string, id: string, row: Row, old: Row | null) {
    const pk = TABLES[table].pk.join()
    for (const cols of TABLES[table].uniques) {
      if (cols.join() === pk) continue
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue
      if (old && cols.every((c) => old[c] === row[c])) continue
      const hits = await this.engine.fetchRows(
        table,
        cols.map((c) => ({ kind: 'cmp' as const, col: c, op: 'eq' as const, value: row[c] })),
      )
      const pendingHit = [...this.pending.values()].some(
        (p) => p.table === table && p.id !== id && p.row && cols.every((c) => p.row![c] === row[c]),
      )
      if (pendingHit || hits.some((h) => docIdOf(table, h) !== id && this.pending.get(`${table}/${docIdOf(table, h)}`)?.row !== null))
        throw new DbError(`duplicate key value violates unique constraint "${table}_${cols.join('_')}_key"`, '23505', `Key (${cols.join(', ')}) already exists.`)
    }
  }

  private async audit(table: string, action: 'INSERT' | 'UPDATE' | 'DELETE', id: string, oldRow: Row | null, newRow: Row | null) {
    if (!registry.isAudited(table)) return
    if (action === 'UPDATE') {
      const strip = (r: Row) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !SKIP_AUDIT_COMPARE.has(k)).sort()))
      if (strip(oldRow!) === strip(newRow!)) return
    }
    const logId = uuid()
    this.put('audit_logs', logId, {
      id: logId,
      table_name: table,
      record_id: String(newRow?.id ?? oldRow?.id ?? id),
      action,
      old_data: oldRow,
      new_data: newRow,
      changed_by: this.me.uid,
      changed_at: this.now,
    })
  }

  async insert(table: string, input: Row): Promise<Row> {
    if (!TABLES[table]) throw new DbError(`Cannot insert into "${table}"`, '42809')
    this.guardDepth()
    const row: Row = clone(input)
    this.applyDefaults(table, row)
    this.coerce(table, row)
    for (const inh of registry.inherits(table)) {
      if (row[inh.via] == null) continue
      const parent = await this.get(inh.from, String(row[inh.via]))
      if (!parent) throw new DbError(`${inh.from} ${row[inh.via]} not found or not accessible`, '23503')
      for (const [k, pk] of Object.entries(inh.fields)) row[k] = parent[pk] ?? null
    }
    for (const h of registry.hooks(table)) await h.beforeInsert?.(row, this)
    this.coerce(table, row)
    this.applyGenerated(table, row)
    this.validate(table, row)
    const id = docIdOf(table, row)
    const exists = await this.get(table, id)
    if (exists) throw new DbError(`duplicate key value violates unique constraint "${table}_pkey"`, '23505')
    await this.checkUnique(table, id, row, null)
    this.put(table, id, row)
    await this.audit(table, 'INSERT', id, null, row)
    for (const h of registry.hooks(table)) await h.afterInsert?.(row, this)
    this.depth--
    return clone(row)
  }

  async update(table: string, id: string, patch: Row): Promise<Row> {
    if (!TABLES[table]) throw new DbError(`Cannot update "${table}"`, '42809')
    this.guardDepth()
    const old = await this.get(table, id)
    if (!old) throw new DbError(`${table} row ${id} not found or not accessible`, 'PGRST116')
    const row: Row = { ...old, ...clone(patch) }
    for (const [col, c] of Object.entries(TABLES[table].columns)) if (c.generated) row[col] = old[col]
    if ('updated_at' in TABLES[table].columns) row.updated_at = this.now
    for (const inh of registry.inherits(table)) {
      if (row[inh.via] === old[inh.via] || row[inh.via] == null) continue
      const parent = await this.get(inh.from, String(row[inh.via]))
      if (parent) for (const [k, pk] of Object.entries(inh.fields)) row[k] = parent[pk] ?? null
    }
    this.coerce(table, row)
    for (const h of registry.hooks(table)) await h.beforeUpdate?.(row, old, this)
    this.coerce(table, row)
    this.applyGenerated(table, row)
    this.validate(table, row)
    if (docIdOf(table, row) !== id) throw new DbError('Changing a primary key is not supported', '0A000')
    await this.checkUnique(table, id, row, old)
    this.put(table, id, row)
    await this.audit(table, 'UPDATE', id, old, row)
    for (const h of registry.hooks(table)) await h.afterUpdate?.(row, old, this)
    // keep denormalised copies in children in sync (e.g. project_id on boq_items)
    await this.propagateInherited(table, old, row)
    this.depth--
    return clone(row)
  }

  async remove(table: string, id: string): Promise<void> {
    this.guardDepth()
    const old = await this.get(table, id)
    if (!old) {
      this.depth--
      return
    }
    for (const h of registry.hooks(table)) await h.beforeDelete?.(old, this)
    // foreign keys pointing at this table
    for (const [child, schema] of Object.entries(TABLES)) {
      for (const [col, fk] of Object.entries(schema.fks)) {
        if (fk.table !== table) continue
        const refs = await this.engine.fetchRows(child, [{ kind: 'cmp', col, op: 'eq', value: old[fk.column] }])
        const live = []
        for (const r of refs) {
          const cur = await this.get(child, docIdOf(child, r))
          if (cur && cur[col] === old[fk.column]) live.push(cur)
        }
        if (!live.length) continue
        if (fk.onDelete === 'cascade') for (const r of live) await this.remove(child, docIdOf(child, r))
        else if (fk.onDelete === 'set null') for (const r of live) await this.update(child, docIdOf(child, r), { [col]: null })
        else
          throw new DbError(
            `update or delete on table "${table}" violates foreign key constraint on table "${child}"`,
            '23503',
            `Key is still referenced from table "${child}".`,
          )
      }
    }
    this.put(table, id, null)
    await this.audit(table, 'DELETE', id, old, null)
    for (const h of registry.hooks(table)) await h.afterDelete?.(old, this)
    this.depth--
  }

  private async propagateInherited(parent: string, old: Row, row: Row) {
    for (const [child] of Object.entries(TABLES)) {
      for (const inh of registry.inherits(child)) {
        if (inh.from !== parent) continue
        const changed = Object.entries(inh.fields).filter(([, pk]) => JSON.stringify(old[pk]) !== JSON.stringify(row[pk]))
        if (!changed.length) continue
        const kids = await this.engine.fetchRows(child, [{ kind: 'cmp', col: inh.via, op: 'eq', value: row.id }])
        for (const k of kids) {
          const patch: Row = {}
          for (const [ck, pk] of changed) patch[ck] = row[pk] ?? null
          await this.update(child, docIdOf(child, k), patch)
        }
      }
    }
  }

  // ---- helpers shared by domain hooks

  async nextNumber(seqKey: string): Promise<string> {
    const s = await this.get('numbering_sequences', seqKey)
    if (!s) throw new DbError(`Unknown numbering sequence ${seqKey}`)
    const n = Number(s.next_value) || 1
    this.put('numbering_sequences', seqKey, { ...s, next_value: n + 1 })
    const year = s.include_year ? `${new Date().getFullYear()}-` : ''
    return `${s.prefix}-${year}${String(n).padStart(Number(s.padding) || 4, '0')}`
  }

  async notificationEnabled(setting: string) {
    const cs = await this.get('company_settings', '1')
    const v = cs?.notification_settings?.[setting]
    return v === undefined || v === null ? true : v === true || v === 'true'
  }

  async notifyUser(userId: string | null | undefined, title: string, body: string | null, type: NotificationType, link: string | null) {
    if (!userId) return
    await this.insert('notifications', { user_id: userId, title, body, type, link })
  }

  async notifyPermission(perm: string, title: string, body: string | null, type: NotificationType, link: string | null) {
    const [roles, profiles] = await Promise.all([
      this.engine.fetchRows('roles', []),
      this.engine.fetchRows('profiles', [{ kind: 'cmp', col: 'is_active', op: 'eq', value: true }]),
    ])
    const ok = new Set(roles.filter((r) => r.key === 'super_admin' || (r.perms ?? []).includes(perm)).map((r) => r.id))
    for (const p of profiles) {
      if (p.id === this.me.uid || !ok.has(p.role_id)) continue
      await this.notifyUser(p.id, title, body, type, link)
    }
  }
}
