/**
 * Chainable, awaitable query builder with the same surface as supabase-js / PostgREST
 * (from().select().eq().order()..., insert/update/upsert/delete, single/maybeSingle, count/head),
 * so the app's pages stay unchanged while the data lives in Firestore.
 */
import { DbError, type Engine, type OrderSpec } from './engine'
import { parseCondition, parseOr, type Filter, type Op } from './filters'
import { parseSelect } from './select'
import type { Row } from './registry'

export interface DbErrorShape {
  message: string
  code: string
  details: string | null
  hint: string | null
}

export interface DbResult<T = any> {
  data: T
  error: DbErrorShape | null
  count: number | null
  status: number
  statusText: string
}

export function toErrorShape(e: unknown): DbErrorShape {
  if (e instanceof DbError) return { message: e.message, code: e.code, details: e.details, hint: e.hint }
  const err = e as { message?: string; code?: string }
  const code = err?.code === 'permission-denied' ? '42501' : (err?.code ?? 'UNKNOWN')
  let message = err?.message ?? String(e)
  if (code === '42501' && !/permission/i.test(message)) message = `Permission denied: ${message}`
  return { message, code, details: null, hint: null }
}

type Action = 'select' | 'insert' | 'update' | 'delete' | 'upsert'

export class QueryBuilder<T = any[]> implements PromiseLike<DbResult<T>> {
  private action: Action = 'select'
  private columns = '*'
  private returning = false
  private filters: Filter[] = []
  private orders: OrderSpec[] = []
  private limitN?: number
  private offsetN?: number
  private mode: 'many' | 'single' | 'maybe' = 'many'
  private countMode: 'exact' | null = null
  private head = false
  private values: Row[] = []
  private patch: Row = {}
  private onConflict?: string[]
  private ignoreDuplicates = false

  private engine: Engine
  private table: string
  constructor(engine: Engine, table: string) {
    this.engine = engine
    this.table = table
  }

  // ---- actions
  select(columns = '*', opts: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean } = {}) {
    if (this.action === 'select') {
      this.columns = columns
      if (opts.count) this.countMode = 'exact'
      if (opts.head) this.head = true
    } else {
      this.returning = true
      this.columns = columns
    }
    return this
  }
  insert(values: Row | Row[], opts: { count?: string } = {}) {
    void opts
    this.action = 'insert'
    this.values = Array.isArray(values) ? values : [values]
    return this
  }
  upsert(values: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.action = 'upsert'
    this.values = Array.isArray(values) ? values : [values]
    this.onConflict = opts.onConflict?.split(',').map((s) => s.trim())
    this.ignoreDuplicates = !!opts.ignoreDuplicates
    return this
  }
  update(values: Row) {
    this.action = 'update'
    this.patch = values
    return this
  }
  delete() {
    this.action = 'delete'
    return this
  }

  // ---- filters
  private add(col: string, op: Op, value: unknown) {
    this.filters.push({ kind: 'cmp', col, op, value })
    return this
  }
  eq(col: string, v: unknown) {
    return this.add(col, 'eq', v)
  }
  neq(col: string, v: unknown) {
    return this.add(col, 'neq', v)
  }
  gt(col: string, v: unknown) {
    return this.add(col, 'gt', v)
  }
  gte(col: string, v: unknown) {
    return this.add(col, 'gte', v)
  }
  lt(col: string, v: unknown) {
    return this.add(col, 'lt', v)
  }
  lte(col: string, v: unknown) {
    return this.add(col, 'lte', v)
  }
  like(col: string, v: string) {
    return this.add(col, 'like', v)
  }
  ilike(col: string, v: string) {
    return this.add(col, 'ilike', v)
  }
  is(col: string, v: null | boolean) {
    return this.add(col, 'is', v)
  }
  in(col: string, v: readonly unknown[]) {
    return this.add(col, 'in', [...v])
  }
  contains(col: string, v: unknown) {
    return this.add(col, 'cs', v)
  }
  match(obj: Row) {
    for (const [k, v] of Object.entries(obj)) this.add(k, 'eq', v)
    return this
  }
  not(col: string, op: string, v: unknown) {
    const f = parseCondition(`${col}.${op}.${Array.isArray(v) ? `(${v.join(',')})` : String(v)}`)
    this.filters.push({ ...f, negate: !f.negate })
    return this
  }
  or(text: string) {
    this.filters.push(parseOr(text))
    return this
  }
  filter(col: string, op: string, v: unknown) {
    this.filters.push(parseCondition(`${col}.${op}.${String(v)}`))
    return this
  }

  // ---- modifiers
  order(column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    this.orders.push({ column, ascending: opts.ascending ?? true, nullsFirst: opts.nullsFirst })
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  range(from: number, to: number) {
    this.offsetN = from
    this.limitN = to - from + 1
    return this
  }
  single() {
    this.mode = 'single'
    return this as unknown as QueryBuilder<any>
  }
  maybeSingle() {
    this.mode = 'maybe'
    return this as unknown as QueryBuilder<any>
  }
  abortSignal(_s: AbortSignal) {
    return this
  }
  returns<U>() {
    return this as unknown as QueryBuilder<U>
  }
  throwOnError() {
    return this
  }

  private async run(): Promise<{ rows: Row[] | null; count: number | null }> {
    const e = this.engine
    switch (this.action) {
      case 'select': {
        const rows = await e.select({
          table: this.table,
          select: this.columns,
          filters: this.filters,
          order: this.orders,
          limit: this.limitN,
          offset: this.offsetN,
        })
        return { rows: this.head ? null : rows, count: this.countMode ? rows.length : null }
      }
      case 'insert':
      case 'upsert': {
        const rows = await e.insert(this.table, this.values, {
          upsert: this.action === 'upsert',
          onConflict: this.onConflict,
          ignoreDuplicates: this.ignoreDuplicates,
        })
        return { rows: this.returning ? await e.project(this.table, rows, parseSelect(this.columns)) : null, count: null }
      }
      case 'update': {
        const rows = await e.update(this.table, this.patch, this.filters)
        return { rows: this.returning ? await e.project(this.table, rows, parseSelect(this.columns)) : null, count: null }
      }
      case 'delete': {
        const rows = await e.delete(this.table, this.filters)
        return { rows: this.returning ? await e.project(this.table, rows, parseSelect(this.columns)) : null, count: null }
      }
    }
  }

  async execute(): Promise<DbResult<T>> {
    try {
      const { rows, count } = await this.run()
      let data: unknown = rows
      if (this.mode !== 'many' && rows) {
        if (rows.length > 1 || (this.mode === 'single' && rows.length === 0)) {
          return {
            data: null as T,
            error: {
              message: 'JSON object requested, multiple (or no) rows returned',
              code: 'PGRST116',
              details: `The result contains ${rows.length} rows`,
              hint: null,
            },
            count,
            status: 406,
            statusText: 'Not Acceptable',
          }
        }
        data = rows[0] ?? null
      }
      return { data: data as T, error: null, count, status: 200, statusText: 'OK' }
    } catch (err) {
      const shaped = toErrorShape(err)
      if (shaped.code === 'UNKNOWN' || !(err instanceof DbError)) console.error(`[db] ${this.action} ${this.table}`, err)
      return { data: null as T, error: shaped, count: null, status: 400, statusText: 'Error' }
    }
  }

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}
