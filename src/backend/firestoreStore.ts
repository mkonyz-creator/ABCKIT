import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  onSnapshot,
  orderBy as fsOrderBy,
  query as fsQuery,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type Firestore,
  type QueryConstraint,
} from 'firebase/firestore'
import type { Row } from './registry'
import { PermissionDenied, resolveServerTime, SERVER_TIME, type Store, type StoreEq, type StoreQueryOpts, type StoreTx } from './store'

function mapError(e: unknown): never {
  const code = (e as { code?: string })?.code
  if (code === 'permission-denied') throw new PermissionDenied('Permission denied: your role does not allow this action')
  throw e
}

/** Firestore cannot store `undefined`; SERVER_TIME becomes the server's timestamp. */
function clean(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v === SERVER_TIME ? serverTimestamp() : resolveServerTime(v, () => new Date().toISOString())
  return out
}

/** Firestore Timestamps (from serverTimestamp) are returned as ISO strings, like every other timestamp. */
function fromDoc(data: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(data)) out[k] = v instanceof Timestamp ? v.toDate().toISOString() : v
  return out
}

export class FirestoreStore implements Store {
  private fs: Firestore
  constructor(fs: Firestore) {
    this.fs = fs
  }

  private constraints(eqs: StoreEq[], opts: StoreQueryOpts = {}) {
    const c: QueryConstraint[] = eqs.map((e) => where(e.field, e.op === 'in' ? 'in' : '==', e.value ?? null))
    if (opts.orderBy) c.push(fsOrderBy(opts.orderBy.field, opts.orderBy.ascending ? 'asc' : 'desc'))
    if (opts.limit) c.push(fsLimit(opts.limit))
    return c
  }

  async query(table: string, eqs: StoreEq[], opts?: StoreQueryOpts) {
    try {
      const snap = await getDocs(fsQuery(collection(this.fs, table), ...this.constraints(eqs, opts)))
      return snap.docs.map((d) => fromDoc(d.data()))
    } catch (e) {
      mapError(e)
    }
  }

  async get(table: string, id: string) {
    try {
      const snap = await getDoc(doc(this.fs, table, id))
      return snap.exists() ? fromDoc(snap.data()) : null
    } catch (e) {
      mapError(e)
    }
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>) {
    try {
      return await runTransaction(this.fs, async (t) => {
        // Firestore requires every read before the first write: buffer writes and flush at the end.
        const writes: Array<() => void> = []
        const tx: StoreTx = {
          get: async (table, id) => {
            const s = await t.get(doc(this.fs, table, id))
            return s.exists() ? fromDoc(s.data()) : null
          },
          set: (table, id, row) => writes.push(() => t.set(doc(this.fs, table, id), clean(row))),
          delete: (table, id) => writes.push(() => t.delete(doc(this.fs, table, id))),
        }
        const out = await fn(tx)
        writes.forEach((w) => w())
        return out
      })
    } catch (e) {
      mapError(e)
    }
  }

  listen(table: string, eqs: StoreEq[], onAdded: (rows: Row[]) => void) {
    let first = true
    return onSnapshot(
      fsQuery(collection(this.fs, table), ...this.constraints(eqs)),
      (snap) => {
        if (first) {
          first = false
          return
        }
        const rows = snap
          .docChanges()
          .filter((c) => c.type === 'added')
          .map((c) => fromDoc(c.doc.data()))
        if (rows.length) onAdded(rows)
      },
      () => undefined,
    )
  }
}
