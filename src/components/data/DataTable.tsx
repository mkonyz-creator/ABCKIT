import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Search, SlidersHorizontal, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/form'
import { DemoBadge, EmptyState, ErrorState, Menu, MenuContent, MenuItem, MenuTrigger, Skeleton } from '@/components/ui/misc'
import { exportCSV, exportExcel, exportPDF, type ExportColumn, type ExportFormat } from '@/lib/export'
import { cn, errorMessage, formatDate, formatMoney, formatNumber } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

export interface Column<T> {
  key: string
  header: string
  /** raw value used for sorting, searching and export */
  value?: (row: T) => string | number | null | undefined
  /** custom cell renderer; defaults to the formatted value */
  cell?: (row: T) => ReactNode
  format?: ExportFormat
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
  className?: string
  /** hidden in the mobile card layout */
  hideOnMobile?: boolean
  exportable?: boolean
  width?: number
}

export interface FilterDef<T> {
  key: string
  label: string
  options: Array<{ value: string; label: string }>
  predicate?: (row: T, value: string) => boolean
}

interface Props<T> {
  rows: T[] | undefined
  columns: Column<T>[]
  rowKey: (row: T) => string
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  searchPlaceholder?: string
  filters?: FilterDef<T>[]
  onRowClick?: (row: T) => void
  rowActions?: (row: T) => ReactNode
  toolbar?: ReactNode
  exportTitle?: string
  exportSubtitle?: string
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: ReactNode
  pageSize?: number
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  isDemo?: (row: T) => boolean
  footer?: ReactNode
  compact?: boolean
  initialFilters?: Record<string, string>
  initialSearch?: string
}

function rawValue<T>(col: Column<T>, row: T) {
  if (col.value) return col.value(row)
  const v = (row as Record<string, unknown>)[col.key]
  return v as string | number | null | undefined
}

function formatted<T>(col: Column<T>, row: T): ReactNode {
  const v = rawValue(col, row)
  if (v === null || v === undefined || v === '') return <span className="text-subtle">—</span>
  switch (col.format) {
    case 'money':
      return formatMoney(v)
    case 'number':
      return formatNumber(v)
    case 'percent':
      return `${formatNumber(v, 1)}%`
    case 'date':
      return formatDate(String(v))
    default:
      return String(v)
  }
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  error,
  onRetry,
  searchPlaceholder = 'Search…',
  filters = [],
  onRowClick,
  rowActions,
  toolbar,
  exportTitle,
  exportSubtitle,
  emptyTitle = 'No records yet',
  emptyDescription,
  emptyAction,
  pageSize = 25,
  initialSort,
  isDemo,
  footer,
  compact,
  initialFilters,
  initialSearch,
}: Props<T>) {
  const { settings } = useAuth()
  const [q, setQ] = useState(initialSearch ?? '')
  const [sort, setSort] = useState(initialSort ?? null)
  const [filterValues, setFilterValues] = useState<Record<string, string>>(initialFilters ?? {})
  const [page, setPage] = useState(0)
  const [showFilters, setShowFilters] = useState(!!initialFilters && Object.values(initialFilters).some(Boolean))

  const processed = useMemo(() => {
    let out = rows ?? []
    const needle = q.trim().toLowerCase()
    if (needle) {
      out = out.filter((r) =>
        columns.some((c) => {
          const v = rawValue(c, r)
          return v !== null && v !== undefined && String(v).toLowerCase().includes(needle)
        }),
      )
    }
    for (const f of filters) {
      const fv = filterValues[f.key]
      if (!fv) continue
      out = out.filter((r) => (f.predicate ? f.predicate(r, fv) : String((r as Record<string, unknown>)[f.key] ?? '') === fv))
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key)
      if (col) {
        const dir = sort.dir === 'asc' ? 1 : -1
        out = [...out].sort((a, b) => {
          const va = rawValue(col, a)
          const vb = rawValue(col, b)
          if (va === vb) return 0
          if (va === null || va === undefined || va === '') return 1
          if (vb === null || vb === undefined || vb === '') return -1
          if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
          const na = Number(va)
          const nb = Number(vb)
          if (col.format && col.format !== 'text' && col.format !== 'date' && !isNaN(na) && !isNaN(nb)) return (na - nb) * dir
          return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir
        })
      }
    }
    return out
  }, [rows, q, sort, filterValues, columns, filters])

  const pageCount = Math.max(1, Math.ceil(processed.length / pageSize))
  const current = Math.min(page, pageCount - 1)
  const visible = processed.slice(current * pageSize, current * pageSize + pageSize)
  const activeFilterCount = Object.values(filterValues).filter(Boolean).length

  const toggleSort = (key: string) => {
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }))
  }

  const doExport = async (kind: 'csv' | 'xlsx' | 'pdf') => {
    const cols: ExportColumn<T>[] = columns
      .filter((c) => c.exportable !== false)
      .map((c) => ({ header: c.header, value: (r: T) => rawValue(c, r), format: c.format, width: c.width }))
    const meta = {
      title: exportTitle ?? 'Export',
      subtitle: exportSubtitle ?? `${processed.length} record(s)${q ? ` matching "${q}"` : ''}`,
      company: settings
        ? { name: settings.company_name, address: settings.address, phone: settings.phone, email: settings.email, tin: settings.tin }
        : undefined,
      orientation: cols.length > 6 ? ('landscape' as const) : ('portrait' as const),
    }
    try {
      if (kind === 'csv') exportCSV(meta, cols, processed)
      else if (kind === 'xlsx') await exportExcel(meta, cols, processed)
      else await exportPDF(meta, cols, processed)
      toast.success(`Exported ${processed.length} record(s)`)
    } catch (e) {
      toast.error(`Export failed: ${errorMessage(e)}`)
    }
  }

  return (
    <div className="min-w-0">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 p-3 sm:px-4">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(0)
            }}
            placeholder={searchPlaceholder}
            className="h-9 pl-9"
            aria-label="Search table"
          />
        </div>
        {filters.length > 0 && (
          <Button size="sm" variant={activeFilterCount ? 'dark' : 'outline'} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
            <SlidersHorizontal /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </Button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {toolbar}
          {exportTitle && (
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm" disabled={!processed.length}>
                  <Download /> Export
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => doExport('pdf')}>
                  <FileText /> PDF
                </MenuItem>
                <MenuItem onSelect={() => doExport('xlsx')}>
                  <FileSpreadsheet /> Excel (.xlsx)
                </MenuItem>
                <MenuItem onSelect={() => doExport('csv')}>
                  <FileText /> CSV
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </div>
      {showFilters && filters.length > 0 && (
        <div className="flex flex-wrap items-end gap-3 border-t border-border bg-surface-2/40 px-3 py-3 sm:px-4">
          {filters.map((f) => (
            <div key={f.key} className="w-full sm:w-48">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">{f.label}</label>
              <Select
                className="h-9"
                value={filterValues[f.key] ?? ''}
                onChange={(e) => {
                  setFilterValues((s) => ({ ...s, [f.key]: e.target.value }))
                  setPage(0)
                }}
              >
                <option value="">All</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          ))}
          {activeFilterCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setFilterValues({})}>
              <X /> Clear
            </Button>
          )}
        </div>
      )}

      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : processed.length === 0 ? (
        <EmptyState
          title={rows?.length ? 'No matching records' : emptyTitle}
          description={rows?.length ? 'Try a different search term or clear the filters.' : emptyDescription}
          action={rows?.length ? undefined : emptyAction}
        />
      ) : (
        <>
          {/* desktop table */}
          <div className="hidden overflow-x-auto border-t border-border md:block">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-left">
                <tr>
                  {columns.map((c) => {
                    const sortable = c.sortable !== false
                    const active = sort?.key === c.key
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        className={cn(
                          'whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted',
                          (c.align === 'right' || c.format === 'money' || c.format === 'number' || c.format === 'percent') && 'text-right',
                          c.align === 'center' && 'text-center',
                        )}
                      >
                        {sortable ? (
                          <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort(c.key)}>
                            {c.header}
                            {active && (sort!.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                          </button>
                        ) : (
                          c.header
                        )}
                      </th>
                    )
                  })}
                  {rowActions && <th className="w-10" aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={rowKey(r)}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    className={cn('border-t border-border transition-colors', onRowClick && 'cursor-pointer hover:bg-accent-soft/50')}
                  >
                    {columns.map((c, i) => (
                      <td
                        key={c.key}
                        className={cn(
                          compact ? 'px-4 py-2' : 'px-4 py-3',
                          'align-middle',
                          (c.align === 'right' || c.format === 'money' || c.format === 'number' || c.format === 'percent') && 'tabular text-right whitespace-nowrap',
                          c.align === 'center' && 'text-center',
                          c.className,
                        )}
                      >
                        {c.cell ? c.cell(r) : formatted(c, r)}
                        {i === 0 && isDemo?.(r) && (
                          <span className="ml-2 align-middle">
                            <DemoBadge />
                          </span>
                        )}
                      </td>
                    ))}
                    {rowActions && (
                      <td className="px-2 text-right" onClick={(e) => e.stopPropagation()}>
                        {rowActions(r)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              {footer}
            </table>
          </div>

          {/* mobile cards */}
          <ul className="divide-y divide-border border-t border-border md:hidden">
            {visible.map((r) => {
              const [first, ...rest] = columns
              return (
                <li
                  key={rowKey(r)}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={cn('px-4 py-3', onRowClick && 'cursor-pointer active:bg-surface-2')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 font-medium">
                      {first.cell ? first.cell(r) : formatted(first, r)}
                      {isDemo?.(r) && (
                        <span className="ml-2">
                          <DemoBadge />
                        </span>
                      )}
                    </div>
                    {rowActions && <div onClick={(e) => e.stopPropagation()}>{rowActions(r)}</div>}
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    {rest
                      .filter((c) => !c.hideOnMobile)
                      .slice(0, 6)
                      .map((c) => (
                        <div key={c.key} className="min-w-0">
                          <dt className="text-subtle">{c.header}</dt>
                          <dd className="truncate text-sm">{c.cell ? c.cell(r) : formatted(c, r)}</dd>
                        </div>
                      ))}
                  </dl>
                </li>
              )
            })}
          </ul>

          {/* pagination */}
          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted">
            <span className="tabular">
              {current * pageSize + 1}–{Math.min(processed.length, (current + 1) * pageSize)} of {processed.length}
            </span>
            {pageCount > 1 && (
              <div className="flex items-center gap-1">
                <Button size="icon-sm" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <span className="tabular px-1">
                  {current + 1} / {pageCount}
                </span>
                <Button size="icon-sm" variant="ghost" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)} aria-label="Next page">
                  <ChevronRight />
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
