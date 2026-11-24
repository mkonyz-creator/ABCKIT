import { BarChart3, ClipboardList, FileText, PackageCheck, ShoppingCart, Star, Truck } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { ResourcePage } from '@/components/crud/ResourcePage'
import { DataTable } from '@/components/data/DataTable'
import { Card, PageHeader, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { formatMoney } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { GoodsReceivedList, PurchaseOrders, PurchaseRequests } from './PurchaseDocs'

const SUPPLIER_CATEGORIES = ['Cement & aggregates', 'Steel', 'Timber', 'Hardware', 'Plumbing', 'Electrical', 'Plant hire', 'Transport', 'Fuel', 'Subcontractor', 'Professional services', 'Other'].map((c) => ({ value: c, label: c }))

function Stars({ n }: { n: number | null }) {
  if (!n) return <span className="text-subtle">—</span>
  return (
    <span className="inline-flex" aria-label={`${n} of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} className={`size-3.5 ${i < n ? 'fill-accent text-accent' : 'text-border-strong'}`} />
      ))}
    </span>
  )
}

function SupplierPerformance() {
  const q = useList<any>('supplier_performance', { order: { column: 'order_value', ascending: false } })
  return (
    <Card>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.supplier_id}
        exportTitle="Supplier performance"
        columns={[
          { key: 'name', header: 'Supplier', cell: (r) => <span className="font-semibold">{r.name}</span> },
          { key: 'category', header: 'Category', hideOnMobile: true },
          { key: 'orders', header: 'Orders', format: 'number' },
          { key: 'order_value', header: 'Order value', format: 'money' },
          { key: 'completion', header: 'Fully delivered', format: 'percent', value: (r) => (r.orders ? (r.orders_completed / r.orders) * 100 : null) },
          { key: 'on_time', header: 'On-time delivery', format: 'percent', value: (r) => (r.orders_with_due_date ? (r.on_time_orders / r.orders_with_due_date) * 100 : null) },
          { key: 'outstanding_balance', header: 'Owed to supplier', format: 'money' },
          { key: 'rating', header: 'Rating', cell: (r) => <Stars n={r.rating} />, format: 'number' },
        ]}
        emptyTitle="No supplier activity yet"
      />
    </Card>
  )
}

function SupplierInvoices() {
  return (
    <ResourcePage<any>
      config={{
        table: 'supplier_invoices',
        readFrom: 'supplier_invoice_balances',
        select: '*',
        singular: 'Supplier invoice',
        plural: 'Supplier invoices',
        order: { column: 'invoice_date', ascending: false },
        perms: { create: P.procurementManage, edit: P.procurementManage },
        invalidate: ['supplier_performance'],
        canEditRow: (r) => r.status === 'unpaid',
        filters: [{ key: 'status', label: 'Status', options: ['unpaid', 'partially_paid', 'paid', 'disputed', 'void'].map((s) => ({ value: s, label: s.replace('_', ' ') })) }],
        fields: [
          { name: 'supplier_id', label: 'Supplier', type: 'relation', required: true, relation: { table: 'suppliers', select: 'id,name', label: (s) => s.name, order: 'name' } },
          { name: 'invoice_no', label: 'Supplier invoice no.', type: 'text', required: true },
          { name: 'po_id', label: 'Purchase order', type: 'relation', relation: { table: 'purchase_orders', select: 'id,number,status', label: (p) => `${p.number} (${p.status})`, order: 'number' } },
          { name: 'project_id', label: 'Project', type: 'relation', relation: { table: 'projects', select: 'id,name,code', label: (p) => `${p.code} · ${p.name}`, order: 'name' } },
          { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true, defaultValue: () => new Date().toISOString().slice(0, 10) },
          { name: 'due_date', label: 'Due date', type: 'date' },
          { name: 'amount', label: 'Amount (excl. tax)', type: 'money', required: true },
          { name: 'tax_amount', label: 'Tax amount', type: 'money', defaultValue: 0 },
          { name: 'currency', label: 'Currency', type: 'currency', defaultValue: 'TZS' },
          { name: 'status', label: 'Status', type: 'select', defaultValue: 'unpaid', options: [{ value: 'unpaid', label: 'Unpaid' }, { value: 'disputed', label: 'Disputed' }, { value: 'void', label: 'Void' }] },
          { name: 'notes', label: 'Notes', type: 'textarea' },
        ],
        beforeSave: (v) => {
          const out = { ...v }
          for (const k of ['paid', 'balance', 'total']) delete out[k]
          return out
        },
        columns: [
          { key: 'invoice_no', header: 'Invoice', cell: (r) => <span className="font-mono font-semibold">{r.invoice_no}</span> },
          { key: 'invoice_date', header: 'Date', format: 'date' },
          { key: 'due_date', header: 'Due', format: 'date', hideOnMobile: true },
          { key: 'total', header: 'Total', format: 'money', cell: (r) => formatMoney(r.total, r.currency) },
          { key: 'paid', header: 'Paid', format: 'money' },
          { key: 'balance', header: 'Balance', format: 'money', cell: (r) => <strong className={Number(r.balance) > 0 ? 'text-danger' : ''}>{formatMoney(r.balance, r.currency)}</strong> },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        ],
        emptyDescription: 'Record supplier invoices; payments posted in Finance are matched against them automatically.',
      }}
    />
  )
}

export default function ProcurementPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? (can(P.procurementView) ? 'requests' : 'requests')
  return (
    <div>
      <PageHeader title="Procurement & Suppliers" description="Requisition → approval → purchase order → goods received → invoice → payment." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="requests">
            <ClipboardList /> Requests
          </TabsTrigger>
          {can(P.procurementView) && (
            <>
              <TabsTrigger value="orders">
                <ShoppingCart /> Purchase orders
              </TabsTrigger>
              <TabsTrigger value="grn">
                <PackageCheck /> Goods received
              </TabsTrigger>
              <TabsTrigger value="invoices">
                <FileText /> Supplier invoices
              </TabsTrigger>
              <TabsTrigger value="suppliers">
                <Truck /> Suppliers
              </TabsTrigger>
              <TabsTrigger value="performance">
                <BarChart3 /> Performance
              </TabsTrigger>
            </>
          )}
        </TabsList>
        <TabsContent value="requests">
          <PurchaseRequests />
        </TabsContent>
        <TabsContent value="orders">
          <PurchaseOrders />
        </TabsContent>
        <TabsContent value="grn">
          <GoodsReceivedList />
        </TabsContent>
        <TabsContent value="invoices">
          <SupplierInvoices />
        </TabsContent>
        <TabsContent value="performance">
          <SupplierPerformance />
        </TabsContent>
        <TabsContent value="suppliers">
          <ResourcePage<any>
            config={{
              table: 'suppliers',
              singular: 'Supplier',
              plural: 'Suppliers',
              order: { column: 'name' },
              perms: { create: P.procurementManage, edit: P.procurementManage, remove: P.procurementManage },
              initialSearch: params.get('q') ?? undefined,
              filters: [
                { key: 'category', label: 'Category', options: SUPPLIER_CATEGORIES },
                { key: 'is_active', label: 'Status', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }], predicate: (r, v) => String(r.is_active) === v },
              ],
              fields: [
                { name: 'name', label: 'Supplier name', type: 'text', required: true, span: 2 },
                { name: 'category', label: 'Category', type: 'select', options: SUPPLIER_CATEGORIES },
                { name: 'contact_person', label: 'Contact person', type: 'text' },
                { name: 'phone', label: 'Phone', type: 'tel' },
                { name: 'email', label: 'Email', type: 'email' },
                { name: 'tin', label: 'TIN', type: 'text' },
                { name: 'vrn', label: 'VAT reg. no. (VRN)', type: 'text' },
                { name: 'address', label: 'Address', type: 'text', span: 2 },
                { name: 'payment_terms', label: 'Payment terms', type: 'text', placeholder: 'e.g. 30 days' },
                { name: 'rating', label: 'Rating (1–5)', type: 'select', options: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: '★'.repeat(n) })) },
                { name: 'bank_details', label: 'Bank details', type: 'textarea' },
                { name: 'is_active', label: 'Active supplier', type: 'checkbox', defaultValue: true },
                { name: 'notes', label: 'Notes', type: 'textarea' },
              ],
              beforeSave: (v) => ({ ...v, rating: v.rating ? Number(v.rating) : null }),
              columns: [
                { key: 'name', header: 'Supplier', cell: (r) => <span className="font-semibold">{r.name}</span> },
                { key: 'category', header: 'Category' },
                { key: 'contact_person', header: 'Contact', hideOnMobile: true },
                { key: 'phone', header: 'Phone' },
                { key: 'email', header: 'Email', hideOnMobile: true },
                { key: 'rating', header: 'Rating', format: 'number', cell: (r) => <Stars n={r.rating} /> },
                { key: 'is_active', header: 'Status', value: (r) => (r.is_active ? 'Active' : 'Inactive'), cell: (r) => <StatusBadge status={r.is_active ? 'available' : 'retired'} /> },
              ],
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
