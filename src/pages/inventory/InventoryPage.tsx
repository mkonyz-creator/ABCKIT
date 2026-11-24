import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Boxes, History, PackageSearch, Scale, Tags, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ResourcePage } from '@/components/crud/ResourcePage'
import { DataTable } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select } from '@/components/ui/form'
import { Badge, Card, MenuItem, PageHeader, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { stockAfter } from '@/lib/calc'
import { useInvalidate, useList, useProjectOptions } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db } from '@/lib/backend'
import type { Material } from '@/lib/types'
import { cn, errorMessage, formatMoney, formatNumber, today } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

type TxnType = 'receipt' | 'issue' | 'return' | 'adjustment_in' | 'adjustment_out' | 'opening'

interface Txn {
  id: string
  material_id: string
  project_id: string | null
  txn_type: TxnType
  quantity: number
  unit_price: number | null
  balance_after: number
  reference: string | null
  notes: string | null
  negative_override: boolean
  transaction_date: string
  created_at: string
  material?: { name: string; unit: string; code: string } | null
  project?: { name: string; code: string } | null
  creator?: { full_name: string } | null
}

const TXN_LABEL: Record<TxnType, string> = {
  receipt: 'Received',
  issue: 'Issued to site',
  return: 'Returned from site',
  adjustment_in: 'Adjustment (+)',
  adjustment_out: 'Adjustment (âˆ’)',
  opening: 'Opening balance',
}

export function StockMovementDialog({ open, onOpenChange, initialType, initialMaterial }: { open: boolean; onOpenChange: (o: boolean) => void; initialType: TxnType; initialMaterial?: string }) {
  const { can } = useAuth()
  const invalidate = useInvalidate()
  const materials = useList<Material>('materials', { eq: { is_active: true }, order: { column: 'name' } })
  const projects = useProjectOptions()
  const [f, setF] = useState({ txn_type: initialType, material_id: initialMaterial ?? '', project_id: '', quantity: '', unit_price: '', transaction_date: today(), reference: '', notes: '', negative_override: false })
  const [busy, setBusy] = useState(false)
  const m = (materials.data ?? []).find((x) => x.id === f.material_id)
  const after = m ? stockAfter(m.current_stock, f.txn_type, Number(f.quantity) || 0) : null
  const goesNegative = after !== null && after < 0
  const needsProject = f.txn_type === 'issue' || f.txn_type === 'return'

  // reset when reopened with a different type
  const [lastKey, setLastKey] = useState('')
  const key = `${open}-${initialType}-${initialMaterial}`
  if (open && key !== lastKey) {
    setLastKey(key)
    setF((s) => ({ ...s, txn_type: initialType, material_id: initialMaterial ?? s.material_id, quantity: '', reference: '', notes: '', negative_override: false }))
  }

  const submit = async () => {
    const qty = Number(f.quantity)
    if (!f.material_id) return toast.error('Select a material')
    if (!(qty > 0)) return toast.error('Quantity must be greater than zero')
    if (needsProject && !f.project_id) return toast.error('Select the project the material is issued to / returned from')
    if (goesNegative && !f.negative_override) return toast.error('Insufficient stock. An authorised approver must override.')
    setBusy(true)
    const { error } = await db.from('inventory_transactions').insert({
      material_id: f.material_id,
      project_id: f.project_id || null,
      txn_type: f.txn_type,
      quantity: qty,
      unit_price: f.unit_price === '' ? null : Number(f.unit_price),
      transaction_date: f.transaction_date,
      reference: f.reference.trim() || null,
      notes: f.notes.trim() || null,
      negative_override: f.negative_override,
    })
    setBusy(false)
    if (error) return toast.error(errorMessage(error))
    toast.success(`${TXN_LABEL[f.txn_type]}: ${formatNumber(qty)} ${m?.unit ?? ''} ${m?.name ?? ''}`)
    await invalidate('materials', 'inventory_transactions', 'material_consumption')
    onOpenChange(false)
  }

  const types: TxnType[] = ['receipt', 'issue', 'return', 'opening', ...(can(P.inventoryAdjust) ? (['adjustment_in', 'adjustment_out'] as TxnType[]) : [])]

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record stock movement"
      description="Stock balances only change through these ledger entries."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={goesNegative && !f.negative_override}>
            Post movement
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Movement type" required>
          <Select value={f.txn_type} onChange={(e) => setF({ ...f, txn_type: e.target.value as TxnType })}>
            {types.map((t) => (
              <option key={t} value={t}>
                {TXN_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date" required>
          <Input type="date" max={today()} value={f.transaction_date} onChange={(e) => setF({ ...f, transaction_date: e.target.value })} />
        </Field>
        <Field label="Material" required className="sm:col-span-2">
          <Select value={f.material_id} onChange={(e) => setF({ ...f, material_id: e.target.value })}>
            <option value="">Select…</option>
            {(materials.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.code} Â· {x.name} ({formatNumber(x.current_stock)} {x.unit})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={needsProject ? 'Project' : 'Project (optional)'} required={needsProject} className="sm:col-span-2">
          <Select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
            <option value="">{needsProject ? 'Select…' : 'Main store / not project-specific'}</option>
            {projects.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Quantity${m ? ` (${m.unit})` : ''}`} required>
          <Input type="number" min={0} step="any" inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        </Field>
        <Field label="Unit price" hint={m ? `Current: ${formatMoney(m.unit_price)}` : undefined}>
          <Input type="number" min={0} step="0.01" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} placeholder={m ? String(m.unit_price) : ''} />
        </Field>
        <Field label="Reference" hint="Delivery note, requisition or GRN no.">
          <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {m && (
          <div className={cn('rounded-lg border px-4 py-3 text-sm sm:col-span-2', goesNegative ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border bg-surface-2/60')}>
            Balance: <strong className="tabular">{formatNumber(m.current_stock)}</strong> → <strong className="tabular">{formatNumber(after ?? 0)}</strong> {m.unit}
            {goesNegative && (
              <div className="mt-2">
                <p className="flex items-center gap-1 font-semibold">
                  <AlertTriangle className="size-4" /> This movement would make stock negative.
                </p>
                {can(P.inventoryNegative) ? (
                  <Checkbox className="mt-2" checked={f.negative_override} onChange={(e) => setF({ ...f, negative_override: e.target.checked })} label="I authorise this negative balance (recorded against my name)" />
                ) : (
                  <p className="mt-1 text-xs">Only a Project Manager or Managing Director can authorise a negative balance.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

function Ledger({ projectId, materialFilter }: { projectId?: string; materialFilter?: string }) {
  const txns = useList<Txn>('inventory_transactions', {
    select: '*, material:materials(name,unit,code), project:projects(name,code), creator:profiles!inventory_transactions_created_by_fkey(full_name)',
    eq: { project_id: projectId, material_id: materialFilter },
    order: { column: 'created_at', ascending: false },
    limit: 1000,
  })
  const inbound = (t: TxnType) => ['receipt', 'return', 'adjustment_in', 'opening'].includes(t)
  return (
    <Card>
      <DataTable<Txn>
        rows={txns.data}
        loading={txns.isLoading}
        error={txns.error}
        rowKey={(r) => r.id}
        exportTitle="Stock movements"
        filters={[{ key: 'txn_type', label: 'Type', options: Object.entries(TXN_LABEL).map(([value, label]) => ({ value, label })) }]}
        columns={[
          { key: 'transaction_date', header: 'Date', format: 'date' },
          { key: 'material', header: 'Material', value: (r) => r.material?.name ?? null, cell: (r) => <span className="font-medium">{r.material?.name}</span> },
          {
            key: 'txn_type',
            header: 'Movement',
            value: (r) => TXN_LABEL[r.txn_type],
            cell: (r) => (
              <Badge tone={inbound(r.txn_type) ? 'success' : 'accent'}>
                {inbound(r.txn_type) ? <ArrowDownToLine className="size-3" /> : <ArrowUpFromLine className="size-3" />} {TXN_LABEL[r.txn_type]}
              </Badge>
            ),
          },
          {
            key: 'quantity',
            header: 'Qty',
            format: 'number',
            cell: (r) => (
              <span className={cn('font-semibold', inbound(r.txn_type) ? 'text-success' : '')}>
                {inbound(r.txn_type) ? '+' : 'âˆ’'}
                {formatNumber(r.quantity)} {r.material?.unit}
              </span>
            ),
          },
          { key: 'balance_after', header: 'Balance', format: 'number', cell: (r) => <span className={cn(r.balance_after < 0 && 'font-semibold text-danger')}>{formatNumber(r.balance_after)}{r.negative_override && ' âš '}</span> },
          { key: 'unit_price', header: 'Unit price', format: 'money', hideOnMobile: true },
          ...(projectId ? [] : [{ key: 'project', header: 'Project', value: (r: Txn) => r.project?.name ?? 'Main store', hideOnMobile: true }]),
          { key: 'reference', header: 'Reference', hideOnMobile: true },
          { key: 'creator', header: 'By', value: (r) => r.creator?.full_name ?? null, hideOnMobile: true },
        ]}
        emptyTitle="No stock movements yet"
      />
    </Card>
  )
}

export function MaterialConsumption({ projectId }: { projectId?: string }) {
  const q = useList<{ project_id: string; material_id: string; material_name: string; unit: string; qty_consumed: number; value_consumed: number }>('material_consumption', { eq: { project_id: projectId } })
  const projects = useProjectOptions(true)
  const names = useMemo(() => new Map(projects.options.map((o) => [o.value, o.label])), [projects.options])
  return (
    <Card>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => `${r.project_id}-${r.material_id}`}
        exportTitle="Material consumption by project"
        initialSort={{ key: 'value_consumed', dir: 'desc' }}
        filters={projectId ? [] : [{ key: 'project_id', label: 'Project', options: projects.options }]}
        columns={[
          ...(projectId ? [] : [{ key: 'project_id', header: 'Project', value: (r: any) => names.get(r.project_id) ?? r.project_id }]),
          { key: 'material_name', header: 'Material' },
          { key: 'qty_consumed', header: 'Net quantity issued', format: 'number', cell: (r) => `${formatNumber(r.qty_consumed)} ${r.unit}` },
          { key: 'value_consumed', header: 'Value', format: 'money' },
        ]}
        emptyTitle="No materials issued yet"
      />
    </Card>
  )
}

export default function InventoryPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'materials'
  const [move, setMove] = useState<{ type: TxnType; material?: string } | null>(null)

  return (
    <div>
      <PageHeader
        title="Materials & Inventory"
        description="Stock register, receipts, issues to site and consumption by project."
        actions={
          can(P.inventoryManage) && (
            <>
              <Button onClick={() => setMove({ type: 'issue' })}>
                <ArrowUpFromLine /> Issue to site
              </Button>
              <Button variant="primary" onClick={() => setMove({ type: 'receipt' })}>
                <ArrowDownToLine /> Receive stock
              </Button>
            </>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="materials">
            <Boxes /> Materials
          </TabsTrigger>
          <TabsTrigger value="movements">
            <History /> Stock movements
          </TabsTrigger>
          <TabsTrigger value="consumption">
            <PackageSearch /> Consumption by project
          </TabsTrigger>
          <TabsTrigger value="categories">
            <Tags /> Categories
          </TabsTrigger>
        </TabsList>
        <TabsContent value="materials">
          <ResourcePage<Material>
            config={{
              table: 'materials',
              select: '*, category:material_categories(id,name)',
              singular: 'Material',
              plural: 'Materials',
              order: { column: 'name' },
              perms: { create: P.inventoryManage, edit: P.inventoryManage, remove: P.inventoryManage },
              initialSearch: params.get('q') ?? undefined,
              initialFilters: params.get('filter') === 'low' ? { level: 'low' } : undefined,
              filters: [
                {
                  key: 'level',
                  label: 'Stock level',
                  options: [
                    { value: 'low', label: 'At / below minimum' },
                    { value: 'out', label: 'Out of stock' },
                    { value: 'ok', label: 'Healthy' },
                  ],
                  predicate: (m, v) => (v === 'out' ? m.current_stock <= 0 : v === 'low' ? m.min_stock > 0 && m.current_stock <= m.min_stock : m.current_stock > m.min_stock),
                },
                { key: 'is_active', label: 'Active', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }], predicate: (m, v) => String(m.is_active) === v },
              ],
              fields: [
                { name: 'name', label: 'Material name', type: 'text', required: true, span: 2 },
                { name: 'code', label: 'Code', type: 'text', hint: 'Blank = auto', disabled: (_v, e) => e },
                { name: 'category_id', label: 'Category', type: 'relation', relation: { table: 'material_categories', label: (c) => c.name, order: 'name' } },
                { name: 'unit', label: 'Unit of measure', type: 'unit', required: true },
                { name: 'unit_price', label: 'Standard unit price', type: 'money', required: true, defaultValue: 0 },
                { name: 'min_stock', label: 'Minimum stock level', type: 'number', min: 0, defaultValue: 0, hint: 'Low-stock alert threshold' },
                { name: 'is_active', label: 'Active', type: 'checkbox', defaultValue: true },
                { name: 'description', label: 'Specification / notes', type: 'textarea' },
              ],
              beforeSave: (v) => {
                const out = { ...v }
                delete out.current_stock
                return out
              },
              extraActions: (m) =>
                can(P.inventoryManage) ? (
                  <>
                    <MenuItem onSelect={() => setMove({ type: 'receipt', material: m.id })}>
                      <ArrowDownToLine /> Receive
                    </MenuItem>
                    <MenuItem onSelect={() => setMove({ type: 'issue', material: m.id })}>
                      <ArrowUpFromLine /> Issue to site
                    </MenuItem>
                    <MenuItem onSelect={() => setMove({ type: 'return', material: m.id })}>
                      <Undo2 /> Return from site
                    </MenuItem>
                    {can(P.inventoryAdjust) && (
                      <MenuItem onSelect={() => setMove({ type: 'adjustment_out', material: m.id })}>
                        <Scale /> Stock adjustment
                      </MenuItem>
                    )}
                  </>
                ) : null,
              columns: [
                {
                  key: 'name',
                  header: 'Material',
                  cell: (m) => (
                    <div>
                      <p className="font-semibold">{m.name}</p>
                      <p className="font-mono text-xs text-subtle">{m.code}</p>
                    </div>
                  ),
                  value: (m) => `${m.code} ${m.name}`,
                },
                { key: 'category', header: 'Category', value: (m) => m.category?.name ?? null, hideOnMobile: true },
                {
                  key: 'current_stock',
                  header: 'In stock',
                  format: 'number',
                  cell: (m) => {
                    const low = m.min_stock > 0 && m.current_stock <= m.min_stock
                    return (
                      <span className={cn('inline-flex items-center gap-1.5 font-semibold', m.current_stock <= 0 ? 'text-danger' : low ? 'text-warning' : '')}>
                        {low && <AlertTriangle className="size-3.5" />}
                        {formatNumber(m.current_stock)} {m.unit}
                      </span>
                    )
                  },
                },
                { key: 'min_stock', header: 'Minimum', format: 'number', hideOnMobile: true },
                { key: 'unit_price', header: 'Unit price', format: 'money' },
                { key: 'value', header: 'Stock value', format: 'money', value: (m) => Number(m.current_stock) * Number(m.unit_price) },
                { key: 'is_active', header: 'Status', value: (m) => (m.is_active ? 'active' : 'inactive'), cell: (m) => <StatusBadge status={m.is_active ? 'available' : 'retired'} />, hideOnMobile: true },
              ],
              emptyDescription: 'Register cement, steel, aggregates and other materials, then post an opening balance.',
            }}
          />
        </TabsContent>
        <TabsContent value="movements">
          <Ledger />
        </TabsContent>
        <TabsContent value="consumption">
          <MaterialConsumption />
        </TabsContent>
        <TabsContent value="categories">
          <ResourcePage<{ id: string; name: string }>
            config={{
              table: 'material_categories',
              singular: 'Category',
              plural: 'Material categories',
              order: { column: 'name' },
              perms: { create: P.inventoryManage, edit: P.inventoryManage, remove: P.inventoryManage },
              fields: [{ name: 'name', label: 'Category name', type: 'text', required: true, span: 2 }],
              columns: [{ key: 'name', header: 'Category' }],
            }}
          />
        </TabsContent>
      </Tabs>
      <StockMovementDialog open={!!move} onOpenChange={(o) => !o && setMove(null)} initialType={move?.type ?? 'receipt'} initialMaterial={move?.material} />
    </div>
  )
}
