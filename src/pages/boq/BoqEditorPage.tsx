import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  Lock,
  MoreHorizontal,
  Plus,
  Printer,
  Send,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Select } from '@/components/ui/form'
import { Badge, Card, CardHeader, DemoBadge, EmptyState, ErrorState, KeyValue, Menu, MenuContent, MenuItem, MenuTrigger, PageHeader, Spinner, StatusBadge } from '@/components/ui/misc'
import { boqTotals, itemAmount, variance, type TaxLine } from '@/lib/calc'
import { buildPdf } from '@/lib/export'
import { useInvalidate, useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db, unwrap } from '@/lib/backend'
import type { Boq, BoqItem, BoqSection, ProjectFinancials } from '@/lib/types'
import { cn, downloadBlob, errorMessage, formatDateTime, formatMoney, formatNumber, humanize, slug } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

export default function BoqEditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const invalidate = useInvalidate()
  const { can, settings } = useAuth()

  const boqQ = useQuery({
    queryKey: ['boqs', 'one', id],
    queryFn: async () => unwrap(await db.from('boqs').select('*, project:projects(id,name,code,client:clients(name),location)').eq('id', id!).single()) as Boq & {
      project: { id: string; name: string; code: string; location: string | null; client: { name: string } | null }
    },
  })
  const sectionsQ = useQuery({
    queryKey: ['boq_sections', id],
    queryFn: async () => unwrap(await db.from('boq_sections').select('*').eq('boq_id', id!).order('sort_order').order('created_at')) as BoqSection[],
  })
  const itemsQ = useQuery({
    queryKey: ['boq_items', id],
    queryFn: async () => unwrap(await db.from('boq_items').select('*').eq('boq_id', id!).order('sort_order').order('created_at')) as BoqItem[],
  })
  const finQ = useList<ProjectFinancials>('project_financials', { eq: { project_id: boqQ.data?.project_id }, enabled: !!boqQ.data && can(P.financeView) })
  const breakdownQ = useList<{ category: string; amount: number }>('project_cost_breakdown', { eq: { project_id: boqQ.data?.project_id }, enabled: !!boqQ.data && can(P.financeView) })

  const boq = boqQ.data
  const sections = sectionsQ.data ?? []
  const items = itemsQ.data ?? []
  const locked = !boq || boq.status === 'approved' || boq.status === 'superseded' || !can(P.boqManage)
  const totals = useMemo(() => boqTotals(items, boq?.taxes ?? []), [items, boq?.taxes])
  const [confirm, setConfirm] = useState<null | { kind: 'section' | 'item'; id: string; label: string }>(null)
  const [busy, setBusy] = useState(false)

  const setItemsCache = (fn: (rows: BoqItem[]) => BoqItem[]) => qc.setQueryData<BoqItem[]>(['boq_items', id], (old) => fn(old ?? []))

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      if (label) toast.success(label)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const addSection = () =>
    run('', async () => {
      const nextCode = String.fromCharCode(65 + Math.min(25, sections.length))
      unwrap(await db.from('boq_sections').insert({ boq_id: id, code: nextCode, title: 'New section', sort_order: sections.length + 1 }))
      await qc.invalidateQueries({ queryKey: ['boq_sections', id] })
    })

  const addItem = (section: BoqSection) =>
    run('', async () => {
      const inSection = items.filter((i) => i.section_id === section.id)
      const row = unwrap(
        await db
          .from('boq_items')
          .insert({
            section_id: section.id,
            item_code: `${section.code ?? ''}${inSection.length + 1}`,
            description: 'New item',
            unit: 'm²',
            quantity: 0,
            rate: 0,
            sort_order: inSection.length + 1,
          })
          .select()
          .single(),
      ) as BoqItem
      setItemsCache((rows) => [...rows, row])
    })

  const updateItem = async (item: BoqItem, patch: Partial<BoqItem>) => {
    const prev = item
    setItemsCache((rows) => rows.map((r) => (r.id === item.id ? { ...r, ...patch, amount: itemAmount(patch.quantity ?? r.quantity, patch.rate ?? r.rate) } : r)))
    const { data, error } = await db.from('boq_items').update(patch).eq('id', item.id).select().single()
    if (error) {
      setItemsCache((rows) => rows.map((r) => (r.id === item.id ? prev : r)))
      toast.error(errorMessage(error))
    } else setItemsCache((rows) => rows.map((r) => (r.id === item.id ? (data as BoqItem) : r)))
  }

  const updateSection = (s: BoqSection, patch: Partial<BoqSection>) =>
    run('', async () => {
      unwrap(await db.from('boq_sections').update(patch).eq('id', s.id))
      await qc.invalidateQueries({ queryKey: ['boq_sections', id] })
    })

  const doDelete = () =>
    run('Deleted', async () => {
      if (!confirm) return
      unwrap(await db.from(confirm.kind === 'section' ? 'boq_sections' : 'boq_items').delete().eq('id', confirm.id))
      setConfirm(null)
      await Promise.all([qc.invalidateQueries({ queryKey: ['boq_sections', id] }), qc.invalidateQueries({ queryKey: ['boq_items', id] })])
    })

  const setStatus = (status: Boq['status']) =>
    run(status === 'approved' ? 'BOQ approved and locked' : 'Status updated', async () => {
      unwrap(await db.from('boqs').update({ status }).eq('id', id!))
      await invalidate('boqs', 'boq_totals')
    })

  const saveTaxes = (taxes: TaxLine[]) =>
    run('', async () => {
      unwrap(await db.from('boqs').update({ taxes }).eq('id', id!))
      await qc.invalidateQueries({ queryKey: ['boqs', 'one', id] })
    })

  const duplicate = () =>
    run('Revision created', async () => {
      const newId = unwrap(await db.rpc('duplicate_boq', { p_boq: id })) as string
      await invalidate('boqs')
      navigate(`/boq/${newId}`)
    })

  // -------------------------------------------------------------- exports
  const company = settings ? { name: settings.company_name, address: settings.address, phone: settings.phone, email: settings.email, tin: settings.tin } : undefined
  const exportPdf = () =>
    run('', async () => {
      if (!boq) return
      const doc = await buildPdf(
        {
          title: `Bill of Quantities — ${boq.title}`,
          subtitle: `${boq.number} · ${humanize(boq.status)}${boq.approved_at ? ` on ${formatDateTime(boq.approved_at)}` : ''}`,
          company,
          currency: boq.currency,
          orientation: 'portrait',
          fields: [
            { label: 'Project', value: `${boq.project.code} – ${boq.project.name}` },
            { label: 'Client', value: boq.project.client?.name ?? '—' },
            { label: 'Location', value: boq.project.location ?? '—' },
            { label: 'Currency', value: boq.currency },
          ],
          totals: [
            { label: 'Subtotal', value: formatMoney(totals.subtotal, boq.currency) },
            ...totals.taxes.map((t) => ({ label: `${t.name} (${t.rate}%)`, value: formatMoney(t.amount, boq.currency) })),
            { label: 'GRAND TOTAL', value: formatMoney(totals.grandTotal, boq.currency) },
          ],
        },
        sections.map((s) => ({
          heading: `${s.code ? s.code + ' – ' : ''}${s.title}`,
          columns: [
            { header: 'Item', value: (r: BoqItem) => r.item_code, width: 12 },
            { header: 'Description', value: (r: BoqItem) => r.description },
            { header: 'Unit', value: (r: BoqItem) => r.unit },
            { header: 'Qty', value: (r: BoqItem) => r.quantity, format: 'number' as const },
            { header: 'Rate', value: (r: BoqItem) => r.rate, format: 'money' as const },
            { header: 'Amount', value: (r: BoqItem) => r.amount, format: 'money' as const },
          ],
          rows: items.filter((i) => i.section_id === s.id),
          footRows: [['', `Section ${s.code ?? ''} total`, '', '', '', formatNumber(totals.sections[s.id] ?? 0, 2)]],
        })),
      )
      doc.save(`${slug(boq.number + '-' + boq.title)}.pdf`)
    })

  const exportXlsx = () =>
    run('', async () => {
      if (!boq) return
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('BOQ', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1 } })
      ws.columns = [
        { header: 'Item', key: 'code', width: 10 },
        { header: 'Description', key: 'desc', width: 60 },
        { header: 'Unit', key: 'unit', width: 9 },
        { header: 'Qty', key: 'qty', width: 12 },
        { header: 'Rate', key: 'rate', width: 16 },
        { header: 'Amount', key: 'amount', width: 18 },
      ]
      ws.spliceRows(1, 0, [company?.name ?? ''], [`Bill of Quantities — ${boq.title}`], [`${boq.number} · ${boq.project.code} ${boq.project.name}`], [])
      ws.getRow(1).font = { bold: true, size: 14 }
      ws.getRow(2).font = { bold: true, color: { argb: 'FFFF6B00' } }
      const header = ws.getRow(5)
      header.eachCell((c) => {
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } }
      })
      const sectionTotalCells: string[] = []
      for (const s of sections) {
        const sr = ws.addRow({ code: s.code, desc: s.title.toUpperCase() })
        sr.font = { bold: true }
        const first = ws.rowCount + 1
        for (const i of items.filter((x) => x.section_id === s.id)) {
          const r = ws.addRow({ code: i.item_code, desc: i.description, unit: i.unit, qty: Number(i.quantity), rate: Number(i.rate) })
          // live formula so the sheet stays editable: Amount = Qty × Rate
          r.getCell('amount').value = { formula: `D${r.number}*E${r.number}`, result: Number(i.amount) }
        }
        const last = ws.rowCount
        const tr = ws.addRow({ desc: `Total – Section ${s.code ?? ''}` })
        tr.getCell('amount').value = { formula: last >= first ? `SUM(F${first}:F${last})` : '0', result: totals.sections[s.id] ?? 0 }
        tr.font = { bold: true }
        sectionTotalCells.push(`F${tr.number}`)
        ws.addRow({})
      }
      const sub = ws.addRow({ desc: 'SUBTOTAL' })
      sub.getCell('amount').value = { formula: sectionTotalCells.join('+') || '0', result: totals.subtotal }
      sub.font = { bold: true }
      const taxRows: string[] = []
      for (const t of totals.taxes) {
        const tr = ws.addRow({ desc: `${t.name} @ ${t.rate}%` })
        tr.getCell('amount').value = { formula: `F${sub.number}*${t.rate}/100`, result: t.amount }
        taxRows.push(`F${tr.number}`)
      }
      const gt = ws.addRow({ desc: 'GRAND TOTAL' })
      gt.getCell('amount').value = { formula: [`F${sub.number}`, ...taxRows].join('+'), result: totals.grandTotal }
      gt.font = { bold: true, size: 12 }
      ws.getColumn('qty').numFmt = '#,##0.###'
      ws.getColumn('rate').numFmt = '#,##0.00'
      ws.getColumn('amount').numFmt = '#,##0.00'
      ws.getColumn('desc').alignment = { wrapText: true, vertical: 'top' }
      const buf = await wb.xlsx.writeBuffer()
      downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${slug(boq.number + '-' + boq.title)}.xlsx`)
    })

  if (boqQ.error) return <ErrorState error={boqQ.error} onRetry={() => boqQ.refetch()} />
  if (!boq || sectionsQ.isLoading || itemsQ.isLoading) return <Spinner />

  const fin = finQ.data?.[0]
  const comparison = fin ? variance(totals.grandTotal || Number(fin.budget), Number(fin.actual_cost)) : null

  return (
    <div>
      <PageHeader
        breadcrumb={
          <Link to="/boq" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-3" /> BOQ & Estimates
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {boq.title} <StatusBadge status={boq.status} /> {boq.is_demo && <DemoBadge />}
          </span>
        }
        description={
          <>
            <span className="font-mono">{boq.number}</span> · <Link className="text-accent-ink hover:underline" to={`/projects/${boq.project.id}`}>{boq.project.code} {boq.project.name}</Link>
          </>
        }
        actions={
          <>
            <Menu>
              <MenuTrigger asChild>
                <Button>
                  <Download /> Export
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={exportPdf}>
                  <FileText /> PDF document
                </MenuItem>
                <MenuItem onSelect={exportXlsx}>
                  <FileSpreadsheet /> Excel with formulas
                </MenuItem>
                <MenuItem onSelect={() => window.print()}>
                  <Printer /> Print
                </MenuItem>
              </MenuContent>
            </Menu>
            {boq.status === 'draft' && can(P.boqManage) && (
              <Button onClick={() => setStatus('submitted')} loading={busy}>
                <Send /> Submit for approval
              </Button>
            )}
            {(boq.status === 'submitted' || boq.status === 'draft') && can(P.boqApprove) && (
              <Button variant="primary" onClick={() => setStatus('approved')} loading={busy}>
                <CheckCircle2 /> Approve
              </Button>
            )}
            {can(P.boqManage) && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={duplicate}>
                    <Copy /> Create revision (copy)
                  </MenuItem>
                  {boq.status === 'submitted' && (
                    <MenuItem onSelect={() => setStatus('draft')}>
                      <ArrowLeft /> Return to draft
                    </MenuItem>
                  )}
                  {boq.status === 'approved' && can(P.boqApprove) && (
                    <MenuItem onSelect={() => setStatus('superseded')}>
                      <Lock /> Mark superseded
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      {locked && boq.status === 'approved' && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft px-4 py-2.5 text-sm text-success">
          <Lock className="size-4" /> Approved {boq.approved_at ? formatDateTime(boq.approved_at) : ''} — this BOQ is locked. Use “Create revision” to make changes.
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          {sections.length === 0 && (
            <Card>
              <EmptyState title="No sections yet" description="Add a work section (e.g. Substructure, Superstructure, Finishes)." />
            </Card>
          )}
          {sections.map((s) => {
            const rows = items.filter((i) => i.section_id === s.id)
            return (
              <Card key={s.id} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-black px-3 py-2 text-white sm:px-4">
                  <SectionTitle section={s} locked={locked} onSave={(patch) => updateSection(s, patch)} />
                  <span className="ml-auto font-semibold tabular text-accent">{formatMoney(totals.sections[s.id] ?? 0, boq.currency)}</span>
                  {!locked && (
                    <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10" aria-label={`Delete section ${s.title}`} onClick={() => setConfirm({ kind: 'section', id: s.id, label: s.title })}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-surface-2/60 text-[11px] uppercase tracking-wide text-muted">
                      <tr>
                        <th className="w-20 px-3 py-2 text-left">Item</th>
                        <th className="px-3 py-2 text-left">Description</th>
                        <th className="w-24 px-3 py-2 text-left">Unit</th>
                        <th className="w-28 px-3 py-2 text-right">Qty</th>
                        <th className="w-36 px-3 py-2 text-right">Rate</th>
                        <th className="w-40 px-3 py-2 text-right">Amount</th>
                        {!locked && <th className="w-10" />}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((i) => (
                        <ItemRow key={i.id} item={i} locked={locked} units={settings?.units ?? []} onSave={(patch) => updateItem(i, patch)} onDelete={() => setConfirm({ kind: 'item', id: i.id, label: i.description })} />
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-3 py-4 text-center text-sm text-muted">
                            No items in this section.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {!locked && (
                  <div className="border-t border-border px-3 py-2">
                    <Button size="sm" variant="ghost" onClick={() => addItem(s)} disabled={busy}>
                      <Plus /> Add item
                    </Button>
                  </div>
                )}
              </Card>
            )
          })}
          {!locked && (
            <Button onClick={addSection} disabled={busy}>
              <Plus /> Add section
            </Button>
          )}
        </div>

        {/* totals sidebar */}
        <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardHeader title="Summary" description={`${items.length} items in ${sections.length} sections`} />
            <div className="space-y-1.5 px-4 py-3 text-sm sm:px-5">
              {sections.map((s) => (
                <div key={s.id} className="flex justify-between gap-3">
                  <span className="truncate text-muted">
                    {s.code} {s.title}
                  </span>
                  <span className="tabular">{formatNumber(totals.sections[s.id] ?? 0)}</span>
                </div>
              ))}
              <div className="mt-2 flex justify-between border-t border-border pt-2 font-semibold">
                <span>Subtotal</span>
                <span className="tabular">{formatMoney(totals.subtotal, boq.currency)}</span>
              </div>
              <TaxEditor taxes={boq.taxes} locked={locked} onSave={saveTaxes} subtotal={totals.subtotal} currency={boq.currency} />
              <div className="mt-2 flex items-center justify-between rounded-lg bg-black px-3 py-3 text-white">
                <span className="text-xs font-semibold uppercase tracking-wide">Grand total</span>
                <span className="text-lg font-bold tabular text-accent">{formatMoney(totals.grandTotal, boq.currency)}</span>
              </div>
            </div>
          </Card>

          {can(P.financeView) && fin && comparison && (
            <Card>
              <CardHeader title="Estimate vs actual" description="Approved project expenditure against this BOQ" />
              <div className="px-4 py-3 text-sm sm:px-5">
                <KeyValue
                  cols={1}
                  items={[
                    { label: 'BOQ grand total', value: <span className="tabular">{formatMoney(totals.grandTotal, boq.currency)}</span> },
                    { label: 'Project budget', value: <span className="tabular">{formatMoney(fin.budget)}</span> },
                    { label: 'Actual cost to date', value: <span className="tabular">{formatMoney(fin.actual_cost)}</span> },
                    {
                      label: 'Variance',
                      value: (
                        <span className={cn('font-semibold tabular', comparison.overBudget ? 'text-danger' : 'text-success')}>
                          {formatMoney(comparison.variance)} ({comparison.percent}%) {comparison.overBudget ? '— over estimate' : '— within estimate'}
                        </span>
                      ),
                    },
                  ]}
                />
                {(breakdownQ.data ?? []).length > 0 && (
                  <div className="mt-4 border-t border-border pt-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Actual cost by category</p>
                    {(breakdownQ.data ?? []).map((b) => (
                      <div key={b.category} className="flex justify-between py-0.5 text-xs">
                        <span className="text-muted">{humanize(b.category)}</span>
                        <span className="tabular">{formatMoney(b.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}
          {boq.description && (
            <Card className="px-4 py-3 text-sm text-muted sm:px-5">
              <Badge className="mb-2">Notes</Badge>
              <p className="whitespace-pre-wrap">{boq.description}</p>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === 'section' ? 'Delete section?' : 'Delete item?'}
        message={confirm?.kind === 'section' ? `“${confirm?.label}” and all of its items will be deleted.` : `“${confirm?.label}” will be deleted.`}
        confirmLabel="Delete"
        danger
        loading={busy}
        onConfirm={doDelete}
      />
    </div>
  )
}

function SectionTitle({ section, locked, onSave }: { section: BoqSection; locked: boolean; onSave: (p: Partial<BoqSection>) => void }) {
  const [code, setCode] = useState(section.code ?? '')
  const [title, setTitle] = useState(section.title)
  useEffect(() => {
    setCode(section.code ?? '')
    setTitle(section.title)
  }, [section])
  if (locked)
    return (
      <span className="font-semibold">
        <span className="mr-2 font-mono text-accent">{section.code}</span>
        {section.title}
      </span>
    )
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onBlur={() => code !== (section.code ?? '') && onSave({ code })}
        className="w-12 rounded bg-white/10 px-2 py-1 font-mono text-sm text-accent outline-none focus:ring-1 focus:ring-accent"
        aria-label="Section code"
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== section.title && onSave({ title: title.trim() })}
        className="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-sm font-semibold outline-none focus:ring-1 focus:ring-accent"
        aria-label="Section title"
      />
    </div>
  )
}

function ItemRow({ item, locked, units, onSave, onDelete }: { item: BoqItem; locked: boolean; units: string[]; onSave: (p: Partial<BoqItem>) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState({ item_code: item.item_code ?? '', description: item.description, unit: item.unit, quantity: String(item.quantity), rate: String(item.rate) })
  useEffect(() => {
    setDraft({ item_code: item.item_code ?? '', description: item.description, unit: item.unit, quantity: String(item.quantity), rate: String(item.rate) })
  }, [item])

  const commit = (key: keyof typeof draft) => {
    const raw = draft[key]
    if (key === 'quantity' || key === 'rate') {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        toast.error('Quantities and rates must be zero or positive numbers')
        setDraft((d) => ({ ...d, [key]: String(item[key]) }))
        return
      }
      if (n !== Number(item[key])) onSave({ [key]: n } as Partial<BoqItem>)
    } else if (raw !== (item[key] ?? '')) {
      if (key === 'description' && !raw.trim()) return setDraft((d) => ({ ...d, description: item.description }))
      onSave({ [key]: raw } as Partial<BoqItem>)
    }
  }

  const live = itemAmount(draft.quantity, draft.rate)
  const cell = 'w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none hover:border-border focus:border-accent focus:bg-surface'
  if (locked)
    return (
      <tr className="border-t border-border align-top">
        <td className="px-3 py-2 font-mono text-xs">{item.item_code}</td>
        <td className="px-3 py-2 whitespace-pre-wrap">{item.description}</td>
        <td className="px-3 py-2">{item.unit}</td>
        <td className="px-3 py-2 text-right tabular">{formatNumber(item.quantity, 3)}</td>
        <td className="px-3 py-2 text-right tabular">{formatNumber(item.rate)}</td>
        <td className="px-3 py-2 text-right font-semibold tabular">{formatNumber(item.amount)}</td>
      </tr>
    )
  return (
    <tr className="border-t border-border align-top">
      <td className="px-1 py-1">
        <input className={cn(cell, 'font-mono text-xs')} value={draft.item_code} onChange={(e) => setDraft({ ...draft, item_code: e.target.value })} onBlur={() => commit('item_code')} aria-label="Item code" />
      </td>
      <td className="px-1 py-1">
        <textarea rows={1} className={cn(cell, 'min-h-[34px] resize-y')} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} onBlur={() => commit('description')} aria-label="Description" />
      </td>
      <td className="px-1 py-1">
        <Select
          className="h-[34px] border-transparent bg-transparent px-2 hover:border-border"
          value={draft.unit}
          onChange={(e) => {
            setDraft({ ...draft, unit: e.target.value })
            onSave({ unit: e.target.value })
          }}
          aria-label="Unit"
        >
          {[...new Set([draft.unit, ...units])].map((u) => (
            <option key={u}>{u}</option>
          ))}
        </Select>
      </td>
      <td className="px-1 py-1">
        <Input type="number" min={0} step="any" className={cn(cell, 'h-auto text-right')} value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} onBlur={() => commit('quantity')} aria-label="Quantity" />
      </td>
      <td className="px-1 py-1">
        <Input type="number" min={0} step="0.01" className={cn(cell, 'h-auto text-right')} value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} onBlur={() => commit('rate')} aria-label="Unit rate" />
      </td>
      <td className="px-3 py-2.5 text-right font-semibold tabular">{formatNumber(live)}</td>
      <td className="px-1 py-1 text-right">
        <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label="Delete item">
          <Trash2 />
        </Button>
      </td>
    </tr>
  )
}

function TaxEditor({ taxes, locked, onSave, subtotal, currency }: { taxes: TaxLine[]; locked: boolean; onSave: (t: TaxLine[]) => void; subtotal: number; currency: string }) {
  const [rows, setRows] = useState<TaxLine[]>(taxes)
  useEffect(() => setRows(taxes), [taxes])
  const dirty = JSON.stringify(rows) !== JSON.stringify(taxes)
  return (
    <div className="space-y-1.5 pt-1">
      {rows.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          {locked ? (
            <span className="flex-1 text-muted">
              {t.name} ({t.rate}%)
            </span>
          ) : (
            <>
              <input className="w-20 rounded border border-border bg-surface px-2 py-1 text-xs" value={t.name} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} aria-label="Tax name" />
              <input type="number" min={0} max={100} step="0.01" className="w-16 rounded border border-border bg-surface px-2 py-1 text-right text-xs tabular" value={t.rate} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, rate: Number(e.target.value) } : r)))} aria-label="Tax rate percent" />
              <span className="text-xs text-muted">%</span>
              <button className="text-subtle hover:text-danger" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove tax">
                <Trash2 className="size-3.5" />
              </button>
            </>
          )}
          <span className="ml-auto tabular">{formatMoney((subtotal * (Number(t.rate) || 0)) / 100, currency)}</span>
        </div>
      ))}
      {!locked && (
        <div className="flex gap-2 pt-1">
          <button className="text-xs font-semibold text-accent-ink hover:underline" onClick={() => setRows([...rows, { name: 'Tax', rate: 0 }])}>
            + Add tax
          </button>
          {dirty && (
            <button
              className="ml-auto text-xs font-semibold text-accent-ink hover:underline"
              onClick={() => {
                if (rows.some((r) => !r.name.trim() || r.rate < 0 || r.rate > 100)) return toast.error('Each tax needs a name and a rate between 0 and 100')
                onSave(rows.map((r) => ({ name: r.name.trim(), rate: Number(r.rate) })))
              }}
            >
              Save taxes
            </button>
          )}
        </div>
      )}
    </div>
  )
}
