import { Bell, Building2, DatabaseBackup, Hash, History, KeyRound, Plus, Ruler, Save, Trash2, Upload, Wallet } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form'
import { Badge, Card, CardHeader, PageHeader, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useInvalidate, useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db } from '@/lib/backend'
import type { CompanySettings } from '@/lib/types'
import { errorMessage, formatDateTime, humanize } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AiApiKeys } from '@/pages/ai/AiApiKeys'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function useSettingsForm() {
  const { settings, refresh } = useAuth()
  const [s, setS] = useState<CompanySettings | null>(settings)
  const [busy, setBusy] = useState(false)
  useEffect(() => setS(settings), [settings])
  const save = async (patch?: Partial<CompanySettings>) => {
    if (!s) return
    setBusy(true)
    const body = patch ?? s
    const { id: _id, updated_at: _u, ...rest } = body as CompanySettings
    const { error } = await db.from('company_settings').update(patch ? body : rest).eq('id', 1)
    setBusy(false)
    if (error) return toast.error(errorMessage(error))
    toast.success('Settings saved')
    await refresh()
  }
  return { s, setS, save, busy }
}

function Company() {
  const { s, setS, save, busy } = useSettingsForm()
  const logoInput = useRef<HTMLInputElement>(null)
  if (!s) return <Spinner />
  const uploadLogo = async (file?: File) => {
    if (!file) return
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return toast.error('Logo must be PNG, JPG, WebP or SVG')
    if (file.size > 2 * 1024 * 1024) return toast.error('Logo must be 2 MB or smaller')
    const path = `logo-${Date.now()}.${file.name.split('.').pop()}`
    const { error } = await db.storage.from('branding').upload(path, file, { contentType: file.type })
    if (error) return toast.error(errorMessage(error))
    const url = db.storage.from('branding').getPublicUrl(path).data.publicUrl
    setS({ ...s, logo_url: url })
    await save({ logo_url: url })
  }
  return (
    <Card>
      <CardHeader title="Company profile" description="Appears on every exported PDF, voucher, BOQ and report." />
      <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
        <Field label="Company name" required className="sm:col-span-2">
          <Input value={s.company_name} onChange={(e) => setS({ ...s, company_name: e.target.value })} />
        </Field>
        <div className="flex items-center gap-4 sm:col-span-2">
          <div className="flex size-20 items-center justify-center overflow-hidden rounded-lg border border-border bg-white">
            {s.logo_url ? <img src={s.logo_url} alt="Company logo" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-subtle">No logo</span>}
          </div>
          <Button onClick={() => logoInput.current?.click()}>
            <Upload /> Upload logo
          </Button>
          <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => uploadLogo(e.target.files?.[0])} />
        </div>
        <Field label="Address" className="sm:col-span-2">
          <Textarea rows={2} value={s.address ?? ''} onChange={(e) => setS({ ...s, address: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={s.phone ?? ''} onChange={(e) => setS({ ...s, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" value={s.email ?? ''} onChange={(e) => setS({ ...s, email: e.target.value })} />
        </Field>
        <Field label="Website">
          <Input value={s.website ?? ''} onChange={(e) => setS({ ...s, website: e.target.value })} />
        </Field>
        <Field label="TIN">
          <Input value={s.tin ?? ''} onChange={(e) => setS({ ...s, tin: e.target.value })} />
        </Field>
      </div>
      <div className="flex justify-end border-t border-border px-4 py-3">
        <Button variant="primary" loading={busy} onClick={() => (s.company_name.trim() ? save() : toast.error('Company name is required'))}>
          <Save /> Save
        </Button>
      </div>
    </Card>
  )
}

function FinanceSettings() {
  const { s, setS, save, busy } = useSettingsForm()
  if (!s) return <Spinner />
  const valid = () => {
    if (!s.currencies.some((c) => c.code === s.default_currency)) return 'The default currency must be in the currency list'
    if (s.currencies.some((c) => !/^[A-Z]{3}$/.test(c.code) || !(Number(c.rate) > 0))) return 'Currency codes must be 3 capital letters with a positive rate'
    if (s.taxes.some((t) => !t.name.trim() || t.rate < 0 || t.rate > 100)) return 'Each tax needs a name and a rate 0–100'
    return null
  }
  return (
    <Card>
      <CardHeader title="Currency, tax & financial year" />
      <div className="grid gap-6 p-4 sm:p-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-semibold">Currencies</p>
          <p className="mb-3 text-xs text-muted">Rate = value of 1 unit in the default currency. Used to convert foreign-currency transactions.</p>
          {s.currencies.map((c, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <Input className="w-20 font-mono uppercase" maxLength={3} value={c.code} onChange={(e) => setS({ ...s, currencies: s.currencies.map((x, j) => (j === i ? { ...x, code: e.target.value.toUpperCase() } : x)) })} aria-label="Currency code" />
              <Input className="flex-1" value={c.name} onChange={(e) => setS({ ...s, currencies: s.currencies.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label="Currency name" />
              <Input className="w-28 text-right" type="number" min={0} value={c.rate} onChange={(e) => setS({ ...s, currencies: s.currencies.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })} aria-label="Exchange rate" />
              <Button size="icon" variant="ghost" disabled={c.code === s.default_currency} onClick={() => setS({ ...s, currencies: s.currencies.filter((_, j) => j !== i) })} aria-label="Remove currency">
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setS({ ...s, currencies: [...s.currencies, { code: '', name: '', rate: 1 }] })}>
            <Plus /> Add currency
          </Button>
          <Field label="Default (base) currency" className="mt-4 max-w-xs">
            <Select value={s.default_currency} onChange={(e) => setS({ ...s, default_currency: e.target.value })}>
              {s.currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} – {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold">Taxes</p>
          <p className="mb-3 text-xs text-muted">Default taxes applied to new BOQs and purchase orders.</p>
          {s.taxes.map((t, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <Input className="flex-1" value={t.name} onChange={(e) => setS({ ...s, taxes: s.taxes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label="Tax name" />
              <Input className="w-24 text-right" type="number" min={0} max={100} value={t.rate} onChange={(e) => setS({ ...s, taxes: s.taxes.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })} aria-label="Tax rate" />
              <span className="text-sm text-muted">%</span>
              <Button size="icon" variant="ghost" onClick={() => setS({ ...s, taxes: s.taxes.filter((_, j) => j !== i) })} aria-label="Remove tax">
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setS({ ...s, taxes: [...s.taxes, { name: '', rate: 0 }] })}>
            <Plus /> Add tax
          </Button>
          <Field label="Financial year starts in" className="mt-4 max-w-xs">
            <Select value={s.financial_year_start_month} onChange={(e) => setS({ ...s, financial_year_start_month: Number(e.target.value) })}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <div className="flex justify-end border-t border-border px-4 py-3">
        <Button
          variant="primary"
          loading={busy}
          onClick={() => {
            const e = valid()
            if (e) return toast.error(e)
            void save({ currencies: s.currencies, taxes: s.taxes, default_currency: s.default_currency, financial_year_start_month: s.financial_year_start_month })
          }}
        >
          <Save /> Save
        </Button>
      </div>
    </Card>
  )
}

function Units() {
  const { s, setS, save, busy } = useSettingsForm()
  const [n, setN] = useState('')
  if (!s) return <Spinner />
  return (
    <Card>
      <CardHeader title="Measurement units" description="Available in BOQs, materials, requisitions and purchase orders." />
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap gap-2">
          {s.units.map((u) => (
            <span key={u} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-1 pl-3 pr-1 text-sm">
              {u}
              <button className="rounded-full p-0.5 text-subtle hover:bg-danger-soft hover:text-danger" onClick={() => setS({ ...s, units: s.units.filter((x) => x !== u) })} aria-label={`Remove ${u}`}>
                <Trash2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="mt-4 flex max-w-sm gap-2">
          <Input value={n} onChange={(e) => setN(e.target.value)} placeholder="e.g. m², kg, bag" onKeyDown={(e) => e.key === 'Enter' && n.trim() && (setS({ ...s, units: [...new Set([...s.units, n.trim()])] }), setN(''))} />
          <Button
            onClick={() => {
              if (!n.trim()) return
              setS({ ...s, units: [...new Set([...s.units, n.trim()])] })
              setN('')
            }}
          >
            <Plus /> Add
          </Button>
        </div>
      </div>
      <div className="flex justify-end border-t border-border px-4 py-3">
        <Button variant="primary" loading={busy} onClick={() => save({ units: s.units })}>
          <Save /> Save
        </Button>
      </div>
    </Card>
  )
}

function Numbering() {
  const invalidate = useInvalidate()
  const q = useList<{ key: string; label: string; prefix: string; next_value: number; padding: number; include_year: boolean }>('numbering_sequences', { order: { column: 'label' } })
  const [edit, setEdit] = useState<any | null>(null)
  const save = async () => {
    if (!/^[A-Z0-9-]{1,10}$/.test(edit.prefix)) return toast.error('Prefix: 1–10 capital letters, digits or hyphens')
    const { error } = await db.from('numbering_sequences').update({ prefix: edit.prefix, next_value: Number(edit.next_value), padding: Number(edit.padding), include_year: edit.include_year }).eq('key', edit.key)
    if (error) return toast.error(errorMessage(error))
    toast.success('Numbering updated')
    setEdit(null)
    await invalidate('numbering_sequences')
  }
  const preview = (r: any) => `${r.prefix}-${r.include_year ? new Date().getFullYear() + '-' : ''}${String(r.next_value).padStart(Number(r.padding), '0')}`
  return (
    <Card>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.key}
        onRowClick={setEdit}
        columns={[
          { key: 'label', header: 'Document type' },
          { key: 'prefix', header: 'Prefix', cell: (r) => <span className="font-mono">{r.prefix}</span> },
          { key: 'next_value', header: 'Next no.', format: 'number' },
          { key: 'padding', header: 'Digits', format: 'number' },
          { key: 'include_year', header: 'Year', value: (r) => (r.include_year ? 'Yes' : 'No') },
          { key: 'preview', header: 'Next number', value: preview, cell: (r) => <Badge tone="accent">{preview(r)}</Badge> },
        ]}
      />
      {edit && (
        <Dialog
          open
          onOpenChange={(o) => !o && setEdit(null)}
          title={`Numbering — ${edit.label}`}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save}>
                Save
              </Button>
            </>
          }
        >
          <div className="grid gap-4">
            <Field label="Prefix">
              <Input className="font-mono uppercase" value={edit.prefix} onChange={(e) => setEdit({ ...edit, prefix: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Next number" hint="Lowering this can create duplicate numbers — unique constraints will reject them">
              <Input type="number" min={1} value={edit.next_value} onChange={(e) => setEdit({ ...edit, next_value: e.target.value })} />
            </Field>
            <Field label="Digits (zero padding)">
              <Input type="number" min={1} max={10} value={edit.padding} onChange={(e) => setEdit({ ...edit, padding: e.target.value })} />
            </Field>
            <Checkbox label="Include year" checked={edit.include_year} onChange={(e) => setEdit({ ...edit, include_year: e.target.checked })} />
            <p className="text-sm">
              Preview: <Badge tone="accent">{preview(edit)}</Badge>
            </p>
          </div>
        </Dialog>
      )}
    </Card>
  )
}

function NotificationSettings() {
  const { s, setS, save, busy } = useSettingsForm()
  if (!s) return <Spinner />
  const items: Array<[string, string]> = [
    ['low_stock', 'Low-stock alerts to inventory managers'],
    ['task_assigned', 'Task assignment notifications'],
    ['overdue_tasks', 'Daily overdue-task reminders'],
    ['report_submitted', 'Site report submitted → project manager'],
    ['approvals', 'Approval requests and decisions (procurement, finance, reports)'],
  ]
  return (
    <Card>
      <CardHeader title="Notification settings" description="Company-wide switches for automatic in-app notifications." />
      <div className="space-y-3 p-4 sm:p-5">
        {items.map(([k, label]) => (
          <Checkbox key={k} className="flex" label={label} checked={s.notification_settings[k] ?? true} onChange={(e) => setS({ ...s, notification_settings: { ...s.notification_settings, [k]: e.target.checked } })} />
        ))}
      </div>
      <div className="flex justify-end border-t border-border px-4 py-3">
        <Button variant="primary" loading={busy} onClick={() => save({ notification_settings: s.notification_settings })}>
          <Save /> Save
        </Button>
      </div>
    </Card>
  )
}

function AuditLog() {
  const q = useList<any>('audit_logs', { select: 'id,table_name,record_id,action,old_data,new_data,changed_at,actor:profiles!audit_logs_changed_by_fkey(full_name)', order: { column: 'changed_at', ascending: false }, limit: 1000 })
  const [view, setView] = useState<any | null>(null)
  const changed = (r: any) => {
    if (r.action !== 'UPDATE') return []
    return Object.keys(r.new_data ?? {}).filter((k) => k !== 'updated_at' && JSON.stringify(r.new_data[k]) !== JSON.stringify(r.old_data?.[k]))
  }
  return (
    <Card>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => String(r.id)}
        onRowClick={setView}
        exportTitle="Audit log"
        filters={[
          { key: 'action', label: 'Action', options: ['INSERT', 'UPDATE', 'DELETE'].map((a) => ({ value: a, label: a })) },
          { key: 'table_name', label: 'Table', options: [...new Set((q.data ?? []).map((r) => r.table_name as string))].sort().map((t) => ({ value: t, label: humanize(t) })) },
        ]}
        columns={[
          { key: 'changed_at', header: 'When', value: (r) => r.changed_at, cell: (r) => formatDateTime(r.changed_at) },
          { key: 'actor', header: 'User', value: (r) => r.actor?.full_name ?? 'System' },
          { key: 'action', header: 'Action', cell: (r) => <Badge tone={r.action === 'DELETE' ? 'danger' : r.action === 'INSERT' ? 'success' : 'info'}>{r.action}</Badge> },
          { key: 'table_name', header: 'Record type', value: (r) => humanize(r.table_name) },
          { key: 'label', header: 'Record', value: (r) => (r.new_data ?? r.old_data)?.number ?? (r.new_data ?? r.old_data)?.name ?? (r.new_data ?? r.old_data)?.title ?? r.record_id },
          { key: 'fields', header: 'Changed fields', value: (r) => changed(r).join(', '), hideOnMobile: true, className: 'max-w-xs truncate' },
        ]}
      />
      {view && (
        <Dialog open onOpenChange={(o) => !o && setView(null)} size="lg" title={`${view.action} · ${humanize(view.table_name)}`} description={`${formatDateTime(view.changed_at)} by ${view.actor?.full_name ?? 'System'}`}>
          {view.action === 'UPDATE' ? (
            <table className="w-full text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1">Field</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {changed(view).map((k) => (
                  <tr key={k} className="border-t border-border align-top">
                    <td className="py-1.5 pr-2 font-mono">{k}</td>
                    <td className="break-all pr-2 text-danger">{JSON.stringify(view.old_data?.[k])}</td>
                    <td className="break-all text-success">{JSON.stringify(view.new_data?.[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{JSON.stringify(view.new_data ?? view.old_data, null, 2)}</pre>
          )}
        </Dialog>
      )}
    </Card>
  )
}

function Backups() {
  return (
    <Card className="p-4 text-sm leading-relaxed sm:p-5">
      <h3 className="mb-2 font-semibold">Backup strategy</h3>
      <ul className="list-disc space-y-1.5 pl-5 text-muted">
        <li>
          <strong className="text-foreground">Scheduled Firestore backups</strong>: enable daily backups and{' '}
          <strong className="text-foreground">Point-in-Time Recovery</strong> in the Firebase / Google Cloud console (Firestore → Disaster recovery).
        </li>
        <li>
          <strong className="text-foreground">Off-site export</strong>: run <code className="rounded bg-surface-2 px-1 font-mono text-xs">npm run db:backup</code>{' '}
          (Firestore managed export to a Cloud Storage bucket) and keep a copy in a separate, encrypted location.
        </li>
        <li>
          <strong className="text-foreground">Storage files</strong> (documents, photos) are not included in Firestore exports — sync the Storage bucket as well (see README → Backups).
        </li>
        <li>
          <strong className="text-foreground">Ledgers are append-only</strong>: inventory movements and financial transactions cannot be deleted; corrections are posted as new entries, and every change is in the audit log.
        </li>
        <li>Test a restore into a separate Firebase project at least once per quarter.</li>
      </ul>
    </Card>
  )
}

export default function SettingsPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? (can(P.settingsManage) ? 'company' : 'audit')
  return (
    <div>
      <PageHeader title="System Settings" description="Company profile, currency, tax, units, numbering, notifications, AI API keys and audit trail." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          {can(P.settingsManage) && (
            <>
              <TabsTrigger value="company">
                <Building2 /> Company
              </TabsTrigger>
              <TabsTrigger value="finance">
                <Wallet /> Currency & tax
              </TabsTrigger>
              <TabsTrigger value="units">
                <Ruler /> Units
              </TabsTrigger>
              <TabsTrigger value="numbering">
                <Hash /> Numbering
              </TabsTrigger>
              <TabsTrigger value="notifications">
                <Bell /> Notifications
              </TabsTrigger>
            </>
          )}
          {can('ai.manage') && (
            <TabsTrigger value="ai-keys">
              <KeyRound /> AI API keys
            </TabsTrigger>
          )}
          {can(P.auditView) && (
            <TabsTrigger value="audit">
              <History /> Audit log
            </TabsTrigger>
          )}
          <TabsTrigger value="backups">
            <DatabaseBackup /> Backups
          </TabsTrigger>
        </TabsList>
        <TabsContent value="company">
          <Company />
        </TabsContent>
        <TabsContent value="finance">
          <FinanceSettings />
        </TabsContent>
        <TabsContent value="units">
          <Units />
        </TabsContent>
        <TabsContent value="numbering">
          <Numbering />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationSettings />
        </TabsContent>
        <TabsContent value="ai-keys">{can('ai.manage') && <AiApiKeys />}</TabsContent>
        <TabsContent value="audit">{can(P.auditView) && <AuditLog />}</TabsContent>
        <TabsContent value="backups">
          <Backups />
        </TabsContent>
      </Tabs>
    </div>
  )
}
