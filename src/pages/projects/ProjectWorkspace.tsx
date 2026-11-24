import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  BookOpenCheck,
  Boxes,
  CalendarCheck2,
  Camera,
  ClipboardList,
  ClipboardPlus,
  FileStack,
  LayoutDashboard,
  MapPin,
  Pencil,
  ShieldAlert,
  Tractor,
  Upload,
  Users,
  Wallet,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ResourceForm, toFormValues } from '@/components/crud/ResourceForm'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Card, CardHeader, DemoBadge, EmptyState, ErrorState, KeyValue, PageHeader, Progress, Spinner, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useInvalidate, useList, useRpc, useSave } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db, unwrap, viewableUrl } from '@/lib/backend'
import type { ActivityItem, Project, ProjectFinancials } from '@/lib/types'
import { errorMessage, formatDate, formatMoney, formatNumber, humanize, safeFileName, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { BoqList } from '../boq/BoqListPage'
import { DocumentsPanel } from '../documents/DocumentsPage'
import { EquipmentUsage } from '../equipment/EquipmentPage'
import { ClientInvoices, CashFlow } from '../finance/FinancePage'
import { Transactions } from '../finance/Transactions'
import { MaterialConsumption } from '../inventory/InventoryPage'
import { SafetyIncidents } from '../site/SiteOperationsPage'
import { SiteReportList } from '../site/SiteReportsPage'
import { TasksPanel } from '../tasks/TasksPage'
import { EmployeeAssignments } from '../workforce/WorkforcePage'
import { projectFields } from './projectConfig'

type FullProject = Project & { client: { id: string; name: string; phone: string | null; email: string | null; contact_person: string | null } | null }

function Overview({ p }: { p: FullProject }) {
  const { can } = useAuth()
  const fin = useList<ProjectFinancials>('project_financials', { eq: { project_id: p.id }, enabled: can(P.financeView) })
  const breakdown = useList<{ category: string; amount: number }>('project_cost_breakdown', { eq: { project_id: p.id }, enabled: can(P.financeView) })
  const activity = useRpc<ActivityItem[]>('recent_activity', { p_limit: 10, p_project: p.id }, { key: ['dashboard', 'activity', p.id] })
  const f = fin.data?.[0]
  const maxCat = Math.max(1, ...(breakdown.data ?? []).map((b) => Number(b.amount)))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard emphasis label="Progress" value={`${Math.round(p.progress)}%`} hint={<Progress value={p.progress} className="mt-2 bg-white/15" />} />
        <StatCard label="Contract value" value={formatMoney(p.contract_value, p.currency, { compact: true })} />
        <StatCard label="Budget" value={formatMoney(p.budget, p.currency, { compact: true })} />
        {f ? (
          <>
            <StatCard label="Actual cost" value={formatMoney(f.actual_cost, undefined, { compact: true })} hint={`${formatNumber(f.budget_used_pct, 1)}% of budget`} />
            <StatCard label="Remaining budget" value={formatMoney(f.remaining_budget, undefined, { compact: true })} />
            <StatCard label="Owed by client" value={formatMoney(f.outstanding_receivable, undefined, { compact: true })} hint={`Received ${formatMoney(f.income_received, undefined, { compact: true })}`} />
          </>
        ) : (
          <StatCard label="Completion" value={formatDate(p.end_date)} />
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Project details" />
          <div className="p-4 sm:p-5">
            <KeyValue
              cols={3}
              items={[
                { label: 'Client', value: p.client?.name },
                { label: 'Client contact', value: [p.client?.contact_person, p.client?.phone].filter(Boolean).join(' · ') || '—' },
                { label: 'Project manager', value: p.manager?.full_name },
                { label: 'Location', value: [p.location, p.region].filter(Boolean).join(', ') || '—' },
                { label: 'Start date', value: formatDate(p.start_date) },
                { label: 'Completion date', value: formatDate(p.end_date) },
                { label: 'Currency', value: p.currency },
                { label: 'Status', value: <StatusBadge status={p.status} /> },
                { label: 'Created', value: formatDate(p.created_at) },
              ]}
            />
            {p.description && <p className="mt-4 whitespace-pre-wrap border-t border-border pt-4 text-sm text-muted">{p.description}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent activity" />
          {(activity.data ?? []).length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {activity.data!.map((a) => (
                <li key={a.id} className="px-4 py-2.5">
                  <p className="truncate">
                    <span className="font-medium">{a.actor}</span> {a.action === 'INSERT' ? 'added' : a.action === 'DELETE' ? 'removed' : 'updated'} {humanize(a.table_name).toLowerCase().replace(/s$/, '')}
                    {a.label && <span className="text-muted"> · {a.label}</span>}
                  </p>
                  <p className="text-xs text-subtle">{timeAgo(a.changed_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {can(P.financeView) && (breakdown.data ?? []).length > 0 && (
        <Card className="p-4 sm:p-5">
          <p className="mb-3 text-sm font-semibold">Actual cost by category</p>
          <ul className="space-y-2">
            {[...breakdown.data!].sort((a, b) => b.amount - a.amount).map((b) => (
              <li key={b.category} className="text-sm">
                <div className="mb-1 flex justify-between">
                  <span>{humanize(b.category)}</span>
                  <span className="tabular">{formatMoney(b.amount)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-[var(--chart-2)]" style={{ width: `${(Number(b.amount) / maxCat) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Team({ p }: { p: FullProject }) {
  const { can } = useAuth()
  const invalidate = useInvalidate()
  const members = useList<any>('project_members', { select: 'user_id,member_role,added_at,user:profiles(id,full_name,email,role:roles(name))', eq: { project_id: p.id } })
  const profiles = useList<any>('profiles', { select: 'id,full_name,is_active', order: { column: 'full_name' } })
  const [uid, setUid] = useState('')
  const [role, setRole] = useState('site_engineer')
  const add = async () => {
    if (!uid) return
    const { error } = await db.from('project_members').upsert({ project_id: p.id, user_id: uid, member_role: role })
    if (error) return toast.error(errorMessage(error))
    setUid('')
    await invalidate('project_members')
  }
  const remove = async (userId: string) => {
    const { error } = await db.from('project_members').delete().eq('project_id', p.id).eq('user_id', userId)
    if (error) return toast.error(errorMessage(error))
    await invalidate('project_members')
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Project team (system users)" description="Members can see this project's data according to their role." />
        {can(P.projectsManage) && (
          <div className="flex flex-wrap items-end gap-2 border-b border-border p-4">
            <select className="h-10 min-w-56 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm" value={uid} onChange={(e) => setUid(e.target.value)} aria-label="User">
              <option value="">Add a user…</option>
              {(profiles.data ?? []).filter((x) => x.is_active && !(members.data ?? []).some((m) => m.user_id === x.id)).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.full_name}
                </option>
              ))}
            </select>
            <select className="h-10 rounded-md border border-border-strong bg-surface px-3 text-sm" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role on project">
              {['project_manager', 'site_engineer', 'quantity_surveyor', 'supervisor', 'storekeeper', 'member'].map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={add} disabled={!uid}>
              Add member
            </Button>
          </div>
        )}
        <ul className="divide-y divide-border">
          {p.manager && (
            <li className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="flex-1 font-medium">{p.manager.full_name}</span>
              <StatusBadge status="active" />
              <span className="text-xs text-muted">Project manager (owner)</span>
            </li>
          )}
          {(members.data ?? []).map((m) => (
            <li key={m.user_id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{m.user?.full_name}</p>
                <p className="text-xs text-muted">{m.user?.role?.name}</p>
              </div>
              <span className="text-xs text-muted">{humanize(m.member_role)}</span>
              {can(P.projectsManage) && (
                <Button size="sm" variant="ghost" onClick={() => remove(m.user_id)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
          {!p.manager && (members.data ?? []).length === 0 && <EmptyState title="No team members yet" />}
        </ul>
      </Card>
      {can(P.hrView) && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Workforce assigned to site</h3>
          <EmployeeAssignments projectId={p.id} />
        </div>
      )}
    </div>
  )
}

function Photos({ p }: { p: FullProject }) {
  const { can } = useAuth()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const list = useQuery({
    queryKey: ['project-photos', p.id],
    queryFn: async () => {
      const { data, error } = await db.storage.from('project-photos').list(p.id, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } })
      if (error) throw error
      const files = (data ?? []).filter((f) => f.name && !f.name.startsWith('.'))
      if (!files.length) return []
      const signed = await db.storage.from('project-photos').createSignedUrls(files.map((f) => `${p.id}/${f.name}`), 3600)
      if (signed.error) throw signed.error
      return Promise.all(files.map(async (f, i) => ({ name: f.name, created_at: f.created_at, url: signed.data[i]?.signedUrl ? await viewableUrl(signed.data[i].signedUrl!) : undefined })))
    },
  })
  const upload = async (files: FileList | null) => {
    if (!files) return
    setBusy(true)
    let n = 0
    for (const f of Array.from(files)) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) {
        toast.error(`${f.name}: only JPG, PNG or WebP`)
        continue
      }
      if (f.size > 10 * 1024 * 1024) {
        toast.error(`${f.name}: larger than 10 MB`)
        continue
      }
      const { error } = await db.storage.from('project-photos').upload(`${p.id}/${Date.now()}-${safeFileName(f.name)}`, f, { contentType: f.type })
      if (error) toast.error(`${f.name}: ${errorMessage(error)}`)
      else n++
    }
    setBusy(false)
    if (n) toast.success(`Uploaded ${n} photo(s)`)
    if (input.current) input.current.value = ''
    await list.refetch()
  }
  return (
    <Card>
      <CardHeader
        title="Project photographs"
        description="Progress photos for this project. Daily site report photos are attached to each report."
        actions={
          (can(P.projectsManage) || can(P.siteReport)) && (
            <>
              <Button size="sm" variant="primary" loading={busy} onClick={() => input.current?.click()}>
                <Upload /> Upload photos
              </Button>
              <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
            </>
          )
        }
      />
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState icon={<Camera className="size-6" />} title="No photos yet" />
      ) : (
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 lg:grid-cols-6">
          {list.data!.map((ph) => (
            <a key={ph.name} href={ph.url} target="_blank" rel="noreferrer" className="group relative block aspect-square overflow-hidden rounded-lg border border-border bg-surface-2">
              <img src={ph.url} alt={ph.name} loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
              <span className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-[10px] text-white">{formatDate(ph.created_at)}</span>
            </a>
          ))}
        </div>
      )}
    </Card>
  )
}

export default function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'overview'
  const [edit, setEdit] = useState(false)
  const save = useSave('projects', { invalidate: ['project_financials'] })
  const q = useQuery({
    queryKey: ['projects', 'one', id],
    queryFn: async () =>
      unwrap(
        await db
          .from('projects')
          .select('*, client:clients(id,name,phone,email,contact_person), manager:profiles!projects_project_manager_id_fkey(id,full_name)')
          .eq('id', id!)
          .single(),
      ) as FullProject,
  })
  const initial = useMemo(() => toFormValues(projectFields, q.data as any), [q.data])

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (!q.data) return <Spinner />
  const p = q.data

  const tabs = [
    { key: 'overview', label: 'Overview', icon: LayoutDashboard, show: true },
    { key: 'boq', label: 'BOQ', icon: BookOpenCheck, show: can(P.boqView) },
    { key: 'reports', label: 'Site reports', icon: ClipboardList, show: can(P.siteView) },
    { key: 'tasks', label: 'Tasks', icon: CalendarCheck2, show: can(P.tasksView) },
    { key: 'team', label: 'Team', icon: Users, show: true },
    { key: 'materials', label: 'Materials', icon: Boxes, show: can(P.inventoryView) },
    { key: 'equipment', label: 'Equipment', icon: Tractor, show: can(P.equipmentView) },
    { key: 'finance', label: 'Finance', icon: Wallet, show: can(P.financeView) },
    { key: 'documents', label: 'Documents', icon: FileStack, show: can(P.documentsView) },
    { key: 'photos', label: 'Photos', icon: Camera, show: true },
    { key: 'safety', label: 'Safety', icon: ShieldAlert, show: can(P.siteView) },
  ].filter((t) => t.show)

  return (
    <div>
      <PageHeader
        breadcrumb={
          <Link to="/projects" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-3" /> Projects
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.name} <StatusBadge status={p.status} /> {p.is_demo && <DemoBadge />} {p.is_archived && <StatusBadge status="void" />}
          </span>
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono">{p.code}</span>
            {p.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" />
                {p.location}
                {p.region ? `, ${p.region}` : ''}
              </span>
            )}
            {p.client && <span>Client: {p.client.name}</span>}
          </span>
        }
        actions={
          <>
            {can(P.siteReport) && (
              <Button onClick={() => navigate('/site-reports/new')}>
                <ClipboardPlus /> Site report
              </Button>
            )}
            {can(P.projectsManage) && (
              <Button variant="primary" onClick={() => setEdit(true)}>
                <Pencil /> Edit project
              </Button>
            )}
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              <t.icon /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <Overview p={p} />
        </TabsContent>
        <TabsContent value="boq">
          <BoqList projectId={p.id} />
        </TabsContent>
        <TabsContent value="reports">
          <SiteReportList projectId={p.id} />
        </TabsContent>
        <TabsContent value="tasks">
          <TasksPanel projectId={p.id} />
        </TabsContent>
        <TabsContent value="team">
          <Team p={p} />
        </TabsContent>
        <TabsContent value="materials">
          <MaterialConsumption projectId={p.id} />
        </TabsContent>
        <TabsContent value="equipment">
          <EquipmentUsage projectId={p.id} />
        </TabsContent>
        <TabsContent value="finance">
          <div className="space-y-6">
            <CashFlow projectId={p.id} />
            <Transactions projectId={p.id} title="Project transactions" />
            <ClientInvoices projectId={p.id} />
          </div>
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsPanel projectId={p.id} />
        </TabsContent>
        <TabsContent value="photos">
          <Photos p={p} />
        </TabsContent>
        <TabsContent value="safety">
          <SafetyIncidents projectId={p.id} />
        </TabsContent>
      </Tabs>

      <Dialog
        open={edit}
        onOpenChange={setEdit}
        size="lg"
        title="Edit project"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="project-edit" loading={save.isPending}>
              Save changes
            </Button>
          </>
        }
      >
        <ResourceForm
          id="project-edit"
          fields={projectFields}
          initial={initial}
          editing
          onSubmit={(v) => {
            const { code: _c, ...rest } = v
            save.mutate({ id: p.id, values: rest }, { onSuccess: () => setEdit(false) })
          }}
        />
      </Dialog>
    </div>
  )
}
