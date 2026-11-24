import { Table2, BarChart3 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Card, CardHeader, EmptyState, Skeleton } from '@/components/ui/misc'
import { formatMoney, formatNumber } from '@/lib/utils'

/** Categorical slots — validated default palette (see dataviz palette); CSS vars swap per theme. */
export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)']
export const GRID = 'var(--chart-grid)'
export const AXIS = 'var(--chart-axis)'

export const axisProps = {
  stroke: AXIS,
  tick: { fill: AXIS, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: GRID },
} as const

export const compactMoney = (v: number) => formatMoney(v, undefined, { compact: true }).replace(/^[A-Z]{3} /, '')

export function ChartTooltip({
  active,
  payload,
  label,
  valueFormat = 'money',
  labelFormat,
}: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color?: string; fill?: string; stroke?: string; dataKey?: string }>
  label?: string | number
  valueFormat?: 'money' | 'number' | 'percent'
  labelFormat?: (l: any) => string
}) {
  if (!active || !payload?.length) return null
  const fmt = (v: number) => (valueFormat === 'money' ? formatMoney(v) : valueFormat === 'percent' ? `${formatNumber(v, 1)}%` : formatNumber(v))
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-xl">
      {label !== undefined && <p className="mb-1 font-semibold text-foreground">{labelFormat ? labelFormat(label) : label}</p>}
      {payload.map((p) => (
        <div key={p.dataKey ?? p.name} className="flex items-center gap-2 py-0.5">
          <span className="size-2.5 rounded-sm" style={{ background: p.color ?? p.fill ?? p.stroke }} />
          <span className="text-muted">{p.name}</span>
          <span className="ml-auto pl-4 font-semibold tabular text-foreground">{fmt(Number(p.value))}</span>
        </div>
      ))}
    </div>
  )
}

export function LegendRow({ items }: { items: Array<{ label: string; color: string }> }) {
  if (items.length < 2) return null
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  )
}

export interface TableCol {
  key: string
  label: string
  format?: 'money' | 'number' | 'percent' | 'text'
}

/** Chart card with a built-in accessible table view toggle. */
export function ChartCard({
  title,
  description,
  legend,
  loading,
  empty,
  data,
  tableCols,
  height = 260,
  children,
  actions,
}: {
  title: string
  description?: string
  legend?: Array<{ label: string; color: string }>
  loading?: boolean
  empty?: boolean
  data?: Array<Record<string, any>>
  tableCols?: TableCol[]
  height?: number
  children: ReactNode
  actions?: ReactNode
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card className="min-w-0">
      <CardHeader
        title={title}
        description={description}
        actions={
          <>
            {actions}
            {tableCols && data && data.length > 0 && (
              <button
                onClick={() => setAsTable((t) => !t)}
                className="rounded-md p-1.5 text-subtle hover:bg-surface-2 hover:text-foreground"
                aria-label={asTable ? 'Show chart' : 'Show data table'}
                title={asTable ? 'Show chart' : 'Show data table'}
              >
                {asTable ? <BarChart3 className="size-4" /> : <Table2 className="size-4" />}
              </button>
            )}
          </>
        }
      />
      <div className="px-3 pb-3 pt-3 sm:px-4">
        {legend && (
          <div className="mb-2 px-1">
            <LegendRow items={legend} />
          </div>
        )}
        {loading ? (
          <div style={{ height }}>
            <Skeleton className="h-full w-full" />
          </div>
        ) : empty ? (
          <EmptyState title="No data yet" description="This chart fills in as records are added." />
        ) : asTable && tableCols && data ? (
          <div className="overflow-auto" style={{ maxHeight: height }}>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  {tableCols.map((c) => (
                    <th key={c.key} className={`px-2 py-1.5 font-semibold ${c.format && c.format !== 'text' ? 'text-right' : ''}`}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    {tableCols.map((c) => (
                      <td key={c.key} className={`px-2 py-1.5 ${c.format && c.format !== 'text' ? 'tabular text-right' : ''}`}>
                        {c.format === 'money' ? formatMoney(r[c.key]) : c.format === 'number' ? formatNumber(r[c.key]) : c.format === 'percent' ? `${formatNumber(r[c.key], 1)}%` : r[c.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ height }} className="w-full">
            {children}
          </div>
        )}
      </div>
    </Card>
  )
}
