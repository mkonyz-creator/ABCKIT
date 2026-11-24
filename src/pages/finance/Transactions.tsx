import { Ban, CheckCircle2, FileDown, Paperclip, Upload, XCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ResourcePage } from '@/components/crud/ResourcePage'
import type { FieldDef } from '@/components/crud/ResourceForm'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Badge, MenuItem, StatusBadge } from '@/components/ui/misc'
import { buildPdf } from '@/lib/export'
import { downloadDocument, uploadDocument } from '@/lib/documents'
import { useInvalidate } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db, unwrap } from '@/lib/backend'
import { errorMessage, formatDate, formatMoney, humanize } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

export const INCOME_CATEGORIES = ['client_payment', 'advance_payment', 'other_income'].map((v) => ({ value: v, label: humanize(v) }))
export const EXPENSE_CATEGORIES = ['material', 'labour', 'equipment', 'fuel', 'subcontractor', 'supplier_payment', 'petty_cash', 'transport', 'permits_fees', 'utilities', 'overhead', 'salaries', 'other_expense'].map((v) => ({ value: v, label: humanize(v) }))
const METHODS = ['cash', 'bank_transfer', 'cheque', 'mobile_money', 'card', 'other'].map((v) => ({ value: v, label: humanize(v) }))

export interface Txn {
  id: string
  number: string
  project_id: string | null
  direction: 'income' | 'expense'
  category: string
  amount: number
  currency: string
  exchange_rate: number
  amount_base: number
  transaction_date: string
  payment_method: string
  reference_no: string | null
  payee_payer: string | null
  description: string
  status: 'pending' | 'approved' | 'rejected' | 'void'
  attachment_path: string | null
  void_reason: string | null
  created_by: string
  approved_at: string | null
  is_demo: boolean
  project?: { name: string; code: string } | null
  creator?: { full_name: string } | null
  approver?: { full_name: string } | null
}

function fields(projectId?: string, preset?: { direction?: 'income' | 'expense'; category?: string }): FieldDef[] {
  return [
    { name: 'direction', label: 'Type', type: 'select', required: true, defaultValue: preset?.direction ?? 'expense', options: [{ value: 'expense', label: 'Expense / payment out' }, { value: 'income', label: 'Income / receipt' }], disabled: () => !!preset?.direction },
    { name: 'category_in', label: 'Category', type: 'select', options: INCOME_CATEGORIES, hidden: (v) => v.direction !== 'income', defaultValue: 'client_payment' },
    { name: 'category_out', label: 'Category', type: 'select', options: EXPENSE_CATEGORIES, hidden: (v) => v.direction !== 'expense', defaultValue: preset?.category ?? 'material', disabled: () => !!preset?.category },
    ...(projectId
      ? []
      : [{ name: 'project_id', label: 'Project', type: 'relation' as const, hint: 'Blank = company overhead', relation: { table: 'projects', select: 'id,name,code,is_archived', label: (p: any) => `${p.code} · ${p.name}`, order: 'name', filter: (p: any) => !p.is_archived } }]),
    { name: 'transaction_date', label: 'Date', type: 'date', required: true, defaultValue: () => new Date().toISOString().slice(0, 10) },
    { name: 'amount', label: 'Amount', type: 'money', required: true, min: 0.01 },
    { name: 'currency', label: 'Currency', type: 'currency', required: true, defaultValue: 'TZS' },
    { name: 'exchange_rate', label: 'Exchange rate to base', type: 'number', min: 0.000001, defaultValue: 1, hint: '1 for TZS', hidden: (v) => (v.currency || 'TZS') === 'TZS' },
    { name: 'payment_method', label: 'Payment method', type: 'select', required: true, defaultValue: 'bank_transfer', options: METHODS },
    { name: 'reference_no', label: 'Reference no.', type: 'text', placeholder: 'Cheque / bank / M-Pesa ref' },
    { name: 'payee_payer', label: 'Paid to / received from', type: 'text' },
    { name: 'client_id', label: 'Client', type: 'relation', hidden: (v) => v.direction !== 'income', relation: { table: 'clients', select: 'id,name', label: (c) => c.name, order: 'name' } },
    { name: 'client_invoice_id', label: 'Against client invoice', type: 'relation', hidden: (v) => v.direction !== 'income', relation: { table: 'client_invoices', select: 'id,number,status,total', label: (c) => `${c.number} (${humanize(c.status)})`, order: 'number', filter: (c) => c.status !== 'void' } },
    { name: 'supplier_id', label: 'Supplier', type: 'relation', hidden: (v) => v.direction !== 'expense', relation: { table: 'suppliers', select: 'id,name', label: (s) => s.name, order: 'name' } },
    { name: 'supplier_invoice_id', label: 'Against supplier invoice', type: 'relation', hidden: (v) => v.direction !== 'expense', relation: { table: 'supplier_invoices', select: 'id,invoice_no,status', label: (s) => `${s.invoice_no} (${humanize(s.status)})`, order: 'invoice_no', filter: (s) => !['paid', 'void'].includes(s.status) } },
    { name: 'description', label: 'Description', type: 'textarea', required: true, maxLength: 1000 },
  ]
}

export function Transactions({ projectId, preset, title = 'Transactions' }: { projectId?: string; preset?: { direction?: 'income' | 'expense'; category?: string }; title?: string }) {
  const { can, profile, settings } = useAuth()
  const invalidate = useInvalidate()
  const [voiding, setVoiding] = useState<Txn | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [attachFor, setAttachFor] = useState<Txn | null>(null)

  const act = async (t: Txn, patch: Record<string, unknown>, msg: string) => {
    setBusy(true)
    try {
      unwrap(await db.from('financial_transactions').update(patch).eq('id', t.id))
      toast.success(msg)
      await invalidate('financial_transactions', 'project_financials', 'supplier_invoice_balances', 'client_invoice_balances')
      setVoiding(null)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const attach = async (file: File | undefined) => {
    if (!file || !attachFor) return
    try {
      const { path } = await uploadDocument({
        file,
        projectId: attachFor.project_id,
        title: `${attachFor.number} – ${attachFor.direction === 'income' ? 'receipt' : 'voucher'} attachment`,
        category: attachFor.direction === 'income' ? 'receipt' : 'invoice',
        accessLevel: 'management',
        tags: ['finance', attachFor.number],
      })
      if (attachFor.status === 'pending') unwrap(await db.from('financial_transactions').update({ attachment_path: path }).eq('id', attachFor.id))
      toast.success('Attachment uploaded to the document repository')
      await invalidate('financial_transactions', 'documents')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setAttachFor(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const voucher = async (t: Txn) => {
    const isIncome = t.direction === 'income'
    const doc = await buildPdf(
      {
        title: isIncome ? `RECEIPT ${t.number}` : `PAYMENT VOUCHER ${t.number}`,
        subtitle: `Status: ${humanize(t.status)}`,
        company: settings ? { name: settings.company_name, address: settings.address, phone: settings.phone, email: settings.email, tin: settings.tin } : undefined,
        fields: [
          { label: 'Date', value: formatDate(t.transaction_date) },
          { label: isIncome ? 'Received from' : 'Paid to', value: t.payee_payer ?? '—' },
          { label: 'Project', value: t.project ? `${t.project.code} ${t.project.name}` : 'Company overhead' },
          { label: 'Category', value: humanize(t.category) },
          { label: 'Method', value: humanize(t.payment_method) },
          { label: 'Reference', value: t.reference_no ?? '—' },
        ],
      },
      [
        {
          columns: [
            { header: 'Description', value: (r: Txn) => r.description },
            { header: 'Currency', value: (r: Txn) => r.currency },
            { header: 'Amount', value: (r: Txn) => r.amount, format: 'money' },
          ],
          rows: [t],
          footRows: t.currency !== (settings?.default_currency ?? 'TZS') ? [['', 'Base amount', formatMoney(t.amount_base)]] : undefined,
        },
      ],
      (doc, y) => {
        doc.setFontSize(9)
        const line = (label: string, x: number, name?: string) => {
          doc.text(label, x, y + 14)
          doc.line(x, y + 26, x + 55, y + 26)
          if (name) doc.text(name, x, y + 31)
        }
        line(isIncome ? 'Received by' : 'Prepared by', 14, t.creator?.full_name)
        line('Approved by', 78, t.approver?.full_name)
        line(isIncome ? 'Payer' : 'Payee signature', 142)
        return y + 36
      },
    )
    doc.save(`${t.number}.pdf`)
  }

  return (
    <>
      <ResourcePage<Txn>
        config={{
          table: 'financial_transactions',
          select: '*, project:projects(name,code), creator:profiles!financial_transactions_created_by_fkey(full_name), approver:profiles!financial_transactions_approved_by_fkey(full_name)',
          singular: preset?.category === 'petty_cash' ? 'Petty cash entry' : 'Transaction',
          plural: title,
          eq: { project_id: projectId, category: preset?.category },
          order: { column: 'transaction_date', ascending: false },
          perms: { create: P.financeManage, edit: P.financeManage },
          canEditRow: (t) => t.status === 'pending',
          invalidate: ['project_financials', 'supplier_invoice_balances', 'client_invoice_balances'],
          fields: fields(projectId, preset),
          createDefaults: projectId ? { project_id: projectId } : undefined,
          beforeEdit: (t) => ({ ...t, category_in: t.direction === 'income' ? t.category : undefined, category_out: t.direction === 'expense' ? t.category : undefined }),
          beforeSave: (v) => {
            const out: Record<string, any> = { ...v, category: v.direction === 'income' ? v.category_in : v.category_out }
            delete out.category_in
            delete out.category_out
            if (!out.exchange_rate || out.currency === 'TZS') out.exchange_rate = 1
            if (out.direction === 'income') {
              out.supplier_id = null
              out.supplier_invoice_id = null
            } else {
              out.client_id = null
              out.client_invoice_id = null
            }
            if (preset?.direction) out.direction = preset.direction
            if (preset?.category) out.category = preset.category
            for (const k of ['project', 'creator', 'approver', 'amount_base', 'number']) delete out[k]
            return out
          },
          filters: [
            { key: 'direction', label: 'Type', options: [{ value: 'income', label: 'Income' }, { value: 'expense', label: 'Expense' }] },
            { key: 'category', label: 'Category', options: [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES] },
            { key: 'status', label: 'Status', options: ['pending', 'approved', 'rejected', 'void'].map((s) => ({ value: s, label: humanize(s) })) },
            { key: 'payment_method', label: 'Method', options: METHODS },
          ],
          extraActions: (t) => (
            <>
              <MenuItem onSelect={() => voucher(t).catch((e) => toast.error(errorMessage(e)))}>
                <FileDown /> {t.direction === 'income' ? 'Receipt' : 'Payment voucher'} (PDF)
              </MenuItem>
              {t.attachment_path && (
                <MenuItem onSelect={() => downloadDocument(t.attachment_path!, `${t.number}-attachment`).catch((e) => toast.error(errorMessage(e)))}>
                  <Paperclip /> Open attachment
                </MenuItem>
              )}
              {can(P.financeManage) && t.status === 'pending' && (
                <MenuItem
                  onSelect={() => {
                    setAttachFor(t)
                    setTimeout(() => fileRef.current?.click(), 0)
                  }}
                >
                  <Upload /> Attach receipt / invoice
                </MenuItem>
              )}
              {can(P.financeApprove) && t.status === 'pending' && (
                <>
                  <MenuItem disabled={busy || (t.created_by === profile?.id && !['super_admin', 'managing_director'].includes(profile?.role?.key ?? ''))} onSelect={() => act(t, { status: 'approved' }, 'Transaction approved')}>
                    <CheckCircle2 /> Approve
                  </MenuItem>
                  <MenuItem onSelect={() => act(t, { status: 'rejected' }, 'Transaction rejected')}>
                    <XCircle /> Reject
                  </MenuItem>
                </>
              )}
              {can(P.financeApprove) && t.status === 'approved' && (
                <MenuItem danger onSelect={() => setVoiding(t)}>
                  <Ban /> Void
                </MenuItem>
              )}
            </>
          ),
          columns: [
            { key: 'transaction_date', header: 'Date', format: 'date', cell: (t) => <div><p className="font-medium">{formatDate(t.transaction_date)}</p><p className="font-mono text-xs text-subtle">{t.number}</p></div> },
            { key: 'direction', header: 'Type', cell: (t) => <Badge tone={t.direction === 'income' ? 'success' : 'accent'}>{t.direction === 'income' ? 'Income' : 'Expense'}</Badge> },
            { key: 'category', header: 'Category', value: (t) => humanize(t.category) },
            { key: 'description', header: 'Description', className: 'max-w-xs truncate' },
            ...(projectId ? [] : [{ key: 'project', header: 'Project', value: (t: Txn) => t.project?.name ?? 'Overhead', hideOnMobile: true }]),
            { key: 'payee_payer', header: 'Party', hideOnMobile: true },
            {
              key: 'amount_base',
              header: 'Amount',
              format: 'money',
              cell: (t) => (
                <span className={t.status === 'void' || t.status === 'rejected' ? 'text-subtle line-through' : t.direction === 'income' ? 'font-semibold text-success' : 'font-semibold'}>
                  {t.direction === 'income' ? '+' : '−'}
                  {formatMoney(t.amount, t.currency)}
                </span>
              ),
            },
            { key: 'payment_method', header: 'Method', value: (t) => humanize(t.payment_method), hideOnMobile: true },
            { key: 'status', header: 'Status', cell: (t) => <span className="inline-flex items-center gap-1"><StatusBadge status={t.status} />{t.attachment_path && <Paperclip className="size-3.5 text-subtle" aria-label="Has attachment" />}</span> },
          ],
          emptyDescription: 'Every payment and receipt is recorded here with an approval step and a full audit trail.',
        }}
      />
      <input ref={fileRef} type="file" className="hidden" accept=".pdf,image/*,.doc,.docx,.xls,.xlsx" onChange={(e) => attach(e.target.files?.[0])} />
      <ConfirmDialog
        open={!!voiding}
        onOpenChange={(o) => !o && setVoiding(null)}
        title={`Void ${voiding?.number}?`}
        message="Voided transactions stay in the ledger for audit but no longer count towards totals. This cannot be undone."
        requireReason="Reason for voiding"
        confirmLabel="Void transaction"
        danger
        loading={busy}
        onConfirm={(reason) => voiding && act(voiding, { status: 'void', void_reason: reason }, 'Transaction voided')}
      />
    </>
  )
}
