import { useQuery } from '@tanstack/react-query'
import { Ban, CheckCircle2, FileDown, PackageCheck, Plus, Send, ShoppingCart, Truck, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { LineItemsEditor, validateLines, type LineItem } from '@/components/LineItemsEditor'
import { DataTable } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Card, KeyValue, Spinner, StatusBadge } from '@/components/ui/misc'
import { buildPdf } from '@/lib/export'
import { useInvalidate, useList, useProjectOptions } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db, unwrap } from '@/lib/backend'
import { errorMessage, formatDate, formatMoney, formatNumber, humanize, today } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

// =============================================================================
// Purchase requests
// =============================================================================
interface PR {
  id: string
  number: string
  project_id: string | null
  requested_by: string
  needed_by: string | null
  priority: string
  justification: string | null
  status: string
  review_comment: string | null
  created_at: string
  is_demo: boolean
  project?: { name: string; code: string } | null
  requester?: { full_name: string } | null
  items?: Array<LineItem & { id: string; estimated_rate: number; amount: number }>
}

export function PurchaseRequests() {
  const { can, profile } = useAuth()
  const invalidate = useInvalidate()
  const list = useList<PR>('purchase_requests', {
    select: '*, project:projects(name,code), requester:profiles!purchase_requests_requested_by_fkey(full_name), items:purchase_request_items(*)',
    order: { column: 'created_at', ascending: false },
  })
  const projects = useProjectOptions()
  const [editor, setEditor] = useState(false)
  const [view, setView] = useState<PR | null>(null)
  const [toPO, setToPO] = useState<PR | null>(null)
  const [review, setReview] = useState<null | 'approved' | 'rejected'>(null)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ project_id: '', needed_by: '', priority: 'normal', justification: '' })
  const [items, setItems] = useState<LineItem[]>([])

  const create = async (submit: boolean) => {
    const err = validateLines(items)
    if (err) return toast.error(err)
    if (!f.project_id) return toast.error('Select the project the materials are for')
    setBusy(true)
    try {
      const pr = unwrap(
        await db
          .from('purchase_requests')
          .insert({ project_id: f.project_id, needed_by: f.needed_by || null, priority: f.priority, justification: f.justification || null, status: 'draft', requested_by: profile!.id })
          .select('id')
          .single(),
      ) as { id: string }
      const ins = await db.from('purchase_request_items').insert(
        items.map((i) => ({ request_id: pr.id, material_id: i.material_id, description: i.description.trim(), quantity: Number(i.quantity), unit: i.unit, estimated_rate: Number(i.rate) || 0 })),
      )
      if (ins.error) {
        await db.from('purchase_requests').delete().eq('id', pr.id)
        throw ins.error
      }
      if (submit) unwrap(await db.from('purchase_requests').update({ status: 'submitted' }).eq('id', pr.id))
      toast.success(submit ? 'Request submitted for approval' : 'Draft saved')
      setEditor(false)
      setItems([])
      setF({ project_id: '', needed_by: '', priority: 'normal', justification: '' })
      await invalidate('purchase_requests')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (pr: PR, status: string, comment?: string) => {
    setBusy(true)
    try {
      unwrap(await db.from('purchase_requests').update({ status, review_comment: comment ?? pr.review_comment }).eq('id', pr.id))
      toast.success(`Request ${humanize(status).toLowerCase()}`)
      setView(null)
      setReview(null)
      await invalidate('purchase_requests')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <DataTable<PR>
        rows={list.data}
        loading={list.isLoading}
        error={list.error}
        rowKey={(r) => r.id}
        isDemo={(r) => r.is_demo}
        onRowClick={setView}
        exportTitle="Purchase requests"
        filters={[
          { key: 'status', label: 'Status', options: ['draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled'].map((s) => ({ value: s, label: humanize(s) })) },
          { key: 'priority', label: 'Priority', options: ['low', 'normal', 'high', 'urgent'].map((s) => ({ value: s, label: humanize(s) })) },
        ]}
        columns={[
          { key: 'number', header: 'Request', cell: (r) => <span className="font-mono font-semibold">{r.number}</span> },
          { key: 'project', header: 'Project', value: (r) => r.project?.name ?? null },
          { key: 'requester', header: 'Requested by', value: (r) => r.requester?.full_name ?? null, hideOnMobile: true },
          { key: 'items', header: 'Lines', format: 'number', value: (r) => r.items?.length ?? 0 },
          { key: 'value', header: 'Est. value', format: 'money', value: (r) => (r.items ?? []).reduce((s, i) => s + Number(i.amount), 0) },
          { key: 'needed_by', header: 'Needed by', format: 'date' },
          { key: 'priority', header: 'Priority', cell: (r) => <StatusBadge status={r.priority} /> },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        ]}
        emptyTitle="No purchase requests"
        emptyDescription="Site teams raise requisitions here; procurement approves and converts them to purchase orders."
        toolbar={
          can(P.procurementRequest) && (
            <Button size="sm" variant="primary" onClick={() => setEditor(true)}>
              <Plus /> New request
            </Button>
          )
        }
      />

      <Dialog
        open={editor}
        onOpenChange={setEditor}
        size="xl"
        title="New purchase request"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditor(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => create(false)}>
              Save draft
            </Button>
            <Button variant="primary" loading={busy} onClick={() => create(true)}>
              <Send /> Submit for approval
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Project" required>
            <Select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
              <option value="">Select…</option>
              {projects.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Needed by">
            <Input type="date" min={today()} value={f.needed_by} onChange={(e) => setF({ ...f, needed_by: e.target.value })} />
          </Field>
          <Field label="Priority">
            <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {['low', 'normal', 'high', 'urgent'].map((p) => (
                <option key={p} value={p}>
                  {humanize(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Justification" className="sm:col-span-3">
            <Textarea rows={2} value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} placeholder="What is it for? Which BOQ item / activity?" />
          </Field>
          <div className="sm:col-span-3">
            <LineItemsEditor items={items} onChange={setItems} rateLabel="Est. rate" />
          </div>
        </div>
      </Dialog>

      {view && (
        <Dialog
          open
          onOpenChange={(o) => !o && setView(null)}
          size="lg"
          title={`Purchase request ${view.number}`}
          description={<StatusBadge status={view.status} />}
          footer={
            <>
              {view.status === 'draft' && view.requested_by === profile?.id && (
                <Button variant="primary" loading={busy} onClick={() => setStatus(view, 'submitted')}>
                  <Send /> Submit
                </Button>
              )}
              {view.status === 'submitted' && can(P.procurementApprove) && (
                <>
                  <Button variant="danger" onClick={() => setReview('rejected')}>
                    <XCircle /> Reject
                  </Button>
                  <Button variant="primary" onClick={() => setReview('approved')}>
                    <CheckCircle2 /> Approve
                  </Button>
                </>
              )}
              {view.status === 'approved' && can(P.procurementManage) && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setToPO(view)
                    setView(null)
                  }}
                >
                  <ShoppingCart /> Create purchase order
                </Button>
              )}
              {['draft', 'submitted', 'approved'].includes(view.status) && (view.requested_by === profile?.id || can(P.procurementManage)) && (
                <Button variant="ghost" loading={busy} onClick={() => setStatus(view, 'cancelled')}>
                  <Ban /> Cancel request
                </Button>
              )}
            </>
          }
        >
          <KeyValue
            cols={3}
            items={[
              { label: 'Project', value: view.project?.name },
              { label: 'Requested by', value: view.requester?.full_name },
              { label: 'Date', value: formatDate(view.created_at) },
              { label: 'Needed by', value: formatDate(view.needed_by) },
              { label: 'Priority', value: <StatusBadge status={view.priority} /> },
              { label: 'Justification', value: view.justification },
            ]}
          />
          {view.review_comment && <p className="mt-3 rounded-md bg-surface-2 p-3 text-sm">Reviewer: {view.review_comment}</p>}
          <div className="mt-4">
            <LineItemsEditor readOnly items={(view.items ?? []).map((i) => ({ ...i, rate: i.estimated_rate }))} onChange={() => undefined} rateLabel="Est. rate" />
          </div>
        </Dialog>
      )}

      <ConfirmDialog
        open={!!review}
        onOpenChange={(o) => !o && setReview(null)}
        title={review === 'approved' ? 'Approve purchase request?' : 'Reject purchase request?'}
        message={review === 'approved' ? 'Procurement can then raise a purchase order.' : 'The requester will be notified.'}
        requireReason={review === 'rejected' ? 'Reason for rejection' : undefined}
        danger={review === 'rejected'}
        confirmLabel={review === 'approved' ? 'Approve' : 'Reject'}
        loading={busy}
        onConfirm={(reason) => view && review && setStatus(view, review, reason)}
      />

      {toPO && <PurchaseOrderEditor open onOpenChange={(o) => !o && setToPO(null)} fromRequest={toPO} />}
    </Card>
  )
}

// =============================================================================
// Purchase orders
// =============================================================================
interface PO {
  id: string
  number: string
  supplier_id: string
  project_id: string | null
  request_id: string | null
  order_date: string
  expected_date: string | null
  currency: string
  tax_rate: number
  delivery_address: string | null
  terms: string | null
  notes: string | null
  status: string
  approved_at: string | null
  is_demo: boolean
  supplier?: { id: string; name: string; phone: string | null; email: string | null; address: string | null; tin: string | null } | null
  project?: { name: string; code: string; location: string | null } | null
  approver?: { full_name: string } | null
}

interface POItem {
  id: string
  po_id: string
  material_id: string | null
  description: string
  quantity: number
  unit: string
  rate: number
  amount: number
  received_qty: number
}

export function PurchaseOrderEditor({ open, onOpenChange, fromRequest }: { open: boolean; onOpenChange: (o: boolean) => void; fromRequest?: PR }) {
  const invalidate = useInvalidate()
  const { settings } = useAuth()
  const suppliers = useList<{ id: string; name: string; is_active: boolean }>('suppliers', { select: 'id,name,is_active', order: { column: 'name' } })
  const projects = useProjectOptions()
  const [f, setF] = useState({
    supplier_id: '',
    project_id: fromRequest?.project_id ?? '',
    order_date: today(),
    expected_date: '',
    currency: settings?.default_currency ?? 'TZS',
    tax_rate: String(settings?.taxes?.[0]?.rate ?? 18),
    delivery_address: '',
    terms: 'Payment within 30 days of delivery and invoice.',
    notes: fromRequest ? `Ref. purchase request ${fromRequest.number}` : '',
  })
  const [items, setItems] = useState<LineItem[]>(
    (fromRequest?.items ?? []).map((i) => ({ material_id: i.material_id, description: i.description, quantity: i.quantity, unit: i.unit, rate: i.estimated_rate })),
  )
  const [busy, setBusy] = useState(false)

  const save = async (status: 'draft' | 'pending_approval') => {
    const err = validateLines(items)
    if (err) return toast.error(err)
    if (!f.supplier_id) return toast.error('Select a supplier')
    setBusy(true)
    try {
      const po = unwrap(
        await db
          .from('purchase_orders')
          .insert({
            supplier_id: f.supplier_id,
            project_id: f.project_id || null,
            request_id: fromRequest?.id ?? null,
            order_date: f.order_date,
            expected_date: f.expected_date || null,
            currency: f.currency,
            tax_rate: Number(f.tax_rate) || 0,
            delivery_address: f.delivery_address || null,
            terms: f.terms || null,
            notes: f.notes || null,
            status: 'draft',
          })
          .select('id,number')
          .single(),
      ) as { id: string; number: string }
      const ins = await db.from('purchase_order_items').insert(
        items.map((i) => ({ po_id: po.id, material_id: i.material_id, description: i.description.trim(), quantity: Number(i.quantity), unit: i.unit, rate: Number(i.rate) || 0 })),
      )
      if (ins.error) {
        await db.from('purchase_orders').delete().eq('id', po.id)
        throw ins.error
      }
      if (status === 'pending_approval') unwrap(await db.from('purchase_orders').update({ status }).eq('id', po.id))
      if (fromRequest) await db.from('purchase_requests').update({ status: 'ordered' }).eq('id', fromRequest.id)
      toast.success(`Purchase order ${po.number} created`)
      await invalidate('purchase_orders', 'purchase_order_totals', 'purchase_requests')
      onOpenChange(false)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={fromRequest ? `Purchase order from ${fromRequest.number}` : 'New purchase order'}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => save('draft')}>
            Save draft
          </Button>
          <Button variant="primary" loading={busy} onClick={() => save('pending_approval')}>
            <Send /> Submit for approval
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Supplier" required>
          <Select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}>
            <option value="">Select…</option>
            {(suppliers.data ?? []).filter((s) => s.is_active).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Project">
          <Select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
            <option value="">— Head office / store —</option>
            {projects.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency">
          <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            {(settings?.currencies ?? [{ code: 'TZS' }]).map((c) => (
              <option key={c.code}>{c.code}</option>
            ))}
          </Select>
        </Field>
        <Field label="Order date" required>
          <Input type="date" value={f.order_date} onChange={(e) => setF({ ...f, order_date: e.target.value })} />
        </Field>
        <Field label="Expected delivery">
          <Input type="date" min={f.order_date} value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} />
        </Field>
        <Field label="Tax rate %">
          <Input type="number" min={0} max={100} value={f.tax_rate} onChange={(e) => setF({ ...f, tax_rate: e.target.value })} />
        </Field>
        <Field label="Delivery address" className="sm:col-span-3">
          <Input value={f.delivery_address} onChange={(e) => setF({ ...f, delivery_address: e.target.value })} placeholder="Site location / store" />
        </Field>
        <div className="sm:col-span-3">
          <LineItemsEditor items={items} onChange={setItems} />
          <p className="mt-2 text-right text-sm">
            Tax {f.tax_rate}%:{' '}
            <strong className="tabular">{formatNumber((items.reduce((s, i) => s + Number(i.quantity) * Number(i.rate), 0) * Number(f.tax_rate)) / 100)}</strong> · Total:{' '}
            <strong className="tabular">{formatMoney(items.reduce((s, i) => s + Number(i.quantity) * Number(i.rate), 0) * (1 + Number(f.tax_rate) / 100), f.currency)}</strong>
          </p>
        </div>
        <Field label="Terms & conditions" className="sm:col-span-3">
          <Textarea rows={2} value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} />
        </Field>
        <Field label="Notes" className="sm:col-span-3">
          <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  )
}

export function PurchaseOrders({ supplierId }: { supplierId?: string }) {
  const { can } = useAuth()
  const list = useList<PO>('purchase_orders', {
    select: '*, supplier:suppliers(id,name,phone,email,address,tin), project:projects(name,code,location)',
    eq: { supplier_id: supplierId },
    order: { column: 'created_at', ascending: false },
  })
  const totals = useList<{ po_id: string; total: number; qty_ordered: number; qty_received: number }>('purchase_order_totals')
  const rows = useMemo(() => {
    const t = new Map((totals.data ?? []).map((x) => [x.po_id, x]))
    return (list.data ?? []).map((p) => ({ ...p, total: Number(t.get(p.id)?.total ?? 0), received_pct: t.get(p.id)?.qty_ordered ? (Number(t.get(p.id)!.qty_received) / Number(t.get(p.id)!.qty_ordered)) * 100 : 0 }))
  }, [list.data, totals.data])
  const [editor, setEditor] = useState(false)
  const [view, setView] = useState<PO | null>(null)

  return (
    <Card>
      <DataTable
        rows={rows}
        loading={list.isLoading}
        error={list.error}
        rowKey={(r) => r.id}
        isDemo={(r) => r.is_demo}
        onRowClick={setView}
        exportTitle="Purchase orders"
        filters={[{ key: 'status', label: 'Status', options: ['draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'cancelled'].map((s) => ({ value: s, label: humanize(s) })) }]}
        columns={[
          { key: 'number', header: 'PO', cell: (r) => <span className="font-mono font-semibold">{r.number}</span> },
          { key: 'supplier', header: 'Supplier', value: (r) => r.supplier?.name ?? null },
          { key: 'project', header: 'Project', value: (r) => r.project?.name ?? 'Store', hideOnMobile: true },
          { key: 'order_date', header: 'Ordered', format: 'date' },
          { key: 'expected_date', header: 'Expected', format: 'date', hideOnMobile: true },
          { key: 'total', header: 'Total', format: 'money', cell: (r) => formatMoney(r.total, r.currency) },
          { key: 'received_pct', header: 'Received', format: 'percent' },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        ]}
        emptyTitle="No purchase orders"
        toolbar={
          can(P.procurementManage) && (
            <Button size="sm" variant="primary" onClick={() => setEditor(true)}>
              <Plus /> New PO
            </Button>
          )
        }
      />
      {editor && <PurchaseOrderEditor open onOpenChange={setEditor} />}
      {view && <PurchaseOrderView po={view} onClose={() => setView(null)} />}
    </Card>
  )
}

function PurchaseOrderView({ po, onClose }: { po: PO; onClose: () => void }) {
  const { can, settings } = useAuth()
  const invalidate = useInvalidate()
  const [busy, setBusy] = useState(false)
  const [receive, setReceive] = useState(false)
  const items = useQuery({
    queryKey: ['purchase_order_items', po.id],
    queryFn: async () => unwrap(await db.from('purchase_order_items').select('*').eq('po_id', po.id)) as POItem[],
  })
  const subtotal = (items.data ?? []).reduce((s, i) => s + Number(i.amount), 0)
  const tax = (subtotal * Number(po.tax_rate)) / 100

  const setStatus = async (status: string) => {
    setBusy(true)
    try {
      unwrap(await db.from('purchase_orders').update({ status }).eq('id', po.id))
      toast.success(`PO ${humanize(status).toLowerCase()}`)
      await invalidate('purchase_orders', 'purchase_order_totals')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const pdf = async () => {
    const doc = await buildPdf(
      {
        title: `PURCHASE ORDER ${po.number}`,
        subtitle: `Status: ${humanize(po.status)}`,
        company: settings ? { name: settings.company_name, address: settings.address, phone: settings.phone, email: settings.email, tin: settings.tin } : undefined,
        currency: po.currency,
        fields: [
          { label: 'Supplier', value: po.supplier?.name ?? '' },
          { label: 'Order date', value: formatDate(po.order_date) },
          { label: 'Supplier TIN', value: po.supplier?.tin ?? '—' },
          { label: 'Expected', value: formatDate(po.expected_date) },
          { label: 'Supplier contact', value: [po.supplier?.phone, po.supplier?.email].filter(Boolean).join(' · ') || '—' },
          { label: 'Project', value: po.project ? `${po.project.code} ${po.project.name}` : 'Main store' },
          { label: 'Deliver to', value: po.delivery_address ?? po.project?.location ?? '—' },
          { label: 'Currency', value: po.currency },
        ],
        totals: [
          { label: 'Subtotal', value: formatMoney(subtotal, po.currency) },
          { label: `Tax (${po.tax_rate}%)`, value: formatMoney(tax, po.currency) },
          { label: 'TOTAL', value: formatMoney(subtotal + tax, po.currency) },
        ],
        footerNote: po.terms ?? undefined,
      },
      [
        {
          columns: [
            { header: '#', value: (r: POItem & { n: number }) => r.n },
            { header: 'Description', value: (r: POItem) => r.description },
            { header: 'Qty', value: (r: POItem) => r.quantity, format: 'number' },
            { header: 'Unit', value: (r: POItem) => r.unit },
            { header: 'Rate', value: (r: POItem) => r.rate, format: 'money' },
            { header: 'Amount', value: (r: POItem) => r.amount, format: 'money' },
          ],
          rows: (items.data ?? []).map((r, i) => ({ ...r, n: i + 1 })),
        },
      ],
      (doc, y) => {
        doc.setFontSize(9)
        doc.text('Authorised by: ______________________', 14, y + 12)
        doc.text(po.status === 'approved' || po.status === 'sent' ? `Approved ${formatDate(po.approved_at)}` : 'NOT YET APPROVED', 14, y + 18)
        if (po.terms) doc.text(`Terms: ${po.terms}`, 14, y + 26, { maxWidth: 180 })
        return y + 32
      },
    )
    doc.save(`${po.number}.pdf`)
  }

  return (
    <>
      <Dialog
        open={!receive}
        onOpenChange={(o) => !o && onClose()}
        size="xl"
        title={`Purchase order ${po.number}`}
        description={<StatusBadge status={po.status} />}
        footer={
          <>
            <Button onClick={pdf}>
              <FileDown /> PDF
            </Button>
            {po.status === 'draft' && can(P.procurementManage) && (
              <Button loading={busy} onClick={() => setStatus('pending_approval')}>
                <Send /> Submit for approval
              </Button>
            )}
            {po.status === 'pending_approval' && can(P.procurementApprove) && (
              <Button variant="primary" loading={busy} onClick={() => setStatus('approved')}>
                <CheckCircle2 /> Approve
              </Button>
            )}
            {po.status === 'approved' && can(P.procurementManage) && (
              <Button loading={busy} onClick={() => setStatus('sent')}>
                <Truck /> Mark sent to supplier
              </Button>
            )}
            {['approved', 'sent', 'partially_received'].includes(po.status) && (can(P.procurementManage) || can(P.inventoryManage)) && (
              <Button variant="primary" onClick={() => setReceive(true)}>
                <PackageCheck /> Receive goods (GRN)
              </Button>
            )}
            {['draft', 'pending_approval', 'approved'].includes(po.status) && can(P.procurementManage) && (
              <Button variant="ghost" loading={busy} onClick={() => setStatus('cancelled')}>
                <Ban /> Cancel PO
              </Button>
            )}
          </>
        }
      >
        <KeyValue
          cols={3}
          items={[
            { label: 'Supplier', value: po.supplier?.name },
            { label: 'Project', value: po.project?.name ?? 'Main store' },
            { label: 'Order date', value: formatDate(po.order_date) },
            { label: 'Expected', value: formatDate(po.expected_date) },
            { label: 'Delivery address', value: po.delivery_address },
            { label: 'Terms', value: po.terms },
          ]}
        />
        {items.isLoading ? (
          <Spinner />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/60 text-left text-[11px] uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2 text-right">Ordered</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(items.data ?? []).map((i) => (
                  <tr key={i.id} className="border-t border-border">
                    <td className="px-3 py-2">{i.description}</td>
                    <td className="px-3 py-2 text-right tabular">
                      {formatNumber(i.quantity)} {i.unit}
                    </td>
                    <td className="px-3 py-2 text-right tabular">{formatNumber(i.received_qty)}</td>
                    <td className="px-3 py-2 text-right tabular">{formatNumber(i.rate)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular">{formatNumber(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-sm">
                <tr className="border-t border-border">
                  <td colSpan={4} className="px-3 py-1.5 text-right text-muted">
                    Subtotal
                  </td>
                  <td className="px-3 py-1.5 text-right tabular">{formatNumber(subtotal)}</td>
                </tr>
                <tr>
                  <td colSpan={4} className="px-3 py-1.5 text-right text-muted">
                    Tax {po.tax_rate}%
                  </td>
                  <td className="px-3 py-1.5 text-right tabular">{formatNumber(tax)}</td>
                </tr>
                <tr className="bg-black text-white">
                  <td colSpan={4} className="px-3 py-2 text-right font-semibold">
                    TOTAL
                  </td>
                  <td className="px-3 py-2 text-right font-bold tabular text-accent">{formatMoney(subtotal + tax, po.currency)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Dialog>
      {receive && (
        <GoodsReceiveDialog
          po={po}
          items={items.data ?? []}
          onDone={() => {
            setReceive(false)
            onClose()
          }}
          onCancel={() => setReceive(false)}
        />
      )}
    </>
  )
}

// =============================================================================
// Goods received
// =============================================================================
function GoodsReceiveDialog({ po, items, onDone, onCancel }: { po: PO; items: POItem[]; onDone: () => void; onCancel: () => void }) {
  const invalidate = useInvalidate()
  const [busy, setBusy] = useState(false)
  const [head, setHead] = useState({ received_date: today(), delivery_note_no: '', notes: '' })
  const [lines, setLines] = useState(
    items.map((i) => ({ item: i, received: String(Math.max(0, Number(i.quantity) - Number(i.received_qty))), rejected: '0', remarks: '' })),
  )
  const nonStock = items.filter((i) => !i.material_id).length

  const submit = async () => {
    const toPost = lines.filter((l) => Number(l.received) > 0 && l.item.material_id)
    if (toPost.length === 0) return toast.error('Enter a received quantity for at least one stock item')
    for (const l of toPost) {
      if (Number(l.received) + Number(l.item.received_qty) > Number(l.item.quantity) * 1.1)
        return toast.error(`${l.item.description}: receiving more than ordered (+10% tolerance)`)
    }
    setBusy(true)
    try {
      const grn = unwrap(
        await db
          .from('goods_received')
          .insert({ po_id: po.id, supplier_id: po.supplier_id, project_id: po.project_id, received_date: head.received_date, delivery_note_no: head.delivery_note_no || null, notes: head.notes || null })
          .select('id,number')
          .single(),
      ) as { id: string; number: string }
      for (const l of toPost) {
        unwrap(
          await db.from('goods_received_items').insert({
            grn_id: grn.id,
            po_item_id: l.item.id,
            material_id: l.item.material_id,
            quantity_received: Number(l.received),
            quantity_rejected: Number(l.rejected) || 0,
            unit_price: Number(l.item.rate),
            remarks: l.remarks || null,
          }),
        )
      }
      toast.success(`${grn.number} posted — stock updated`)
      await invalidate('goods_received', 'purchase_orders', 'purchase_order_totals', 'purchase_order_items', 'materials', 'inventory_transactions')
      onDone()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      size="xl"
      title={`Goods received against ${po.number}`}
      description={po.supplier?.name}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Back
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            <PackageCheck /> Post GRN & update stock
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Received date" required>
          <Input type="date" max={today()} value={head.received_date} onChange={(e) => setHead({ ...head, received_date: e.target.value })} />
        </Field>
        <Field label="Delivery note no.">
          <Input value={head.delivery_note_no} onChange={(e) => setHead({ ...head, delivery_note_no: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Input value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-surface-2/60 text-left text-[11px] uppercase text-muted">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2 text-right">Outstanding</th>
              <th className="w-28 px-3 py-2 text-right">Received</th>
              <th className="w-24 px-3 py-2 text-right">Rejected</th>
              <th className="px-3 py-2">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.item.id} className="border-t border-border">
                <td className="px-3 py-2">
                  {l.item.description}
                  {!l.item.material_id && <span className="ml-2 text-xs text-subtle">(non-stock)</span>}
                </td>
                <td className="px-3 py-2 text-right tabular">
                  {formatNumber(Number(l.item.quantity) - Number(l.item.received_qty))} {l.item.unit}
                </td>
                <td className="p-1">
                  <Input type="number" min={0} step="any" disabled={!l.item.material_id} className="h-9 text-right" value={l.received} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, received: e.target.value } : x)))} aria-label="Quantity received" />
                </td>
                <td className="p-1">
                  <Input type="number" min={0} step="any" disabled={!l.item.material_id} className="h-9 text-right" value={l.rejected} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, rejected: e.target.value } : x)))} aria-label="Quantity rejected" />
                </td>
                <td className="p-1">
                  <Input className="h-9" value={l.remarks} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, remarks: e.target.value } : x)))} aria-label="Remarks" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nonStock > 0 && <p className="mt-2 text-xs text-muted">{nonStock} non-stock line(s) are not posted to inventory.</p>}
    </Dialog>
  )
}

export function GoodsReceivedList() {
  const list = useList<any>('goods_received', {
    select: '*, supplier:suppliers(name), po:purchase_orders(number), project:projects(name), receiver:profiles!goods_received_received_by_fkey(full_name), items:goods_received_items(quantity_received,quantity_rejected,unit_price)',
    order: { column: 'received_date', ascending: false },
  })
  return (
    <Card>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        error={list.error}
        rowKey={(r) => r.id}
        isDemo={(r) => r.is_demo}
        exportTitle="Goods received notes"
        columns={[
          { key: 'number', header: 'GRN', cell: (r) => <span className="font-mono font-semibold">{r.number}</span> },
          { key: 'received_date', header: 'Date', format: 'date' },
          { key: 'supplier', header: 'Supplier', value: (r) => r.supplier?.name },
          { key: 'po', header: 'PO', value: (r) => r.po?.number ?? '—' },
          { key: 'project', header: 'Project', value: (r) => r.project?.name ?? 'Store', hideOnMobile: true },
          { key: 'delivery_note_no', header: 'Delivery note', hideOnMobile: true },
          { key: 'lines', header: 'Lines', format: 'number', value: (r) => r.items?.length ?? 0 },
          { key: 'value', header: 'Value', format: 'money', value: (r) => (r.items ?? []).reduce((s: number, i: any) => s + i.quantity_received * i.unit_price, 0) },
          { key: 'receiver', header: 'Received by', value: (r) => r.receiver?.full_name, hideOnMobile: true },
        ]}
        emptyTitle="No goods received yet"
        emptyDescription="Open an approved purchase order and choose “Receive goods” to post a GRN."
      />
    </Card>
  )
}
