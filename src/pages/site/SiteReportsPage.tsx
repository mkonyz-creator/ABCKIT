import { AlertTriangle, ClipboardPlus, CloudOff, RefreshCw, Smartphone, Trash2, Upload } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useList, useOnline, useProjectOptions } from '@/lib/hooks'
import { deleteDraft, resolveConflict, syncAll, useDrafts } from '@/lib/offline'
import { P } from '@/lib/permissions'
import type { SiteReport } from '@/lib/types'
import { formatDate, humanize, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { WEATHER } from './siteConfig'

export function SiteReportList({ projectId }: { projectId?: string }) {
  const navigate = useNavigate()
  const { can, profile } = useAuth()
  const projects = useProjectOptions(true)
  const reports = useList<SiteReport>('site_reports', {
    select: 'id,number,project_id,report_date,engineer_id,weather,workers_count,progress_percent,safety_incidents,status,is_demo,updated_at,project:projects(id,name,code),engineer:profiles!site_reports_engineer_id_fkey(id,full_name)',
    eq: projectId ? { project_id: projectId } : undefined,
    order: { column: 'report_date', ascending: false },
  })
  return (
    <Card>
      <DataTable<SiteReport>
        rows={reports.data}
        loading={reports.isLoading}
        error={reports.error}
        onRetry={() => reports.refetch()}
        rowKey={(r) => r.id}
        isDemo={(r) => r.is_demo}
        onRowClick={(r) => navigate(`/site-reports/${r.id}`)}
        exportTitle="Daily site reports"
        initialSort={{ key: 'report_date', dir: 'desc' }}
        filters={[
          { key: 'status', label: 'Status', options: ['draft', 'submitted', 'approved', 'rejected'].map((s) => ({ value: s, label: humanize(s) })) },
          ...(projectId ? [] : [{ key: 'project_id', label: 'Project', options: projects.options }]),
          { key: 'mine', label: 'Engineer', options: [{ value: 'me', label: 'My reports' }], predicate: (r: SiteReport) => r.engineer_id === profile?.id },
        ]}
        columns={[
          {
            key: 'report_date',
            header: 'Date',
            format: 'date',
            cell: (r) => (
              <div>
                <p className="font-semibold">{formatDate(r.report_date, 'EEE dd MMM yyyy')}</p>
                <p className="font-mono text-xs text-subtle">{r.number}</p>
              </div>
            ),
          },
          ...(projectId ? [] : [{ key: 'project', header: 'Project', value: (r: SiteReport) => r.project?.name ?? null }]),
          { key: 'engineer', header: 'Engineer', value: (r) => r.engineer?.full_name ?? null },
          { key: 'weather', header: 'Weather', value: (r) => WEATHER.find((w) => w.value === r.weather)?.label ?? r.weather, hideOnMobile: true },
          { key: 'workers_count', header: 'Workers', format: 'number' },
          { key: 'progress_percent', header: 'Progress', format: 'percent' },
          {
            key: 'safety_incidents',
            header: 'Incidents',
            format: 'number',
            cell: (r) => (r.safety_incidents > 0 ? <Badge tone="danger"><AlertTriangle className="size-3" />{r.safety_incidents}</Badge> : <span className="text-subtle">0</span>),
          },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        ]}
        emptyTitle="No site reports yet"
        emptyDescription="Engineers submit one report per site per day — from a phone, even offline."
        toolbar={
          can(P.siteReport) && (
            <Button size="sm" variant="primary" onClick={() => navigate('/site-reports/new')}>
              <ClipboardPlus /> New report
            </Button>
          )
        }
      />
    </Card>
  )
}

function OfflineDrafts() {
  const drafts = useDrafts()
  const online = useOnline()
  const navigate = useNavigate()
  if (drafts.length === 0)
    return (
      <Card>
        <EmptyState icon={<Smartphone className="size-6" />} title="No unsynchronised reports on this device" description="Reports saved while offline appear here until they reach the server." />
      </Card>
    )
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <p className="text-sm text-muted">{drafts.length} report(s) stored on this device</p>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!online}
          onClick={async () => {
            const r = await syncAll()
            toast.info(`Synced ${r.synced}, ${r.failed} need attention`)
          }}
        >
          <Upload /> Sync now
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {drafts.map((d) => (
          <li key={d.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {formatDate(d.data.report_date)} · {d.data.work_performed?.slice(0, 60) || 'Untitled report'}
              </p>
              <p className="text-xs text-muted">
                Saved {timeAgo(new Date(d.savedAt))} · {d.photos.length} photo(s) · {d.submit ? 'will be submitted' : 'draft'}
              </p>
              {d.error && <p className="mt-1 text-xs text-danger">{d.error}</p>}
            </div>
            {d.state === 'pending' && (
              <Badge tone="warning">
                <CloudOff className="size-3" /> Waiting for connection
              </Badge>
            )}
            {d.state === 'syncing' && (
              <Badge tone="info">
                <RefreshCw className="size-3 animate-spin" /> Syncing
              </Badge>
            )}
            {d.state === 'error' && <Badge tone="danger">Sync failed</Badge>}
            {d.state === 'conflict' && (
              <>
                <Badge tone="danger">
                  <AlertTriangle className="size-3" /> Conflict
                </Badge>
                <Button size="sm" onClick={() => resolveConflict(d.key, 'keep_mine')}>
                  Keep my version
                </Button>
                <Button size="sm" variant="ghost" onClick={() => resolveConflict(d.key, 'keep_server')}>
                  Use server version
                </Button>
              </>
            )}
            {d.state !== 'syncing' && (
              <>
                <Button size="sm" variant="ghost" onClick={() => navigate(`/site-reports/draft/${d.key}`)}>
                  Open
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Discard local copy"
                  onClick={() => {
                    if (confirm('Discard this unsynchronised report from the device? This cannot be undone.')) void deleteDraft(d.key)
                  }}
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

export default function SiteReportsPage() {
  const [params, setParams] = useSearchParams()
  const drafts = useDrafts()
  const tab = params.get('tab') ?? 'reports'
  return (
    <div>
      <PageHeader title="Daily Site Reports" description="Digital daily diaries: labour, work done, materials, plant, weather, safety and photos." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="offline">
            On this device {drafts.length > 0 && <Badge tone="accent">{drafts.length}</Badge>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="reports">
          <SiteReportList />
        </TabsContent>
        <TabsContent value="offline">
          <OfflineDrafts />
        </TabsContent>
      </Tabs>
    </div>
  )
}
