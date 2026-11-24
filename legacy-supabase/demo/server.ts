/**
 * In-browser demo backend.
 *
 * Emulates the subset of Supabase's HTTP APIs that ABCkit uses (PostgREST, GoTrue auth,
 * Storage, the admin-users Edge Function) on top of PGlite — real PostgreSQL compiled to
 * WebAssembly. The real migrations run unchanged, so Row Level Security, triggers,
 * approvals and calculations behave exactly as they will in production.
 * Data persists in this browser's IndexedDB only.
 */
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { createStore, del, get, keys, set } from 'idb-keyval'
import stubsSql from '../../tests/db/supabase-stubs.sql?raw'
import seedSql from '../../supabase/seed.sql?raw'
import { DEMO_ACCOUNTS, DEMO_PASSWORD, DEMO_URL } from './flag'

const DB_NAME = 'idb://abckit-demo-v1'
const SCHEMA_VERSION = 'v1'
const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const files = createStore('abckit-demo-files', 'files')

let db: PGlite
export const ready: Promise<void> = init()

// ----------------------------------------------------------------------------- catalog
interface Fk {
  name: string
  tbl: string
  cols: string[]
  ref: string
  refcols: string[]
}
let FKS: Fk[] = []
const PKS = new Map<string, string[]>()
const FUNCS = new Map<string, { retset: boolean; args: Array<{ name: string; type: string }> }>()

export type ProgressFn = (msg: string) => void
let progress: ProgressFn = () => undefined
export function onProgress(fn: ProgressFn) {
  progress = fn
}

async function init() {
  // browsers persist to IndexedDB; Node (tests) uses an in-memory database
  db = new PGlite({ dataDir: typeof window === 'undefined' ? undefined : DB_NAME, extensions: { pg_trgm, pgcrypto } })
  await db.waitReady
  const exists = await db.query<{ v: string | null }>(`select (select value from public.demo_meta where key = 'version') as v`).catch(() => ({ rows: [] as Array<{ v: string | null }> }))
  if (exists.rows[0]?.v !== SCHEMA_VERSION) {
    progress('Creating database…')
    // start from a clean slate (also recovers from an interrupted earlier setup)
    await db.exec(`drop schema if exists public cascade; drop schema if exists auth cascade; drop schema if exists storage cascade; create schema public;`)
    await db.exec(stubsSql)
    const names = Object.keys(migrations).sort()
    for (const [i, name] of names.entries()) {
      progress(`Applying migration ${i + 1} of ${names.length}…`)
      await db.exec(migrations[name])
    }
    progress('Loading sample data…')
    await db.exec(seedSql)
    await setupDemo()
    await db.exec(`create table public.demo_meta (key text primary key, value text); insert into public.demo_meta values ('version', '${SCHEMA_VERSION}');`)
  }
  progress('Starting…')
  await loadCatalog()
}

async function loadCatalog() {
  const fk = await db.query<Fk>(`
    select c.conname as name, cl.relname as tbl, rcl.relname as ref,
           array_agg(a.attname::text order by k.ord) as cols, array_agg(ra.attname::text order by k.ord) as refcols
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    join pg_class rcl on rcl.oid = c.confrelid
    join pg_namespace rn on rn.oid = rcl.relnamespace
    cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(attnum, refattnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = k.refattnum
    where c.contype = 'f' and n.nspname = 'public' and rn.nspname = 'public'
    group by c.conname, cl.relname, rcl.relname`)
  FKS = fk.rows
  const pk = await db.query<{ tbl: string; cols: string[] }>(`
    select cl.relname as tbl, array_agg(a.attname::text order by k.ord) as cols
    from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_namespace n on n.oid = cl.relnamespace
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'p' and n.nspname = 'public' group by cl.relname`)
  for (const r of pk.rows) PKS.set(r.tbl, r.cols)
  const fn = await db.query<{ name: string; retset: boolean; argnames: string[] | null; argtypes: string[] }>(`
    select p.proname as name, p.proretset as retset, p.proargnames as argnames,
           array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as argtypes
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)
  for (const r of fn.rows) FUNCS.set(r.name, { retset: r.retset, args: (r.argnames ?? []).slice(0, r.argtypes.length).map((n, i) => ({ name: n, type: r.argtypes[i] })) })
}

// ----------------------------------------------------------------------------- demo accounts & activity
async function setupDemo() {
  progress('Creating demo accounts…')
  const ids: Record<string, string> = {}
  for (const a of DEMO_ACCOUNTS) {
    const r = await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`, [a.email, a.name])
    ids[a.role] = r.rows[0].id
  }
  for (const a of DEMO_ACCOUNTS) {
    await db.query(`update public.profiles set is_active = true, job_title = $3, role_id = (select id from public.roles where key = $2) where id = $1`, [ids[a.role], a.role, a.label])
  }
  await db.exec(`
    update public.company_settings set address = 'P.O. Box 00000, Dar es Salaam, Tanzania (demo)', phone = '+255 700 000 000',
      email = 'info@aricom.example', tin = '000-000-000' where id = 1;
    update public.projects set project_manager_id = '${ids.project_manager}' where is_demo;
    insert into public.project_members (project_id, user_id, member_role)
      select id, '${ids.site_engineer}', 'site_engineer' from public.projects where is_demo and status = 'active';
    insert into public.project_members (project_id, user_id, member_role)
      select id, '${ids.employee}', 'member' from public.projects where is_demo and status = 'active';
    update public.employees set profile_id = '${ids.employee}' where full_name = '[DEMO] Juma Hamisi';
    update public.tasks set assigned_to = '${ids.site_engineer}' where is_demo and title not like '%IPC%';
    update public.tasks set assigned_to = '${ids.quantity_surveyor}' where is_demo and title like '%IPC%';
  `)
  // Activity performed as real users so approvals, notifications and the audit log look realistic
  const as = async (role: string, fn: (tx: Transaction) => Promise<unknown>) =>
    db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [ids[role]])
      await tx.exec(`set local role authenticated`)
      await fn(tx)
    })
  const p1 = (await db.query<{ id: string }>(`select id from projects where name like '[DEMO] 4-Storey%'`)).rows[0].id
  const cement = (await db.query<{ id: string }>(`select id from materials where name like '[DEMO] Portland%'`)).rows[0].id
  const work = [
    'Casting of first-floor slab panel B2–B4 (18 m³ C25). Curing of columns C1–C6 ongoing.',
    'Fixing reinforcement to first-floor beams grid 3–5. Formwork to stair flight 1.',
    'Blockwork ground floor west wing (approx. 85 m²). Backfilling around footings F7–F9.',
    'Columns C7–C12 cast to first-floor level. Scaffolding extended on north elevation.',
    'Setting out first-floor walls. Delivery and offloading of 200 bags cement and 6 t sand.',
  ]
  for (let i = 0; i < work.length; i++) {
    await as('site_engineer', (tx) =>
      tx.query(
        `insert into site_reports (project_id, engineer_id, report_date, weather, workers_count, labour, work_performed, materials_used, equipment_used, progress_percent, safety_observations, status, is_demo)
         values ($1, auth.uid(), current_date - $2::int, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, 'Toolbox talk held; PPE compliance good.', 'submitted', true)`,
        [
          p1, i + 1, ['sunny', 'cloudy', 'rainy', 'sunny', 'cloudy'][i], 30 + i * 2,
          JSON.stringify([{ trade: 'Mason', count: 8 + i }, { trade: 'Steel fixer', count: 6 }, { trade: 'Labourer', count: 16 + i }]),
          `[DEMO] ${work[i]}`,
          JSON.stringify([{ name: '[DEMO] Portland cement 42.5N (50 kg)', material_id: cement, quantity: 40 + i * 5, unit: 'bag' }]),
          JSON.stringify([{ name: '[DEMO] Concrete mixer 350L', hours: 6 }]),
          37 - i,
        ],
      ),
    )
  }
  // PM approves the older reports, leaving the most recent one waiting for approval
  await as('project_manager', (tx) => tx.query(`update site_reports set status = 'approved' where is_demo and report_date < current_date - 1`))
  await db.query(`update projects set progress = 38 where id = $1`, [p1])
  // a purchase request awaiting approval and a pending payment awaiting the accountant's colleague
  await as('site_engineer', async (tx) => {
    const r = await tx.query<{ id: string }>(`insert into purchase_requests (project_id, requested_by, needed_by, priority, justification, status, is_demo) values ($1, auth.uid(), current_date + 7, 'high', '[DEMO] Cement for first-floor slab', 'draft', true) returning id`, [p1])
    await tx.query(`insert into purchase_request_items (request_id, material_id, description, quantity, unit, estimated_rate) values ($1, $2, '[DEMO] Portland cement 42.5N', 300, 'bag', 17500)`, [r.rows[0].id, cement])
    await tx.query(`update purchase_requests set status = 'submitted' where id = $1`, [r.rows[0].id])
  })
  await as('accountant', (tx) =>
    tx.query(`insert into financial_transactions (project_id, direction, category, amount, payment_method, payee_payer, description, is_demo) values ($1, 'expense', 'subcontractor', 12500000, 'bank_transfer', '[DEMO] Sample Electrical Subcontractor', '[DEMO] Electrical first fix – valuation 1', true)`, [p1]),
  )
  await db.exec(`select public.notify_overdue_tasks();`)
}

export async function resetDemo() {
  try {
    await db?.close()
  } catch {
    /* ignore */
  }
  for (const k of await keys(files)) await del(k, files)
  const dbs = (await indexedDB.databases?.()) ?? []
  await Promise.all(
    dbs
      .filter((d) => d.name && d.name.includes('abckit-demo-v1'))
      .map((d) => new Promise((res) => {
        const req = indexedDB.deleteDatabase(d.name!)
        req.onsuccess = req.onerror = req.onblocked = () => res(null)
      })),
  )
  try {
    localStorage.removeItem('abckit-auth')
  } catch {
    /* ignore */
  }
  location.reload()
}

// ----------------------------------------------------------------------------- helpers
const IDENT = /^[a-z_][a-z0-9_]*$/
function ident(s: string) {
  if (!IDENT.test(s)) throw httpError(400, 'PGRST100', `Invalid identifier: ${s}`)
  return `"${s}"`
}
function httpError(status: number, code: string, message: string, details?: string) {
  return Object.assign(new Error(message), { status, code, details })
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === null || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}
function pgStatus(code?: string) {
  if (code === '42501') return 403
  if (code === '23505') return 409
  if (code === 'PGRST116') return 406
  return 400
}
function errorResponse(e: any) {
  const status = e.status ?? pgStatus(e.code)
  return json({ code: e.code ?? 'PGRST000', message: e.message ?? String(e), details: e.details ?? e.detail ?? null, hint: e.hint ?? null }, status)
}

function b64url(s: string) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64url(s: string) {
  return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))
}
function makeToken(userId: string, email: string) {
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600, session_id: crypto.randomUUID() }
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.demo`
}
function userFromAuthHeader(headers: Headers): string | null {
  const h = headers.get('Authorization') ?? ''
  const tok = h.replace(/^Bearer\s+/i, '')
  const parts = tok.split('.')
  if (parts.length !== 3) return null
  try {
    const p = JSON.parse(fromB64url(parts[1]))
    if (!p.sub || p.exp * 1000 < Date.now()) return null
    return p.sub
  } catch {
    return null
  }
}

async function asUser<T>(userId: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ''])
    await tx.exec(userId ? `set local role authenticated` : `set local role anon`)
    return fn(tx)
  })
}

// ----------------------------------------------------------------------------- PostgREST emulation
function splitTop(s: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0
  let quote = false
  let cur = ''
  for (const ch of s) {
    if (ch === '"') quote = !quote
    if (!quote) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === sep && depth === 0) {
        out.push(cur)
        cur = ''
        continue
      }
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function findRelation(source: string, target: string, hint?: string) {
  const cands = FKS.filter((f) => (f.tbl === source && f.ref === target) || (f.tbl === target && f.ref === source))
  const fk = hint ? cands.find((f) => f.name === hint) ?? FKS.find((f) => f.name === hint) : cands.find((f) => f.tbl === source && f.ref === target) ?? cands[0]
  if (!fk) throw httpError(400, 'PGRST200', `Could not find a relationship between '${source}' and '${target}'`)
  const manyToOne = fk.tbl === source && fk.ref === target
  return { fk, manyToOne }
}

let aliasSeq = 0
/** jsonb expression for one row of `table` (aliased `alias`) according to a PostgREST select string */
function objExpr(table: string, alias: string, select: string): string {
  const items = splitTop(select || '*')
  const parts: string[] = []
  const fields: string[] = []
  for (const raw of items) {
    const item = raw.trim()
    if (!item) continue
    if (item === '*') {
      parts.push(`to_jsonb(${alias})`)
      continue
    }
    const m = item.match(/^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)(?:!([a-z0-9_]+))?\(([\s\S]*)\)$/)
    if (m) {
      const [, as, target, hint, inner] = m
      const { fk, manyToOne } = findRelation(table, target, hint)
      const sub = `t${++aliasSeq}`
      let sql: string
      if (manyToOne) {
        const cond = fk.cols.map((c, i) => `${sub}.${ident(fk.refcols[i])} = ${alias}.${ident(c)}`).join(' and ')
        sql = `(select ${objExpr(target, sub, inner)} from public.${ident(target)} ${sub} where ${cond} limit 1)`
      } else {
        const cond = fk.cols.map((c, i) => `${sub}.${ident(c)} = ${alias}.${ident(fk.refcols[i])}`).join(' and ')
        sql = `(select coalesce(jsonb_agg(${objExpr(target, sub, inner)}), '[]'::jsonb) from public.${ident(target)} ${sub} where ${cond})`
      }
      fields.push(`'${as ?? target}', ${sql}`)
      continue
    }
    const col = item.match(/^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)$/)
    if (!col) throw httpError(400, 'PGRST100', `Unsupported select item: ${item}`)
    fields.push(`'${col[1] ?? col[2]}', ${alias}.${ident(col[2])}`)
  }
  // jsonb_build_object accepts at most 100 args — chunk to be safe
  for (let i = 0; i < fields.length; i += 40) parts.push(`jsonb_build_object(${fields.slice(i, i + 40).join(', ')})`)
  return parts.length ? parts.join(' || ') : `'{}'::jsonb`
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

function parseValueList(v: string) {
  return splitTop(v.replace(/^\(|\)$/g, '')).map((x) => x.replace(/^"|"$/g, ''))
}

function condition(alias: string, col: string, opExpr: string, params: unknown[]): string {
  let negate = false
  let rest = opExpr
  if (rest.startsWith('not.')) {
    negate = true
    rest = rest.slice(4)
  }
  const dot = rest.indexOf('.')
  const op = rest.slice(0, dot)
  const val = rest.slice(dot + 1)
  const c = `${alias}.${ident(col)}`
  const p = (v: unknown) => {
    params.push(v)
    return `$${params.length}::text`
  }
  let sql: string
  switch (op) {
    case 'eq':
      sql = `${c}::text = ${p(val)}`
      break
    case 'neq':
      sql = `${c}::text <> ${p(val)}`
      break
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]
      sql = /^-?\d+(\.\d+)?$/.test(val) ? `${c} ${sym} ${p(val)}::numeric` : `${c}::text ${sym} ${p(val)}`
      break
    }
    case 'like':
      sql = `${c}::text like ${p(val.replace(/\*/g, '%'))}`
      break
    case 'ilike':
      sql = `${c}::text ilike ${p(val.replace(/\*/g, '%'))}`
      break
    case 'is':
      sql = `${c} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : val === 'false' ? 'false' : 'unknown'}`
      break
    case 'in': {
      const vals = parseValueList(val)
      sql = vals.length ? `${c}::text in (${vals.map((v) => p(v)).join(', ')})` : 'false'
      break
    }
    default:
      throw httpError(400, 'PGRST100', `Unsupported operator ${op}`)
  }
  return negate ? `not (${sql})` : sql
}

function whereClause(alias: string, sp: URLSearchParams, params: unknown[]) {
  const conds: string[] = []
  for (const [key, value] of sp.entries()) {
    if (RESERVED.has(key)) continue
    if (key === 'or' || key === 'and') {
      const inner = splitTop(value.replace(/^\(|\)$/g, '')).map((part) => {
        const d = part.indexOf('.')
        return condition(alias, part.slice(0, d), part.slice(d + 1), params)
      })
      conds.push(`(${inner.join(key === 'or' ? ' or ' : ' and ')})`)
    } else {
      conds.push(condition(alias, key, value, params))
    }
  }
  return conds.length ? `where ${conds.join(' and ')}` : ''
}

function orderClause(alias: string, sp: URLSearchParams) {
  const o = sp.get('order')
  if (!o) return ''
  const parts = o.split(',').map((x) => {
    const [col, ...mods] = x.split('.')
    const dir = mods.includes('desc') ? 'desc' : 'asc'
    const nulls = mods.includes('nullsfirst') ? 'nulls first' : mods.includes('nullslast') ? 'nulls last' : ''
    return `${alias}.${ident(col)} ${dir} ${nulls}`
  })
  return `order by ${parts.join(', ')}`
}

async function handleRest(method: string, path: string, sp: URLSearchParams, headers: Headers, body: any, userId: string | null) {
  const accept = headers.get('Accept') ?? ''
  const prefer = headers.get('Prefer') ?? ''
  const single = accept.includes('vnd.pgrst.object')
  const wantCount = /count=exact/.test(prefer)
  const representation = /return=representation/.test(prefer)

  // RPC
  if (path.startsWith('rpc/')) {
    const name = path.slice(4)
    const fn = FUNCS.get(name)
    if (!fn) throw httpError(404, 'PGRST202', `Could not find the function public.${name}`)
    const params: unknown[] = []
    const args = Object.entries(body ?? {}).map(([k, v]) => {
      const a = fn.args.find((x) => x.name === k)
      if (!a) throw httpError(400, 'PGRST202', `Function ${name} has no argument ${k}`)
      if (v === null || v === undefined) return `${ident(k)} => null::${a.type}`
      params.push(typeof v === 'object' ? JSON.stringify(v) : String(v))
      return `${ident(k)} => $${params.length}::text::${a.type}`
    })
    const rows = await asUser(userId, async (tx) => (await tx.query<{ r: unknown }>(`select to_jsonb(r) as r from public.${ident(name)}(${args.join(', ')}) r`, params)).rows)
    const data = fn.retset ? rows.map((x) => x.r) : rows[0]?.r ?? null
    return json(data)
  }

  const table = path
  ident(table)
  const params: unknown[] = []
  const alias = 't0'
  const select = sp.get('select') ?? '*'

  if (method === 'GET' || method === 'HEAD') {
    const where = whereClause(alias, sp, params)
    const limit = sp.get('limit') ? `limit ${Number(sp.get('limit'))}` : ''
    const offset = sp.get('offset') ? `offset ${Number(sp.get('offset'))}` : ''
    return asUser(userId, async (tx) => {
      let total: number | null = null
      if (wantCount) total = Number((await tx.query<{ c: number }>(`select count(*)::int as c from public.${ident(table)} ${alias} ${where}`, params)).rows[0].c)
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Range': `*/${total ?? 0}` } })
      const rows = (await tx.query<{ r: unknown }>(`select ${objExpr(table, alias, select)} as r from public.${ident(table)} ${alias} ${where} ${orderClause(alias, sp)} ${limit} ${offset}`, params)).rows.map((x) => x.r)
      const range = { 'Content-Range': `${rows.length ? `0-${rows.length - 1}` : '*'}/${total ?? '*'}` }
      if (single) {
        if (rows.length !== 1) throw httpError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${rows.length} rows`)
        return json(rows[0], 200, range)
      }
      return json(rows, 200, range)
    })
  }

  const finish = (rows: unknown[], status: number) => {
    if (!representation) return new Response(null, { status: status === 201 ? 201 : 204 })
    if (single) {
      if (rows.length !== 1) throw httpError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${rows.length} rows`)
      return json(rows[0], status)
    }
    return json(rows, status)
  }

  if (method === 'POST') {
    const records = Array.isArray(body) ? body : [body]
    if (!records.length) return finish([], 201)
    const cols = [...new Set(records.flatMap((r) => Object.keys(r)))]
    cols.forEach(ident)
    params.push(JSON.stringify(records))
    const colList = cols.map(ident).join(', ')
    let conflict = ''
    if (/resolution=merge-duplicates|resolution=ignore-duplicates/.test(prefer)) {
      const target = (sp.get('on_conflict')?.split(',') ?? PKS.get(table) ?? ['id']).map((c) => ident(c.trim()))
      const updates = cols.filter((c) => !target.includes(ident(c))).map((c) => `${ident(c)} = excluded.${ident(c)}`)
      conflict = /ignore-duplicates/.test(prefer) || !updates.length ? `on conflict (${target.join(', ')}) do nothing` : `on conflict (${target.join(', ')}) do update set ${updates.join(', ')}`
    }
    const insert = `insert into public.${ident(table)} (${colList}) select ${colList} from jsonb_populate_recordset(null::public.${ident(table)}, $1::text::jsonb) ${conflict}`
    return asUser(userId, async (tx) => {
      if (!representation) {
        await tx.query(insert, params)
        return finish([], 201)
      }
      const rows = (await tx.query<{ r: unknown }>(`with m as (${insert} returning *) select ${objExpr(table, alias, select)} as r from m ${alias}`, params)).rows.map((x) => x.r)
      return finish(rows, 201)
    })
  }

  if (method === 'PATCH') {
    const cols = Object.keys(body ?? {})
    if (!cols.length) throw httpError(400, 'PGRST100', 'Empty update')
    params.push(JSON.stringify(body))
    const where = whereClause(alias, sp, params)
    const set = cols.map((c) => `${ident(c)} = s.${ident(c)}`).join(', ')
    const update = `update public.${ident(table)} ${alias} set ${set} from jsonb_populate_record(null::public.${ident(table)}, $1::text::jsonb) s ${where}`
    return asUser(userId, async (tx) => {
      if (!representation) {
        await tx.query(update, params)
        return finish([], 204)
      }
      const rows = (await tx.query<{ r: unknown }>(`with m as (${update} returning ${alias}.*) select ${objExpr(table, alias, select)} as r from m ${alias}`, params)).rows.map((x) => x.r)
      return finish(rows, 200)
    })
  }

  if (method === 'DELETE') {
    const where = whereClause(alias, sp, params)
    const del = `delete from public.${ident(table)} ${alias} ${where}`
    return asUser(userId, async (tx) => {
      if (!representation) {
        await tx.query(del, params)
        return finish([], 204)
      }
      const rows = (await tx.query<{ r: unknown }>(`with m as (${del} returning ${alias}.*) select ${objExpr(table, alias, select)} as r from m ${alias}`, params)).rows.map((x) => x.r)
      return finish(rows, 200)
    })
  }
  throw httpError(405, 'PGRST000', `Method ${method} not supported`)
}

// ----------------------------------------------------------------------------- Auth emulation
async function userJson(id: string) {
  const r = await db.query<any>(`select id, email, raw_user_meta_data, raw_app_meta_data, created_at from auth.users where id = $1`, [id])
  const u = r.rows[0]
  if (!u) return null
  return {
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.created_at,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'], ...(u.raw_app_meta_data ?? {}) },
    user_metadata: u.raw_user_meta_data ?? {},
    identities: [],
    created_at: u.created_at,
    updated_at: u.created_at,
    last_sign_in_at: new Date().toISOString(),
  }
}

async function session(id: string) {
  const user = await userJson(id)
  if (!user) throw Object.assign(new Error('User not found'), { status: 400 })
  const access = makeToken(id, user.email)
  return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `demo-refresh.${id}`, user }
}

const authErr = (status: number, code: string, msg: string) => json({ code: status, error_code: code, msg, error: code, error_description: msg, message: msg }, status)

async function handleAuth(method: string, path: string, sp: URLSearchParams, headers: Headers, body: any) {
  if (path === 'token' && sp.get('grant_type') === 'password') {
    const r = await db.query<{ id: string }>(`select id from auth.users where lower(email) = lower($1)`, [body?.email ?? ''])
    if (!r.rows[0] || body?.password !== DEMO_PASSWORD) return authErr(400, 'invalid_credentials', 'Invalid login credentials')
    return json(await session(r.rows[0].id))
  }
  if (path === 'token' && sp.get('grant_type') === 'refresh_token') {
    const id = String(body?.refresh_token ?? '').replace('demo-refresh.', '')
    try {
      return json(await session(id))
    } catch {
      return authErr(400, 'refresh_token_not_found', 'Invalid Refresh Token')
    }
  }
  if (path === 'user') {
    const id = userFromAuthHeader(headers)
    if (!id) return authErr(401, 'bad_jwt', 'Invalid or expired token')
    return json(await userJson(id))
  }
  if (path === 'logout') return new Response(null, { status: 204 })
  if (path === 'recover') return json({})
  if (path === 'settings') return json({ external: { email: true }, disable_signup: true })
  return authErr(404, 'not_found', `Auth endpoint ${method} /${path} is not available in demo mode`)
}

// ----------------------------------------------------------------------------- Storage emulation
const storageErr = (status: number, message: string) => json({ statusCode: String(status), error: 'Error', message }, status)

async function canRead(userId: string | null, bucket: string, name: string) {
  return asUser(userId, async (tx) => (await tx.query(`select 1 from storage.objects where bucket_id = $1 and name = $2`, [bucket, name])).rows.length > 0)
}

async function handleStorage(method: string, path: string, rawBody: BodyInit | null | undefined, userId: string | null) {
  let m = path.match(/^object\/sign\/([^/]+)\/(.+)$/)
  if (m && method === 'POST') {
    const [, bucket, name] = m
    const n = decodeURIComponent(name)
    if (!(await canRead(userId, bucket, n))) return storageErr(400, 'Object not found')
    return json({ signedURL: `/object/sign/${bucket}/${n}?token=demo` })
  }
  m = path.match(/^object\/sign\/([^/]+)$/)
  if (m && method === 'POST') {
    const bucket = m[1]
    const body = JSON.parse(String(rawBody ?? '{}'))
    const out = []
    for (const p of body.paths ?? []) {
      const ok = await canRead(userId, bucket, p)
      out.push({ path: p, error: ok ? null : 'Object not found', signedURL: ok ? `/object/sign/${bucket}/${p}?token=demo` : null })
    }
    return json(out)
  }
  m = path.match(/^object\/list\/([^/]+)$/)
  if (m && method === 'POST') {
    const bucket = m[1]
    const body = JSON.parse(String(rawBody ?? '{}'))
    const prefix = String(body.prefix ?? '').replace(/\/$/, '')
    const rows = await asUser(userId, async (tx) =>
      (await tx.query<any>(`select id, name, created_at from storage.objects where bucket_id = $1 and name like $2 order by created_at desc limit $3::int`, [bucket, `${prefix}/%`, String(body.limit ?? 100)])).rows,
    )
    return json(rows.map((r) => ({ id: r.id, name: String(r.name).slice(prefix.length + 1), created_at: r.created_at, updated_at: r.created_at, metadata: {} })))
  }
  m = path.match(/^object\/([^/]+)\/(.+)$/)
  if (m && (method === 'POST' || method === 'PUT')) {
    const [, bucket, name] = m
    const n = decodeURIComponent(name)
    let blob: Blob | null = null
    if (rawBody instanceof FormData) {
      for (const v of rawBody.values()) if (v instanceof Blob) blob = v
    } else if (rawBody instanceof Blob) blob = rawBody
    if (!blob) return storageErr(400, 'No file in request')
    const b = (await db.query<{ file_size_limit: number | null; allowed_mime_types: string[] | null }>(`select file_size_limit, allowed_mime_types from storage.buckets where id = $1`, [bucket])).rows[0]
    if (!b) return storageErr(404, 'Bucket not found')
    if (b.file_size_limit && blob.size > Number(b.file_size_limit)) return storageErr(413, 'The object exceeded the maximum allowed size')
    if (b.allowed_mime_types?.length && blob.type && !b.allowed_mime_types.includes(blob.type)) return storageErr(415, `mime type ${blob.type} is not supported`)
    try {
      const id = await asUser(userId, async (tx) => (await tx.query<{ id: string }>(`insert into storage.objects (bucket_id, name, owner) values ($1, $2, auth.uid()) returning id`, [bucket, n])).rows[0].id)
      await set(`${bucket}/${n}`, blob, files)
      return json({ Id: id, Key: `${bucket}/${n}` })
    } catch (e: any) {
      return storageErr(403, /row-level security/.test(e.message) ? 'new row violates row-level security policy' : e.message)
    }
  }
  return storageErr(404, `Storage endpoint ${method} /${path} is not available in demo mode`)
}

/** Converts a demo signed/public storage URL into a viewable blob: URL. Other URLs pass through. */
export async function demoViewableUrl(url: string): Promise<string> {
  const m = url.match(/\/storage\/v1\/object\/(?:sign|public)\/([^/]+)\/([^?]+)/)
  if (!m || !url.startsWith(DEMO_URL)) return url
  const blob = await get<Blob>(`${m[1]}/${decodeURI(m[2])}`, files)
  return blob ? URL.createObjectURL(blob) : url
}

// ----------------------------------------------------------------------------- Edge function emulation
async function handleFunction(name: string, body: any, userId: string | null) {
  if (name !== 'admin-users') return json({ error: `Function ${name} not found` }, 404)
  if (!userId) return json({ error: 'Not signed in' }, 401)
  const allowed = await asUser(userId, async (tx) => (await tx.query<{ v: boolean }>(`select public.has_permission('users.manage') as v`)).rows[0].v)
  if (!allowed) return json({ error: 'You do not have permission to manage users' }, 403)
  if (body?.action === 'invite') {
    const email = String(body.email ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Invalid email' }, 400)
    if ((await db.query(`select 1 from auth.users where lower(email) = $1`, [email])).rows.length) return json({ error: 'A user with this email address has already been registered' }, 400)
    const r = await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`, [email, String(body.full_name ?? '')])
    await db.query(`update public.profiles set is_active = true, full_name = $3, role_id = (select id from public.roles where key = $2) where id = $1`, [r.rows[0].id, body.role_key ?? 'employee', String(body.full_name ?? '')])
    return json({ ok: true, user_id: r.rows[0].id, note: `Demo: sign in with ${email} / ${DEMO_PASSWORD}` })
  }
  if (body?.action === 'set_active') {
    if (body.user_id === userId && !body.active) return json({ error: 'You cannot deactivate your own account' }, 400)
    try {
      await asUser(userId, (tx) => tx.query(`update public.profiles set is_active = $2::text::boolean where id = $1`, [body.user_id, String(!!body.active)]))
      return json({ ok: true })
    } catch (e: any) {
      return json({ error: e.message }, 400)
    }
  }
  return json({ error: 'Unknown action' }, 400)
}

// ----------------------------------------------------------------------------- entry point
export async function demoFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  await ready
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  const userId = userFromAuthHeader(headers)
  const rawBody = init.body
  const parseBody = () => {
    if (rawBody === undefined || rawBody === null || rawBody === '') return undefined
    if (typeof rawBody === 'string') return JSON.parse(rawBody)
    return rawBody
  }
  const path = url.pathname
  try {
    if (path.startsWith('/rest/v1/')) return await handleRest(method, decodeURIComponent(path.slice('/rest/v1/'.length)), url.searchParams, headers, parseBody(), userId)
    if (path.startsWith('/auth/v1/')) return await handleAuth(method, path.slice('/auth/v1/'.length), url.searchParams, headers, parseBody())
    if (path.startsWith('/storage/v1/')) return await handleStorage(method, decodeURIComponent(path.slice('/storage/v1/'.length)), rawBody, userId)
    if (path.startsWith('/functions/v1/')) return await handleFunction(path.slice('/functions/v1/'.length), parseBody(), userId)
    return json({ message: 'Not found' }, 404)
  } catch (e) {
    if (path.startsWith('/rest/v1/')) return errorResponse(e)
    return json({ message: (e as Error).message, error: (e as Error).message }, (e as any).status ?? 400)
  }
}
