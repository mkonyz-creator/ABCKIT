/** Minimal in-memory Firestore for unit tests (only the API surface the functions use). */
import type { Db } from '../lib/admin.js'

type Data = Record<string, any>
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

function setPath(obj: Data, path: string, value: unknown) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
}

class Snap {
  constructor(
    readonly id: string,
    private readonly value: Data | undefined,
    readonly ref: DocRef,
  ) {}
  get exists() {
    return this.value !== undefined
  }
  data() {
    return clone(this.value)
  }
}

class DocRef {
  constructor(
    readonly db: FakeDb,
    readonly path: string,
  ) {}
  get id() {
    return this.path.split('/').pop()!
  }
  private get col() {
    return this.path.split('/').slice(0, -1).join('/')
  }
  async get() {
    return new Snap(this.id, this.db.raw(this.col).get(this.id), this)
  }
  async set(data: Data, opts?: { merge?: boolean }) {
    const m = this.db.raw(this.col)
    m.set(this.id, opts?.merge ? { ...(m.get(this.id) ?? {}), ...clone(data) } : clone(data))
  }
  async create(data: Data) {
    if (this.db.raw(this.col).has(this.id)) throw new Error('ALREADY_EXISTS')
    await this.set(data)
  }
  async update(patch: Data) {
    const m = this.db.raw(this.col)
    const cur = m.get(this.id)
    if (!cur) throw new Error(`NOT_FOUND: ${this.path}`)
    const next = clone(cur)
    for (const [k, v] of Object.entries(patch)) setPath(next, k, clone(v))
    m.set(this.id, next)
  }
  async delete() {
    this.db.raw(this.col).delete(this.id)
  }
}

type Filter = { field: string; op: string; value: any }

const getField = (d: Data, f: string) => f.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), d)

class Query {
  constructor(
    readonly db: FakeDb,
    readonly name: string,
    private readonly filters: Filter[] = [],
    private readonly order: { field: string; dir: 'asc' | 'desc' } | null = null,
    private readonly max: number | null = null,
  ) {}
  where(field: string, op: string, value: any) {
    return new Query(this.db, this.name, [...this.filters, { field, op, value }], this.order, this.max)
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return new Query(this.db, this.name, this.filters, { field, dir }, this.max)
  }
  limit(n: number) {
    return new Query(this.db, this.name, this.filters, this.order, n)
  }
  select() {
    return this
  }
  doc(id?: string) {
    return new DocRef(this.db, `${this.name}/${id ?? Math.random().toString(36).slice(2)}`)
  }
  private match(d: Data) {
    return this.filters.every(({ field, op, value }) => {
      const v = getField(d, field)
      switch (op) {
        case '==':
          return v === value
        case '!=':
          return v !== value
        case 'in':
          return (value as any[]).includes(v)
        case '>=':
          return v !== undefined && v >= value
        case '>':
          return v !== undefined && v > value
        case '<=':
          return v !== undefined && v <= value
        case '<':
          return v !== undefined && v < value
        default:
          throw new Error(`op ${op} not supported`)
      }
    })
  }
  async get() {
    let entries = [...this.db.raw(this.name).entries()].filter(([, d]) => this.match(d))
    if (this.order) {
      const { field, dir } = this.order
      entries.sort(([, a], [, b]) => (getField(a, field) < getField(b, field) ? -1 : getField(a, field) > getField(b, field) ? 1 : 0) * (dir === 'asc' ? 1 : -1))
    }
    if (this.max !== null) entries = entries.slice(0, this.max)
    const docs = entries.map(([id, d]) => new Snap(id, d, new DocRef(this.db, `${this.name}/${id}`)))
    return { docs, size: docs.length, empty: docs.length === 0 }
  }
  count() {
    return {
      get: async () => {
        const n = (await this.get()).size
        return { data: () => ({ count: n }) }
      },
    }
  }
}

class Batch {
  private ops: Array<() => Promise<void>> = []
  set(ref: DocRef, data: Data, opts?: { merge?: boolean }) {
    this.ops.push(() => ref.set(data, opts))
    return this
  }
  update(ref: DocRef, patch: Data) {
    this.ops.push(() => ref.update(patch))
    return this
  }
  delete(ref: DocRef) {
    this.ops.push(() => ref.delete())
    return this
  }
  async commit() {
    for (const op of this.ops) await op()
  }
}

export class FakeDb {
  private store = new Map<string, Map<string, Data>>()
  raw(col: string) {
    if (!this.store.has(col)) this.store.set(col, new Map())
    return this.store.get(col)!
  }
  /** test helper: seed rows (id from row.id) */
  seed(col: string, rows: Data[]) {
    for (const r of rows) this.raw(col).set(String(r.id), clone(r))
    return this
  }
  all(col: string): Data[] {
    return [...this.raw(col).values()].map(clone)
  }
  get(col: string, id: string): Data | undefined {
    return clone(this.raw(col).get(id))
  }
  doc(path: string) {
    return new DocRef(this, path)
  }
  collection(name: string) {
    return new Query(this, name)
  }
  batch() {
    return new Batch()
  }
  async getAll(...refs: DocRef[]) {
    return Promise.all(refs.map((r) => r.get()))
  }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: (r: DocRef | Query) => r.get(),
      set: (r: DocRef, d: Data, o?: { merge?: boolean }) => void r.set(d, o),
      update: (r: DocRef, p: Data) => void r.update(p),
      delete: (r: DocRef) => void r.delete(),
      create: (r: DocRef, d: Data) => void r.create(d),
    }
    return fn(tx)
  }
  asDb(): Db {
    return this as unknown as Db
  }
}

/** profile + role helpers */
export function seedUser(db: FakeDb, uid: string, perms: string[], opts: { active?: boolean; roleKey?: string; name?: string } = {}) {
  const roleId = opts.roleKey ?? `role_${uid}`
  db.seed('roles', [{ id: roleId, key: opts.roleKey ?? roleId, name: roleId, perms }])
  db.seed('profiles', [{ id: uid, full_name: opts.name ?? `User ${uid}`, email: `${uid}@example.com`, role_id: roleId, is_active: opts.active ?? true }])
}
