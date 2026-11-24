import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Card, PageHeader, StatusBadge } from '@/components/ui/misc'
import { useList, useProjectOptions } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db } from '@/lib/backend'
import type { Boq } from '@/lib/types'
import { errorMessage, formatMoney } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

interface BoqRow extends Boq {
  subtotal: number
  grand_total: number
  item_count: number
}

export function BoqList({ projectId }: { projectId?: string }) {
  const navigate = useNavigate()
  const { can, settings } = useAuth()
  const boqs = useList<Boq>('boqs', {
    select: '*, project:projects(id,name,code)',
    eq: projectId ? { project_id: projectId } : undefined,
    order: { column: 'updated_at', ascending: false },
  })
  const totals = useList<{ boq_id: string; subtotal: number; grand_total: number; item_count: number }>('boq_totals', {
    eq: projectId ? { project_id: projectId } : undefined,
  })
  const rows: BoqRow[] = useMemo(() => {
    const t = new Map((totals.data ?? []).map((x) => [x.boq_id, x]))
    return (boqs.data ?? []).map((b) => ({ ...b, subtotal: Number(t.get(b.id)?.subtotal ?? 0), grand_total: Number(t.get(b.id)?.grand_total ?? 0), item_count: Number(t.get(b.id)?.item_count ?? 0) }))
  }, [boqs.data, totals.data])

  const [open, setOpen] = useState(false)
  const projects = useProjectOptions()
  const [form, setForm] = useState({ project_id: projectId ?? '', title: '', description: '' })
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (!form.project_id || form.title.trim().length < 2) return toast.error('Choose a project and enter a title')
    setBusy(true)
    const { data, error } = await db
      .from('boqs')
      .insert({
        project_id: form.project_id,
        title: form.title.trim(),
        description: form.description.trim() || null,
        currency: settings?.default_currency ?? 'TZS',
        taxes: settings?.taxes ?? [{ name: 'VAT', rate: 18 }],
      })
      .select('id')
      .single()
    if (!error) {
      // start with one section so the editor is immediately usable
      await db.from('boq_sections').insert({ boq_id: data.id, code: 'A', title: 'Preliminaries', sort_order: 1 })
    }
    setBusy(false)
    if (error) return toast.error(errorMessage(error))
    navigate(`/boq/${data.id}`)
  }

  return (
    <Card>
      <DataTable<BoqRow>
        rows={rows}
        loading={boqs.isLoading}
        error={boqs.error}
        onRetry={() => boqs.refetch()}
        rowKey={(r) => r.id}
        isDemo={(r) => r.is_demo}
        onRowClick={(r) => navigate(`/boq/${r.id}`)}
        exportTitle="Bills of Quantities"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: ['draft', 'submitted', 'approved', 'superseded'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
          },
        ]}
        columns={[
          {
            key: 'title',
            header: 'BOQ',
            value: (r) => `${r.number} ${r.title}`,
            cell: (r) => (
              <div>
                <p className="font-semibold">{r.title}</p>
                <p className="font-mono text-xs text-subtle">{r.number}</p>
              </div>
            ),
          },
          ...(projectId ? [] : [{ key: 'project', header: 'Project', value: (r: BoqRow) => r.project?.name ?? null }]),
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'item_count', header: 'Items', format: 'number' },
          { key: 'subtotal', header: 'Subtotal', format: 'money', cell: (r) => formatMoney(r.subtotal, r.currency), hideOnMobile: true },
          { key: 'grand_total', header: 'Grand total', format: 'money', cell: (r) => <strong>{formatMoney(r.grand_total, r.currency)}</strong> },
          { key: 'updated_at', header: 'Updated', format: 'date', hideOnMobile: true },
        ]}
        emptyTitle="No BOQs yet"
        emptyDescription="Create a Bill of Quantities to price the works section by section."
        toolbar={
          can(P.boqManage) && (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              <Plus /> New BOQ
            </Button>
          )
        }
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New Bill of Quantities"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={create}>
              Create & open editor
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {!projectId && (
            <Field label="Project" required>
              <Select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
                <option value="">Select…</option>
                {projects.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Title" required>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Main building – Tender BOQ" />
          </Field>
          <Field label="Description">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <p className="text-xs text-muted">Taxes default to the company settings ({(settings?.taxes ?? []).map((t) => `${t.name} ${t.rate}%`).join(', ') || 'none'}) and can be changed in the editor.</p>
        </div>
      </Dialog>
    </Card>
  )
}

export default function BoqListPage() {
  return (
    <div>
      <PageHeader title="BOQ & Estimates" description="Bills of Quantities: Amount = Quantity × Unit Rate · Grand Total = Subtotal + Taxes" />
      <BoqList />
    </div>
  )
}
