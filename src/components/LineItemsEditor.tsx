import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/form'
import { itemAmount } from '@/lib/calc'
import { useList } from '@/lib/hooks'
import { formatNumber } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

export interface LineItem {
  material_id: string | null
  description: string
  quantity: number | string
  unit: string
  rate: number | string
}

export function LineItemsEditor({ items, onChange, rateLabel = 'Rate', readOnly }: { items: LineItem[]; onChange: (i: LineItem[]) => void; rateLabel?: string; readOnly?: boolean }) {
  const { settings } = useAuth()
  const materials = useList<{ id: string; name: string; unit: string; unit_price: number; code: string }>('materials', {
    select: 'id,name,unit,unit_price,code',
    eq: { is_active: true },
    order: { column: 'name' },
  })
  const units = settings?.units ?? []
  const upd = (i: number, patch: Partial<LineItem>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const total = items.reduce((s, i) => s + itemAmount(i.quantity, i.rate), 0)

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-surface-2/60 text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="w-56 px-2 py-2 text-left">Material</th>
              <th className="px-2 py-2 text-left">Description</th>
              <th className="w-24 px-2 py-2 text-right">Qty</th>
              <th className="w-24 px-2 py-2 text-left">Unit</th>
              <th className="w-32 px-2 py-2 text-right">{rateLabel}</th>
              <th className="w-32 px-2 py-2 text-right">Amount</th>
              {!readOnly && <th className="w-10" />}
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className="border-t border-border">
                <td className="p-1">
                  <Select
                    className="h-9"
                    disabled={readOnly}
                    value={it.material_id ?? ''}
                    onChange={(e) => {
                      const m = materials.data?.find((x) => x.id === e.target.value)
                      upd(i, m ? { material_id: m.id, description: it.description || m.name, unit: m.unit, rate: Number(it.rate) || m.unit_price } : { material_id: null })
                    }}
                    aria-label="Material"
                  >
                    <option value="">— Non-stock item —</option>
                    {(materials.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.code} · {m.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="p-1">
                  <Input className="h-9" disabled={readOnly} value={it.description} onChange={(e) => upd(i, { description: e.target.value })} aria-label="Description" />
                </td>
                <td className="p-1">
                  <Input className="h-9 text-right" type="number" min={0} step="any" disabled={readOnly} value={it.quantity} onChange={(e) => upd(i, { quantity: e.target.value })} aria-label="Quantity" />
                </td>
                <td className="p-1">
                  <Select className="h-9" disabled={readOnly} value={it.unit} onChange={(e) => upd(i, { unit: e.target.value })} aria-label="Unit">
                    {[...new Set([it.unit, ...units])].map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </Select>
                </td>
                <td className="p-1">
                  <Input className="h-9 text-right" type="number" min={0} step="0.01" disabled={readOnly} value={it.rate} onChange={(e) => upd(i, { rate: e.target.value })} aria-label={rateLabel} />
                </td>
                <td className="px-2 text-right font-semibold tabular">{formatNumber(itemAmount(it.quantity, it.rate))}</td>
                {!readOnly && (
                  <td className="p-1">
                    <Button size="icon-sm" variant="ghost" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove line">
                      <Trash2 />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-surface-2/40">
              <td colSpan={5} className="px-2 py-2 text-right text-xs font-semibold uppercase text-muted">
                Subtotal
              </td>
              <td className="px-2 py-2 text-right font-bold tabular">{formatNumber(total)}</td>
              {!readOnly && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
      {!readOnly && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => onChange([...items, { material_id: null, description: '', quantity: 1, unit: units[0] ?? 'No.', rate: 0 }])}>
          <Plus /> Add line
        </Button>
      )}
    </div>
  )
}

export function validateLines(items: LineItem[]) {
  if (items.length === 0) return 'Add at least one line item'
  for (const [i, it] of items.entries()) {
    if (!it.description.trim()) return `Line ${i + 1}: description is required`
    if (!(Number(it.quantity) > 0)) return `Line ${i + 1}: quantity must be greater than zero`
    if (Number(it.rate) < 0) return `Line ${i + 1}: rate cannot be negative`
  }
  return null
}
