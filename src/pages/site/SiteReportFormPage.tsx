import { ArrowLeft, Camera, CloudOff, ImagePlus, Plus, Save, Send, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { SignaturePad } from '@/components/SignaturePad'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Card, CardHeader, PageHeader, Spinner } from '@/components/ui/misc'
import { useList, useOnline, useProjectOptions } from '@/lib/hooks'
import { compressImage, getDraft, saveDraft, type DraftPhoto } from '@/lib/offline'
import { db } from '@/lib/backend'
import type { LineEntry, SiteReport } from '@/lib/types'
import { errorMessage, today } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { TRADES, WEATHER } from './siteConfig'

interface FormState {
  project_id: string
  report_date: string
  weather: string
  temperature_c: string
  labour: Array<{ trade: string; count: number }>
  work_performed: string
  materials_used: LineEntry[]
  equipment_used: LineEntry[]
  progress_percent: string
  problems: string
  safety_observations: string
  safety_incidents: string
  recommendations: string
  engineer_comments: string
  signature_data: string | null
}

const empty = (): FormState => ({
  project_id: '',
  report_date: today(),
  weather: 'sunny',
  temperature_c: '',
  labour: [{ trade: 'Labourer', count: 0 }],
  work_performed: '',
  materials_used: [],
  equipment_used: [],
  progress_percent: '',
  problems: '',
  safety_observations: '',
  safety_incidents: '0',
  recommendations: '',
  engineer_comments: '',
  signature_data: null,
})

export default function SiteReportFormPage() {
  const { id, draftKey } = useParams()
  const navigate = useNavigate()
  const online = useOnline()
  const { profile } = useAuth()
  const projects = useProjectOptions()
  const materials = useList<{ id: string; name: string; unit: string }>('materials', { select: 'id,name,unit', eq: { is_active: true }, order: { column: 'name' } })
  const equipment = useList<{ id: string; name: string; code: string }>('equipment', { select: 'id,name,code', order: { column: 'name' } })

  const [form, setForm] = useState<FormState>(empty)
  const [photos, setPhotos] = useState<DraftPhoto[]>([])
  const [key, setKey] = useState<string>(() => crypto.randomUUID())
  const [serverId, setServerId] = useState<string | undefined>()
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string | undefined>()
  const [loading, setLoading] = useState(!!(id || draftKey))
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)

  // load an existing server report or a local draft
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (draftKey) {
          const d = await getDraft(draftKey)
          if (!d) throw new Error('Draft not found on this device')
          if (cancelled) return
          setKey(d.key)
          setServerId(d.serverId)
          setBaseUpdatedAt(d.baseUpdatedAt)
          setPhotos(d.photos)
          setForm(fromRecord(d.data))
        } else if (id) {
          const { data, error } = await db.from('site_reports').select('*').eq('id', id).single()
          if (error) throw error
          const r = data as SiteReport
          if (cancelled) return
          setKey(r.client_uuid ?? crypto.randomUUID())
          setServerId(r.id)
          setBaseUpdatedAt(r.updated_at)
          setForm(fromRecord(r))
        }
      } catch (e) {
        toast.error(errorMessage(e))
        navigate('/site-reports')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, draftKey, navigate])

  const workers = useMemo(() => form.labour.reduce((s, l) => s + (Number(l.count) || 0), 0), [form.labour])
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }))

  const validate = (submit: boolean) => {
    const e: Record<string, string> = {}
    if (!form.project_id) e.project_id = 'Select the project'
    if (!form.report_date) e.report_date = 'Reporting date is required'
    if (form.report_date > today()) e.report_date = 'Reports cannot be dated in the future'
    const pct = form.progress_percent === '' ? null : Number(form.progress_percent)
    if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) e.progress_percent = 'Enter 0–100'
    if (submit) {
      if (form.work_performed.trim().length < 10) e.work_performed = 'Describe the work performed (at least 10 characters)'
      if (!form.signature_data) e.signature_data = 'Sign the report before submitting'
    }
    if (form.labour.some((l) => l.count < 0)) e.labour = 'Worker counts cannot be negative'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const save = async (submit: boolean) => {
    if (!validate(submit)) {
      toast.error('Please fix the highlighted fields')
      return
    }
    setBusy(true)
    const data = {
      project_id: form.project_id,
      report_date: form.report_date,
      engineer_id: profile!.id,
      weather: form.weather || null,
      temperature_c: form.temperature_c === '' ? null : Number(form.temperature_c),
      workers_count: workers,
      labour: form.labour.filter((l) => l.trade && l.count > 0),
      work_performed: form.work_performed.trim(),
      materials_used: form.materials_used.filter((m) => m.name.trim()),
      equipment_used: form.equipment_used.filter((m) => m.name.trim()),
      progress_percent: form.progress_percent === '' ? null : Number(form.progress_percent),
      problems: form.problems.trim() || null,
      safety_observations: form.safety_observations.trim() || null,
      safety_incidents: Number(form.safety_incidents) || 0,
      recommendations: form.recommendations.trim() || null,
      engineer_comments: form.engineer_comments.trim() || null,
      signature_data: form.signature_data,
    }
    try {
      // Every save goes through the offline queue; it syncs immediately when online.
      await saveDraft({ key, serverId, baseUpdatedAt, data, photos, submit, state: 'pending' })
      if (navigator.onLine) {
        toast.success(submit ? 'Report submitted for approval' : 'Draft saved')
      } else {
        toast.info('Saved on this device. It will sync automatically when you are back online.')
      }
      navigate('/site-reports')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const addPhotos = async (files: FileList | null) => {
    if (!files) return
    const added: DraftPhoto[] = []
    for (const f of Array.from(files).slice(0, 12)) {
      try {
        added.push({ id: crypto.randomUUID(), blob: await compressImage(f), name: f.name })
      } catch (e) {
        toast.error(`${f.name}: ${errorMessage(e)}`)
      }
    }
    setPhotos((p) => [...p, ...added].slice(0, 20))
  }

  if (loading) return <Spinner />

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        breadcrumb={
          <Link to="/site-reports" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-3" /> Daily site reports
          </Link>
        }
        title={serverId ? 'Edit daily site report' : 'New daily site report'}
        description={`Engineer: ${profile?.full_name}`}
      />
      {!online && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          <CloudOff className="mt-0.5 size-4 shrink-0" />
          You're offline. You can complete this report — it will be stored on this device and synchronised automatically when a connection returns.
        </div>
      )}

      <div className="space-y-4">
        <Card>
          <CardHeader title="General" />
          <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
            <Field label="Project" required error={errors.project_id} className="sm:col-span-2">
              <Select value={form.project_id} onChange={(e) => set('project_id', e.target.value)} aria-invalid={!!errors.project_id}>
                <option value="">{projects.isLoading ? 'Loading…' : 'Select project…'}</option>
                {projects.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reporting date" required error={errors.report_date}>
              <Input type="date" max={today()} value={form.report_date} onChange={(e) => set('report_date', e.target.value)} />
            </Field>
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <Field label="Weather">
                <Select value={form.weather} onChange={(e) => set('weather', e.target.value)}>
                  {WEATHER.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Temp °C">
                <Input type="number" inputMode="decimal" value={form.temperature_c} onChange={(e) => set('temperature_c', e.target.value)} />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Labour deployed" description={`${workers} workers on site`} />
          <div className="space-y-2 p-4 sm:p-5">
            {form.labour.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select className="flex-1" value={l.trade} onChange={(e) => set('labour', form.labour.map((x, j) => (j === i ? { ...x, trade: e.target.value } : x)))} aria-label="Trade">
                  {[...new Set([l.trade, ...TRADES])].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
                <Input type="number" inputMode="numeric" min={0} className="w-24 text-right" value={l.count} onChange={(e) => set('labour', form.labour.map((x, j) => (j === i ? { ...x, count: Math.max(0, parseInt(e.target.value) || 0) } : x)))} aria-label="Number of workers" />
                <Button size="icon" variant="ghost" onClick={() => set('labour', form.labour.filter((_, j) => j !== i))} aria-label="Remove trade">
                  <Trash2 />
                </Button>
              </div>
            ))}
            {errors.labour && <p className="text-xs text-danger">{errors.labour}</p>}
            <Button size="sm" variant="ghost" onClick={() => set('labour', [...form.labour, { trade: 'Mason', count: 1 }])}>
              <Plus /> Add trade
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Work performed & progress" />
          <div className="grid gap-4 p-4 sm:p-5">
            <Field label="Work performed today" required error={errors.work_performed}>
              <Textarea rows={5} value={form.work_performed} onChange={(e) => set('work_performed', e.target.value)} placeholder="e.g. Casting of ground-floor slab panel B2–B4 (18 m³), blockwork to grid lines 3–5…" />
            </Field>
            <Field label="Overall project progress (%)" error={errors.progress_percent} hint="Updates the project's progress once this report is approved">
              <div className="flex items-center gap-3">
                <input type="range" min={0} max={100} step={1} value={form.progress_percent === '' ? 0 : Number(form.progress_percent)} onChange={(e) => set('progress_percent', e.target.value)} className="flex-1 accent-[var(--accent)]" aria-label="Progress percent slider" />
                <Input type="number" min={0} max={100} className="w-20 text-right" value={form.progress_percent} onChange={(e) => set('progress_percent', e.target.value)} aria-label="Progress percent" />
              </div>
            </Field>
          </div>
        </Card>

        <LineEditor
          title="Materials used"
          rows={form.materials_used}
          onChange={(r) => set('materials_used', r)}
          options={(materials.data ?? []).map((m) => ({ id: m.id, name: m.name, unit: m.unit }))}
          qtyLabel="Qty"
          kind="material"
        />
        <LineEditor
          title="Equipment used"
          rows={form.equipment_used}
          onChange={(r) => set('equipment_used', r)}
          options={(equipment.data ?? []).map((m) => ({ id: m.id, name: `${m.code} ${m.name}` }))}
          qtyLabel="Hours"
          kind="equipment"
        />

        <Card>
          <CardHeader title="Problems, safety & recommendations" />
          <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
            <Field label="Problems encountered" className="sm:col-span-2">
              <Textarea value={form.problems} onChange={(e) => set('problems', e.target.value)} placeholder="Delays, shortages, design queries…" />
            </Field>
            <Field label="Health & safety observations" className="sm:col-span-2">
              <Textarea value={form.safety_observations} onChange={(e) => set('safety_observations', e.target.value)} placeholder="PPE compliance, toolbox talk, hazards observed…" />
            </Field>
            <Field label="Safety incidents (count)" hint="Record details under Site Operations → Safety">
              <Input type="number" min={0} value={form.safety_incidents} onChange={(e) => set('safety_incidents', e.target.value)} />
            </Field>
            <div />
            <Field label="Recommendations" className="sm:col-span-2">
              <Textarea value={form.recommendations} onChange={(e) => set('recommendations', e.target.value)} />
            </Field>
            <Field label="Engineer comments" className="sm:col-span-2">
              <Textarea value={form.engineer_comments} onChange={(e) => set('engineer_comments', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Site photos" description={`${photos.length} attached · compressed on the device before upload`} />
          <div className="p-4 sm:p-5">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {photos.map((p) => (
                <PhotoThumb key={p.id} photo={p} onRemove={() => setPhotos((ps) => ps.filter((x) => x.id !== p.id))} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => cameraInput.current?.click()}>
                <Camera /> Take photo
              </Button>
              <Button variant="ghost" onClick={() => fileInput.current?.click()}>
                <ImagePlus /> From gallery
              </Button>
              <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => addPhotos(e.target.files).then(() => (e.target.value = ''))} />
              <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic" multiple className="hidden" onChange={(e) => addPhotos(e.target.files).then(() => (e.target.value = ''))} />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Engineer signature" description="I confirm this report is a true record of the day's site activities." />
          <div className="p-4 sm:p-5">
            <SignaturePad value={form.signature_data} onChange={(v) => set('signature_data', v)} />
            {errors.signature_data && <p className="mt-1 text-xs text-danger">{errors.signature_data}</p>}
          </div>
        </Card>
      </div>

      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 mt-5 flex gap-2 rounded-xl border border-border bg-surface/95 p-3 shadow-lg backdrop-blur lg:bottom-4">
        <Button className="flex-1" onClick={() => save(false)} loading={busy}>
          <Save /> Save draft
        </Button>
        <Button className="flex-1" variant="primary" onClick={() => save(true)} loading={busy}>
          <Send /> Submit report
        </Button>
      </div>
    </div>
  )
}

function fromRecord(r: Partial<SiteReport> & Record<string, any>): FormState {
  return {
    project_id: r.project_id ?? '',
    report_date: (r.report_date ?? today()).slice(0, 10),
    weather: r.weather ?? 'sunny',
    temperature_c: r.temperature_c == null ? '' : String(r.temperature_c),
    labour: r.labour?.length ? r.labour : [{ trade: 'Labourer', count: r.workers_count ?? 0 }],
    work_performed: r.work_performed ?? '',
    materials_used: r.materials_used ?? [],
    equipment_used: r.equipment_used ?? [],
    progress_percent: r.progress_percent == null ? '' : String(r.progress_percent),
    problems: r.problems ?? '',
    safety_observations: r.safety_observations ?? '',
    safety_incidents: String(r.safety_incidents ?? 0),
    recommendations: r.recommendations ?? '',
    engineer_comments: r.engineer_comments ?? '',
    signature_data: r.signature_data ?? null,
  }
}

function PhotoThumb({ photo, onRemove }: { photo: DraftPhoto; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(photo.blob), [photo.blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    <div className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-surface-2">
      <img src={url} alt={photo.name} className="size-full object-cover" />
      {!photo.uploaded && (
        <button onClick={onRemove} className="absolute right-1 top-1 rounded-full bg-black/70 p-1.5 text-white" aria-label="Remove photo">
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function LineEditor({
  title,
  rows,
  onChange,
  options,
  qtyLabel,
  kind,
}: {
  title: string
  rows: LineEntry[]
  onChange: (r: LineEntry[]) => void
  options: Array<{ id: string; name: string; unit?: string }>
  qtyLabel: string
  kind: 'material' | 'equipment'
}) {
  const idKey = kind === 'material' ? 'material_id' : 'equipment_id'
  const qtyKey = kind === 'material' ? 'quantity' : 'hours'
  return (
    <Card>
      <CardHeader title={title} />
      <div className="space-y-2 p-4 sm:p-5">
        {rows.length === 0 && <p className="text-sm text-muted">None recorded.</p>}
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_88px_40px] gap-2 sm:grid-cols-[1fr_100px_80px_40px]">
            <Select
              value={(r as any)[idKey] ?? ''}
              onChange={(e) => {
                const o = options.find((x) => x.id === e.target.value)
                onChange(rows.map((x, j) => (j === i ? { ...x, [idKey]: o?.id, name: o?.name ?? x.name, unit: o?.unit ?? x.unit } : x)))
              }}
              aria-label={kind === 'material' ? 'Material' : 'Equipment'}
            >
              <option value="">{r.name && !(r as any)[idKey] ? r.name : 'Select…'}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
            <Input type="number" inputMode="decimal" min={0} className="text-right" placeholder={qtyLabel} value={(r as any)[qtyKey] ?? ''} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [qtyKey]: Number(e.target.value) } : x)))} aria-label={qtyLabel} />
            {kind === 'material' && <Input className="hidden sm:block" placeholder="Unit" value={r.unit ?? ''} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} aria-label="Unit" />}
            {kind === 'equipment' && <span className="hidden sm:block" />}
            <Button size="icon" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove line">
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { name: '' }])}>
          <Plus /> Add {kind}
        </Button>
        {kind === 'material' && <p className="text-xs text-subtle">Recording usage here does not move stock — stores issue materials via Inventory.</p>}
      </div>
    </Card>
  )
}
