import { ArchiveRestore, Building2, FolderKanban } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ResourcePage } from '@/components/crud/ResourcePage'
import { MenuItem, PageHeader, Progress, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useSave } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import type { Client, Project } from '@/lib/types'
import { formatMoney } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { clientFields, PROJECT_STATUSES, projectFields } from './projectConfig'

export default function ProjectsPage() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'projects'
  const showArchived = params.get('archived') === '1'
  const restore = useSave('projects', { successMessage: 'Project restored' })

  return (
    <div>
      <PageHeader title="Projects" description="Every contract, its client, budget, team and progress." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="projects">
            <FolderKanban /> Projects
          </TabsTrigger>
          <TabsTrigger value="clients">
            <Building2 /> Clients
          </TabsTrigger>
        </TabsList>
        <TabsContent value="projects">
          <ResourcePage<Project>
            config={{
              table: 'projects',
              select: '*, client:clients(id,name), manager:profiles!projects_project_manager_id_fkey(id,full_name)',
              singular: 'Project',
              plural: showArchived ? 'Archived projects' : 'Projects',
              eq: { is_archived: showArchived },
              order: { column: 'created_at', ascending: false },
              fields: projectFields,
              perms: { create: P.projectsManage, edit: P.projectsManage, remove: P.projectsArchive },
              archive: showArchived ? undefined : { field: 'is_archived', label: 'Archive' },
              canDeleteRow: () => !showArchived,
              openCreate: params.get('new') === '1',
              initialFilters: params.get('status') ? { status: params.get('status')! } : undefined,
              onRowClick: (p) => navigate(`/projects/${p.id}`),
              extraActions: (p) =>
                showArchived && can(P.projectsArchive) ? (
                  <MenuItem onSelect={() => restore.mutate({ id: p.id, values: { is_archived: false } })}>
                    <ArchiveRestore /> Restore
                  </MenuItem>
                ) : null,
              toolbar: (
                <button
                  className="text-xs font-semibold text-accent-ink hover:underline"
                  onClick={() => setParams(showArchived ? {} : { archived: '1' })}
                >
                  {showArchived ? 'Show active' : 'Show archived'}
                </button>
              ),
              filters: [
                { key: 'status', label: 'Status', options: PROJECT_STATUSES },
              ],
              columns: [
                {
                  key: 'name',
                  header: 'Project',
                  value: (p) => `${p.code} ${p.name}`,
                  cell: (p) => (
                    <div className="min-w-0">
                      <p className="font-semibold">{p.name}</p>
                      <p className="font-mono text-xs text-subtle">
                        {p.code}
                        {p.location ? ` · ${p.location}` : ''}
                      </p>
                    </div>
                  ),
                },
                { key: 'client', header: 'Client', value: (p) => p.client?.name ?? null, hideOnMobile: true },
                { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
                {
                  key: 'progress',
                  header: 'Progress',
                  format: 'percent',
                  cell: (p) => (
                    <div className="ml-auto flex w-32 items-center gap-2">
                      <Progress value={p.progress} />
                      <span className="w-9 text-right text-xs tabular">{Math.round(p.progress)}%</span>
                    </div>
                  ),
                },
                { key: 'contract_value', header: 'Contract value', format: 'money', cell: (p) => formatMoney(p.contract_value, p.currency) },
                { key: 'budget', header: 'Budget', format: 'money', hideOnMobile: true, cell: (p) => formatMoney(p.budget, p.currency) },
                { key: 'end_date', header: 'Completion', format: 'date' },
                { key: 'manager', header: 'Project manager', value: (p) => p.manager?.full_name ?? null, hideOnMobile: true },
              ],
              emptyDescription: 'Create your first project to set up its workspace, BOQ, team and budget.',
            }}
          />
        </TabsContent>
        <TabsContent value="clients">
          <ResourcePage<Client>
            config={{
              table: 'clients',
              singular: 'Client',
              plural: 'Clients',
              order: { column: 'name' },
              fields: clientFields,
              perms: { create: P.clientsManage, edit: P.clientsManage, remove: P.clientsManage },
              filters: [
                {
                  key: 'client_type',
                  label: 'Type',
                  options: [
                    { value: 'company', label: 'Company' },
                    { value: 'government', label: 'Government' },
                    { value: 'individual', label: 'Individual' },
                    { value: 'ngo', label: 'NGO' },
                  ],
                },
              ],
              columns: [
                { key: 'name', header: 'Client', cell: (c) => <span className="font-semibold">{c.name}</span> },
                { key: 'client_type', header: 'Type', cell: (c) => <StatusBadge status={c.client_type} /> },
                { key: 'contact_person', header: 'Contact' },
                { key: 'phone', header: 'Phone' },
                { key: 'email', header: 'Email', hideOnMobile: true },
                { key: 'tin', header: 'TIN', hideOnMobile: true },
              ],
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
