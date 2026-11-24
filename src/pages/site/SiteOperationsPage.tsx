import { AlertTriangle, ClipboardCheck, ClipboardPlus, HardHat, ShieldAlert, Users } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ResourcePage } from '@/components/crud/ResourcePage'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, EmptyState, PageHeader, Skeleton, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import type { Project, SiteReport } from '@/lib/types'
import { formatDate, today } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { SEVERITY, WEATHER } from './siteConfig'

interface Incident {
  id: string
  project_id: string
  incident_date: string
  severity: string
  category: string | null
  description: string
  status: string
  action_taken: string | null
  is_demo: boolean
  project?: { name: string; code: string } | null
}

export function SafetyIncidents({ projectId }: { projectId?: string }) {
  return (
    <ResourcePage<Incident>
      config={{
        table: 'safety_incidents',
        select: '*, project:projects(name,code)',
        singular: 'Incident',
        plural: 'Safety incidents',
        eq: projectId ? { project_id: projectId } : undefined,
        order: { column: 'incident_date', ascending: false },
        createDefaults: projectId ? { project_id: projectId } : undefined,
        perms: { create: P.siteReport, edit: P.siteReport, remove: P.siteApprove },
        filters: [
          { key: 'severity', label: 'Severity', options: SEVERITY },
          { key: 'status', label: 'Status', options: [{ value: 'open', label: 'Open' }, { value: 'investigating', label: 'Investigating' }, { value: 'closed', label: 'Closed' }] },
        ],
        fields: [
          ...(projectId
            ? []
            : [{ name: 'project_id', label: 'Project', type: 'relation' as const, required: true, relation: { table: 'projects', select: 'id,name,code,is_archived', label: (p: Project) => `${p.code} · ${p.name}`, order: 'name', filter: (p: Project) => !p.is_archived } }]),
          { name: 'incident_date', label: 'Date', type: 'date', required: true, defaultValue: today },
          { name: 'severity', label: 'Severity', type: 'select', required: true, options: SEVERITY, defaultValue: 'minor' },
          { name: 'category', label: 'Category', type: 'select', options: ['Fall from height', 'Struck by object', 'Cut / laceration', 'Plant / vehicle', 'Electrical', 'Excavation collapse', 'Manual handling', 'Fire', 'Environmental', 'Other'].map((c) => ({ value: c, label: c })) },
          { name: 'status', label: 'Status', type: 'select', required: true, defaultValue: 'open', options: [{ value: 'open', label: 'Open' }, { value: 'investigating', label: 'Investigating' }, { value: 'closed', label: 'Closed' }] },
          { name: 'description', label: 'What happened', type: 'textarea', required: true },
          { name: 'persons_involved', label: 'Persons involved', type: 'text', span: 2 },
          { name: 'action_taken', label: 'Action taken / corrective measures', type: 'textarea' },
        ],
        columns: [
          { key: 'incident_date', header: 'Date', format: 'date' },
          ...(projectId ? [] : [{ key: 'project', header: 'Project', value: (r: Incident) => r.project?.name ?? null }]),
          { key: 'severity', header: 'Severity', cell: (r) => <StatusBadge status={r.severity} /> },
          { key: 'category', header: 'Category' },
          { key: 'description', header: 'Description', className: 'max-w-sm truncate' },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        ],
        emptyDescription: 'Record near misses and incidents so they can be investigated and closed out.',
      }}
    />
  )
}

function Overview() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const projects = useList<Project>('projects', { select: 'id,name,code,status,progress,location', eq: { is_archived: false, status: 'active' }, order: { column: 'name' } })
  const reports = useList<SiteReport>('site_reports', {
    select: 'id,number,project_id,report_date,weather,workers_count,progress_percent,safety_incidents,status,work_performed,problems,engineer:profiles!site_reports_engineer_id_fkey(full_name),project:projects(name,code)',
    order: { column: 'report_date', ascending: false },
    limit: 60,
    keyExtra: 'ops',
  })
  const incidents = useList<{ id: string }>('safety_incidents', { select: 'id', eq: { status: 'open' }, keyExtra: 'open' })

  const t = today()
  const todays = useMemo(() => (reports.data ?? []).filter((r) => r.report_date === t), [reports.data, t])
  const byProject = useMemo(() => new Map(todays.map((r) => [r.project_id, r])), [todays])
  const pending = (reports.data ?? []).filter((r) => r.status === 'submitted').length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard emphasis label="Reports today" value={todays.length} hint={`${projects.data?.length ?? 0} active sites`} icon={<ClipboardCheck />} />
        <StatCard label="Workers on site" value={todays.reduce((s, r) => s + r.workers_count, 0)} hint="from today's reports" icon={<Users />} />
        <StatCard label="Awaiting approval" value={pending} icon={<HardHat />} onClick={() => navigate('/site-reports')} />
        <StatCard label="Open incidents" value={incidents.data?.length ?? 0} icon={<ShieldAlert />} onClick={() => navigate('/site?tab=safety')} />
      </div>

      <Card>
        <CardHeader
          title="Today across active sites"
          description={formatDate(new Date(), 'EEEE dd MMMM yyyy')}
          actions={
            can(P.siteReport) && (
              <Button size="sm" variant="primary" onClick={() => navigate('/site-reports/new')}>
                <ClipboardPlus /> Submit today's report
              </Button>
            )
          }
        />
        {projects.isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : (projects.data ?? []).length === 0 ? (
          <EmptyState title="No active projects" />
        ) : (
          <ul className="divide-y divide-border">
            {projects.data!.map((p) => {
              const r = byProject.get(p.id)
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <Link to={`/projects/${p.id}`} className="font-medium hover:text-accent-ink">
                      {p.name}
                    </Link>
                    <p className="text-xs text-muted">
                      {p.code} · {p.location ?? 'No location'} · {Math.round(p.progress)}% complete
                    </p>
                  </div>
                  {r ? (
                    <Link to={`/site-reports/${r.id}`} className="flex items-center gap-3 text-sm">
                      <span>{WEATHER.find((w) => w.value === r.weather)?.label}</span>
                      <span className="tabular">{r.workers_count} workers</span>
                      {r.safety_incidents > 0 && <AlertTriangle className="size-4 text-danger" />}
                      <StatusBadge status={r.status} />
                    </Link>
                  ) : (
                    <span className="text-xs font-semibold text-warning">No report yet today</span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent site activity" description="Latest daily reports" />
        {(reports.data ?? []).length === 0 ? (
          <EmptyState title="No reports yet" />
        ) : (
          <ul className="divide-y divide-border">
            {reports.data!.slice(0, 10).map((r) => (
              <li key={r.id}>
                <Link to={`/site-reports/${r.id}`} className="block px-4 py-3 hover:bg-surface-2/60 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{formatDate(r.report_date, 'EEE dd MMM')}</span>
                    <span className="text-muted">· {r.project?.name}</span>
                    <span className="text-muted">· {r.engineer?.full_name}</span>
                    <span className="ml-auto">
                      <StatusBadge status={r.status} />
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted">{r.work_performed}</p>
                  {r.problems && (
                    <p className="mt-1 line-clamp-1 text-xs text-warning">
                      <AlertTriangle className="mr-1 inline size-3" />
                      {r.problems}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export default function SiteOperationsPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'overview'
  return (
    <div>
      <PageHeader title="Site Operations" description="Daily activity, labour, plant, materials and safety across every site." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="overview">
            <HardHat /> Overview
          </TabsTrigger>
          <TabsTrigger value="safety">
            <ShieldAlert /> Safety incidents
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview />
        </TabsContent>
        <TabsContent value="safety">
          <SafetyIncidents />
        </TabsContent>
      </Tabs>
    </div>
  )
}
