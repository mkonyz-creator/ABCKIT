/**
 * Storage adapter. Production uses Firestore (firestoreStore.ts); tests use the in-memory store below.
 * One Firestore collection per table; document id = primary key (composite keys joined with "__").
 */
import type { Row } from './registry'

/** Placeholder replaced by the server's clock when written (Firestore serverTimestamp). */
export const SERVER_TIME = '__server_time__'

/** Replace SERVER_TIME placeholders (nested) using `make`. */
export function resolveServerTime<T>(v: T, make: () => unknown): T {
  if (v === (SERVER_TIME as unknown)) return make() as T
  if (Array.isArray(v)) return v.map((x) => resolveServerTime(x, make)) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveServerTime(x, make)])) as T
  return v
}

export interface StoreEq {
  field: string
  value: unknown
  /** 'in' when value is an array of up to 30 values */
  op?: '==' | 'in'
}

export interface StoreQueryOpts {
  orderBy?: { field: string; ascending: boolean }
  limit?: number
}

export interface StoreTx {
  get(table: string, id: string): Promise<Row | null>
  set(table: string, id: string, row: Row): void
  delete(table: string, id: string): void
}

export interface Store {
  query(table: string, eqs: StoreEq[], opts?: StoreQueryOpts): Promise<Row[]>
  get(table: string, id: string): Promise<Row | null>
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  /** realtime: calls back with rows added after subscription */
  listen(table: string, eqs: StoreEq[], onAdded: (rows: Row[]) => void): () => void
}

export class PermissionDenied extends Error {
  code = '42501'
  constructor(message = 'Permission denied') {
    super(message)
  }
}

export function isPermissionDenied(e: unknown) {
  return e instanceof PermissionDenied || (e as { code?: string })?.code === 'permission-denied' || (e as { code?: string })?.code === '42501'
}

// ----------------------------------------------------------------------------- in-memory (tests)

const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)))

export class MemoryStore implements Store {
  data = new Map<string, Map<string, Row>>()
  private listeners = new Set<{ table: string; eqs: StoreEq[]; cb: (rows: Row[]) => void }>()

  private col(t: string) {
    let c = this.data.get(t)
    if (!c) this.data.set(t, (c = new Map()))
    return c
  }

  private static match(row: Row, eqs: StoreEq[]) {
    return eqs.every((e) =>
      e.op === 'in' ? (e.value as unknown[]).some((v) => row[e.field] === v) : (row[e.field] ?? null) === (e.value ?? null),
    )
  }

  async query(table: string, eqs: StoreEq[], opts: StoreQueryOpts = {}) {
    let rows = [...this.col(table).values()].filter((r) => MemoryStore.match(r, eqs)).map(clone)
    if (opts.orderBy) {
      const { field, ascending } = opts.orderBy
      rows.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (ascending ? 1 : -1))
    }
    if (opts.limit) rows = rows.slice(0, opts.limit)
    return rows
  }

  async get(table: string, id: string) {
    return clone(this.col(table).get(id) ?? null)
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>) {
    const writes: Array<() => void> = []
    const added: Array<[string, Row]> = []
    const tx: StoreTx = {
      get: (t, id) => this.get(t, id),
      set: (t, id, row) =>
        writes.push(() => {
          const r = resolveServerTime(clone(row), () => new Date().toISOString())
          if (!this.col(t).has(id)) added.push([t, r])
          this.col(t).set(id, r)
        }),
      delete: (t, id) => writes.push(() => this.col(t).delete(id)),
    }
    const out = await fn(tx)
    writes.forEach((w) => w())
    for (const l of this.listeners) {
      const rows = added.filter(([t, r]) => t === l.table && MemoryStore.match(r, l.eqs)).map(([, r]) => clone(r))
      if (rows.length) l.cb(rows)
    }
    return out
  }

  listen(table: string, eqs: StoreEq[], cb: (rows: Row[]) => void) {
    const l = { table, eqs, cb }
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
}
