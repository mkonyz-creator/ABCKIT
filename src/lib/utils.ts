import { clsx, type ClassValue } from 'clsx'
import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

let defaultCurrency = 'TZS'
export function setDefaultCurrency(code: string) {
  defaultCurrency = code || 'TZS'
}
export function getDefaultCurrency() {
  return defaultCurrency
}

const moneyFormatters = new Map<string, Intl.NumberFormat>()
export function formatMoney(value: number | string | null | undefined, currency?: string, opts?: { compact?: boolean }) {
  const n = Number(value ?? 0)
  const cur = currency || defaultCurrency
  const key = `${cur}|${opts?.compact ? 'c' : 'f'}`
  let f = moneyFormatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-TZ', {
      style: 'decimal',
      notation: opts?.compact ? 'compact' : 'standard',
      maximumFractionDigits: opts?.compact ? 1 : 2,
      minimumFractionDigits: opts?.compact ? 0 : cur === 'TZS' ? 0 : 2,
    })
    moneyFormatters.set(key, f)
  }
  return `${cur} ${f.format(Number.isFinite(n) ? n : 0)}`
}

export function formatNumber(value: number | string | null | undefined, digits = 2) {
  const n = Number(value ?? 0)
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(Number.isFinite(n) ? n : 0)
}

export function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const d = typeof value === 'string' ? parseISO(value) : value
  return isValid(d) ? d : null
}

export function formatDate(value: string | Date | null | undefined, pattern = 'dd MMM yyyy') {
  const d = toDate(value)
  return d ? format(d, pattern) : '—'
}

export function formatDateTime(value: string | Date | null | undefined) {
  return formatDate(value, 'dd MMM yyyy, HH:mm')
}

export function timeAgo(value: string | Date | null | undefined) {
  const d = toDate(value)
  return d ? `${formatDistanceToNowStrict(d)} ago` : '—'
}

export function today() {
  return format(new Date(), 'yyyy-MM-dd')
}

export function humanize(value: string | null | undefined) {
  if (!value) return '—'
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function initials(name: string | null | undefined) {
  if (!name) return '?'
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

export function sum<T>(rows: T[], pick: (r: T) => number | string | null | undefined) {
  return rows.reduce((acc, r) => acc + (Number(pick(r)) || 0), 0)
}

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Turns Supabase/Postgres errors into messages a site user can act on. */
export function errorMessage(err: unknown): string {
  if (!err) return 'Unknown error'
  const e = err as { message?: string; code?: string; details?: string }
  const msg = e.message ?? String(err)
  if (e.code === '23505') return 'A record with the same unique value already exists.'
  if (e.code === '23503') return 'This record is linked to other records and cannot be removed or saved with that reference.'
  if (e.code === '23514') return `A value is outside the allowed range. ${e.details ?? ''}`.trim()
  if (e.code === '42501' || /row-level security/i.test(msg)) {
    return /row-level security/i.test(msg) ? 'You do not have permission to perform this action.' : msg
  }
  if (e.code === 'PGRST116') return 'Record not found or you do not have access to it.'
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Network error — check your connection and try again.'
  if (/Invalid login credentials/i.test(msg)) return 'Incorrect email or password.'
  return msg
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60)
}

export function safeFileName(name: string) {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  return `${slug(base) || 'file'}${ext ? '.' + ext : ''}`
}
