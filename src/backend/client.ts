/**
 * The `db` client used by the whole app. Same call shapes as the supabase-js client it replaces:
 *   db.from(table)..., db.rpc(fn, args), db.auth.*, db.storage.from(bucket).*, db.functions.invoke(),
 *   db.channel(...).on('postgres_changes', ...).subscribe(), db.removeChannel(ch)
 */
import { DbError, Engine } from './engine'
import { parseCondition } from './filters'
import { QueryBuilder, toErrorShape, type DbResult } from './query'
import { registry, type Me } from './registry'
import { ACCESS_TABLES, createMeCache, type AuthUser } from './session'
import type { Store } from './store'
import './domains'

export interface FunctionsApi {
  invoke(name: string, opts?: { body?: unknown }): Promise<{ data: any; error: any }>
}

export interface DbOptions<A, S, F> {
  store: Store
  currentUser: () => AuthUser | null
  auth?: A
  storage?: S
  functions?: F
}

type ChangeHandler = (payload: { eventType: 'INSERT'; new: any; old: null; table: string }) => void

export function createDb<A = Record<string, never>, S = Record<string, never>, F extends FunctionsApi = FunctionsApi>(opts: DbOptions<A, S, F>) {
  const me = createMeCache(opts.store, opts.currentUser)
  const listeners = new Set<() => void>()
  const engine = new Engine(
    opts.store,
    () => me.get(),
    (tables) => {
      if ([...tables].some((t) => ACCESS_TABLES.has(t))) me.invalidate()
      listeners.forEach((l) => l())
    },
  )

  function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): PromiseLike<DbResult<T>> {
    const run = async (): Promise<DbResult<T>> => {
      const impl = registry.rpc(fn)
      try {
        if (!impl) throw new DbError(`Could not find the function public.${fn}`, 'PGRST202')
        const data = await engine.rpc((ctx) => impl(args, ctx) as Promise<T>)
        return { data, error: null, count: null, status: 200, statusText: 'OK' }
      } catch (e) {
        if (!(e instanceof DbError)) console.error(`[db] rpc ${fn}`, e)
        return { data: null as T, error: toErrorShape(e), count: null, status: 400, statusText: 'Error' }
      }
    }
    return { then: (a, b) => run().then(a, b) }
  }

  function channel(name: string) {
    const subs: Array<{ table: string; filter?: string; cb: ChangeHandler }> = []
    const offs: Array<() => void> = []
    const ch = {
      name,
      on(_type: 'postgres_changes', cfg: { event: string; schema?: string; table: string; filter?: string }, cb: ChangeHandler) {
        subs.push({ table: cfg.table, filter: cfg.filter, cb })
        return ch
      },
      subscribe(status?: (s: string) => void) {
        for (const s of subs) {
          const eqs = []
          if (s.filter) {
            const [col, rest] = s.filter.split('=')
            const f = parseCondition(`${col}.${rest}`)
            if (f.kind === 'cmp' && f.op === 'eq') eqs.push({ field: f.col, value: f.value })
          }
          offs.push(opts.store.listen(s.table, eqs, (rows) => rows.forEach((r) => s.cb({ eventType: 'INSERT', new: r, old: null, table: s.table }))))
        }
        status?.('SUBSCRIBED')
        return ch
      },
      unsubscribe() {
        offs.splice(0).forEach((o) => o())
        return Promise.resolve('ok')
      },
    }
    return ch
  }

  return {
    engine,
    from: <T = any>(table: string) => new QueryBuilder<T[]>(engine, table),
    rpc,
    channel,
    removeChannel: (ch: { unsubscribe(): Promise<unknown> }) => ch.unsubscribe(),
    auth: (opts.auth ?? {}) as A,
    storage: (opts.storage ?? {}) as S,
    functions: (opts.functions ?? { invoke: async () => ({ data: null, error: { message: 'Cloud Functions are not configured' } }) }) as F,
    /** current caller (profile, role, permissions, accessible projects) */
    me: (): Promise<Me | null> => me.get(),
    invalidateMe: () => me.invalidate(),
    /** notified after every committed write */
    onWrite(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
  }
}

