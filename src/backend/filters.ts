/**
 * PostgREST-style filters evaluated in JavaScript.
 * Equality filters are also pushed down to Firestore (see engine.ts); everything is re-checked here.
 */
export type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in' | 'cs'

export type Filter =
  | { kind: 'cmp'; col: string; op: Op; value: unknown; negate?: boolean }
  | { kind: 'or'; filters: Filter[]; negate?: boolean }
  | { kind: 'and'; filters: Filter[]; negate?: boolean }

export function cmp(col: string, op: Op, value: unknown): Filter {
  return { kind: 'cmp', col, op, value }
}

/** Read a possibly-nested value ("a.b" for embedded objects / json). */
export function getPath(row: Record<string, any>, path: string): any {
  if (!path.includes('.') && !path.includes('->')) return row[path]
  return path.split(/\.|->>?/).reduce<any>((o, k) => (o == null ? undefined : o[k]), row)
}

function isNum(v: unknown) {
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim()))
}

function compare(a: any, b: any): number {
  if (isNum(a) && isNum(b)) return Number(a) - Number(b)
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a === true || a === 'true') - Number(b === true || b === 'true')
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function likeToRegex(pattern: string, insensitive: boolean) {
  // PostgREST accepts * as well as % as wildcard
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*').replace(/_/g, '.')
  return new RegExp(`^${esc}$`, insensitive ? 'is' : 's')
}

function eqValue(a: any, b: any) {
  if (a == null || b == null) return false // SQL: NULL = x is never true
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b)
  if (isNum(a) && isNum(b)) return Number(a) === Number(b)
  return String(a) === String(b)
}

export function matches(row: Record<string, any>, f: Filter): boolean {
  let r: boolean
  if (f.kind === 'or') r = f.filters.some((x) => matches(row, x))
  else if (f.kind === 'and') r = f.filters.every((x) => matches(row, x))
  else {
    const v = getPath(row, f.col)
    const t = f.value
    switch (f.op) {
      case 'eq':
        r = eqValue(v, t)
        break
      case 'neq':
        r = v != null && t != null && !eqValue(v, t)
        break
      case 'gt':
        r = v != null && t != null && compare(v, t) > 0
        break
      case 'gte':
        r = v != null && t != null && compare(v, t) >= 0
        break
      case 'lt':
        r = v != null && t != null && compare(v, t) < 0
        break
      case 'lte':
        r = v != null && t != null && compare(v, t) <= 0
        break
      case 'like':
      case 'ilike':
        r = v != null && likeToRegex(String(t), f.op === 'ilike').test(String(v))
        break
      case 'is':
        if (t === null || t === 'null') r = v == null
        else if (t === true || t === 'true') r = v === true
        else if (t === false || t === 'false') r = v === false
        else r = false
        break
      case 'in':
        r = v != null && (t as unknown[]).some((x) => eqValue(v, x))
        break
      case 'cs': {
        const want = Array.isArray(t) ? t : [t]
        r = Array.isArray(v) ? want.every((w) => v.some((x: unknown) => eqValue(x, w))) : false
        break
      }
      default:
        r = false
    }
  }
  return f.negate ? !r : r
}

// ----------------------------------------------------------------------------- PostgREST text parsing

function splitTop(s: string, sep = ',') {
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
  if (cur !== '') out.push(cur)
  return out
}

function parseScalar(v: string): unknown {
  const s = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
  if (s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  return s
}

/** Parse one condition like `end_date.gte.2026-01-01`, `status.in.(a,b)`, `not.name.ilike.*x*`, `and(...)`. */
export function parseCondition(text: string): Filter {
  let t = text.trim()
  let negate = false
  if (t.startsWith('not.')) {
    negate = true
    t = t.slice(4)
  }
  const group = t.match(/^(or|and)\((.*)\)$/s)
  if (group) {
    return { kind: group[1] as 'or' | 'and', filters: splitTop(group[2]).map(parseCondition), negate }
  }
  const m = t.match(/^([^.]+)\.(not\.)?([a-z]+)\.(.*)$/s)
  if (!m) throw new Error(`Unsupported filter: ${text}`)
  const [, col, not, op, raw] = m
  let value: unknown
  if (op === 'in') value = splitTop(raw.replace(/^\(|\)$/g, '')).map(parseScalar)
  else if (op === 'cs') value = raw.replace(/^\{|\}$/g, '').split(',').map(parseScalar)
  else value = parseScalar(raw)
  return { kind: 'cmp', col, op: op as Op, value, negate: negate !== Boolean(not) }
}

/** `.or('a.eq.1,b.ilike.*x*')` */
export function parseOr(text: string): Filter {
  return { kind: 'or', filters: splitTop(text).map(parseCondition) }
}
