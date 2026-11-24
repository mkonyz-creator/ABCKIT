import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { db, unwrap, viewableUrl } from './backend'
import { errorMessage } from './utils'

export type Eq = Record<string, string | number | boolean | null | undefined>

export interface ListOptions {
  select?: string
  eq?: Eq
  order?: { column: string; ascending?: boolean }
  limit?: number
  enabled?: boolean
  /** extra key parts for cache separation */
  keyExtra?: unknown
}

/** Generic list query against a table or view; RLS decides what the caller sees. */
export function useList<T = any>(table: string, opts: ListOptions = {}) {
  const { select = '*', eq, order, limit = 2000, enabled = true, keyExtra } = opts
  return useQuery({
    queryKey: [table, 'list', select, eq ?? null, order ?? null, limit, keyExtra ?? null],
    enabled,
    queryFn: async () => {
      let q = db.from(table).select(select)
      for (const [k, v] of Object.entries(eq ?? {})) {
        if (v === undefined) continue
        q = v === null ? q.is(k, null) : q.eq(k, v)
      }
      if (order) q = q.order(order.column, { ascending: order.ascending ?? true, nullsFirst: false })
      q = q.limit(limit)
      return unwrap(await q) as T[]
    },
  })
}

export function useRecord<T = any>(table: string, id: string | undefined, select = '*') {
  return useQuery({
    queryKey: [table, 'one', id, select],
    enabled: !!id,
    queryFn: async () => unwrap(await db.from(table).select(select).eq('id', id!).single()) as T,
  })
}

/** Invalidate every cached query for the given tables (and dashboards). */
export function useInvalidate() {
  const qc = useQueryClient()
  return (...tables: string[]) =>
    Promise.all([
      ...tables.map((t) => qc.invalidateQueries({ queryKey: [t] })),
      qc.invalidateQueries({ queryKey: ['dashboard'] }),
      qc.invalidateQueries({ queryKey: ['notifications'] }),
    ])
}

interface SaveArgs {
  id?: string
  values: Record<string, unknown>
}

export function useSave(table: string, opts: { invalidate?: string[]; successMessage?: string; silent?: boolean } = {}) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({ id, values }: SaveArgs) => {
      if (id) return unwrap(await db.from(table).update(values).eq('id', id).select().single())
      return unwrap(await db.from(table).insert(values).select().single())
    },
    onSuccess: async () => {
      await invalidate(table, ...(opts.invalidate ?? []))
      if (!opts.silent) toast.success(opts.successMessage ?? 'Saved')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

export function useRemove(table: string, opts: { invalidate?: string[] } = {}) {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) => unwrap(await db.from(table).delete().eq('id', id)),
    onSuccess: async () => {
      await invalidate(table, ...(opts.invalidate ?? []))
      toast.success('Deleted')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

export function useRpc<T = any>(fn: string, args: Record<string, unknown> = {}, opts: { enabled?: boolean; key?: QueryKey } = {}) {
  return useQuery({
    queryKey: opts.key ?? ['rpc', fn, args],
    enabled: opts.enabled ?? true,
    queryFn: async () => unwrap(await db.rpc(fn, args)) as T,
  })
}

/** Signed URL for a private storage object (cached ~50 min). */
export function useSignedUrl(bucket: string, path: string | null | undefined) {
  return useQuery({
    queryKey: ['signed', bucket, path],
    enabled: !!path,
    staleTime: 50 * 60_000,
    queryFn: async () => {
      const { data, error } = await db.storage.from(bucket).createSignedUrl(path!, 3600)
      if (error) throw error
      return viewableUrl(data.signedUrl)
    },
  })
}

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Common option lists used across forms */
export function useProjectOptions(includeArchived = false) {
  const q = useList<{ id: string; name: string; code: string; is_archived: boolean; status: string }>('projects', {
    select: 'id,name,code,is_archived,status',
    order: { column: 'name' },
  })
  return {
    ...q,
    options: (q.data ?? [])
      .filter((p) => includeArchived || !p.is_archived)
      .map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` })),
  }
}

export function useProfileOptions() {
  const q = useList<{ id: string; full_name: string; is_active: boolean; role: { name: string } | null }>('profiles', {
    select: 'id,full_name,is_active,role:roles(name)',
    order: { column: 'full_name' },
  })
  return {
    ...q,
    options: (q.data ?? []).filter((p) => p.is_active).map((p) => ({ value: p.id, label: `${p.full_name}${p.role ? ` (${p.role.name})` : ''}` })),
  }
}
