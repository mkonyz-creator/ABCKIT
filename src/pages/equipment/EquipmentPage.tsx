import { Fuel, Gauge, MapPinned, Tractor, Wrench } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { ResourcePage } from '@/components/crud/ResourcePage'
import { DataTable } from '@/components/data/DataTable'
import { Card, PageHeader, Progress, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { formatDate, formatNumber, humanize, today } from '@/lib/utils'

const CATEGORIES = ['earthmoving', 'lifting', 'concrete', 'transport', 'compaction', 'power', 'survey', 'small_tools', 'other'].map((v) => ({ value: v, label: humanize(v) }))
const STATUSES = ['available', 'in_use', 'maintenance', 'breakdown', 'retired'].map((v) => ({ value: v, label: humanize(v) }))

const projectRel = { table: 'projects', select: 'id,name,code,is_archived', label: (p: any) => `${p.code} · ${p.name}`, order: 'name', filter: (p: any) => !p.is_archived }
const equipmentRel = { table: 'equipment', select: 'id,name,code', label: (e: any) => `${e.code} · ${e.name}`, order: 'name' }

export function Utilization() {
  const q = useList<any>('equipment_utilization', { order: { column: 'hours_30d', ascending: false } })
  return (
    <Card>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.equipment_id}
        exportTitle="Equipment utilisation (30 days)"
        exportSubtitle="Utilisation = operating hours ÷ (30 days × 8 h)"
        columns={[
          { key: 'name', header: 'Equipment', value: (r) => `${r.code} ${r.name}`, cell: (r) => <div><p className="font-semibold">{r.name}</p><p className="font-mono text-xs text-subtle">{r.code}</p></div> },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'hours_30d', header: 'Hours (30d)', format: 'number' },
          { key: 'idle_hours_30d', header: 'Idle (30d)', format: 'number', hideOnMobile: true },
          {
            key: 'utilization_pct',
            header: 'Utilisation',
            format: 'percent',
            cell: (r) => (
              <div className="ml-auto flex w-32 items-center gap-2">
                <Progress value={r.utilization_pct} />
                <span className="w-10 text-right text-xs tabular">{formatNumber(r.utilization_pct, 0)}%</span>
              </div>
            ),
          },
          { key: 'fuel_litres_30d', header: 'Fuel L (30d)', format: 'number' },
          { key: 'fuel_cost_30d', header: 'Fuel cost (30d)', format: 'money', hideOnMobile: true },
          { key: 'maintenance_cost_total', header: 'Maint. cost (all)', format: 'money' },
          { key: 'breakdowns_total', header: 'Breakdowns', format: 'number' },
          { key: 'downtime_hours_total', header: 'Downtime h', format: 'number', hideOnMobile: true },
        ]}
        emptyTitle="No equipment registered"
      />
    </Card>
  )
}

export function EquipmentUsage({ projectId }: { projectId?: string }) {
  return (
    <ResourcePage<any>
      config={{
        table: 'equipment_usage_logs',
        select: '*, equipment:equipment(name,code), project:projects(name,code)',
        singular: 'Usage log',
        plural: 'Equipment usage & fuel',
        eq: projectId ? { project_id: projectId } : undefined,
        createDefaults: projectId ? { project_id: projectId } : undefined,
        order: { column: 'usage_date', ascending: false },
        perms: { create: P.equipmentView, edit: P.equipmentManage, remove: P.equipmentManage },
        invalidate: ['equipment_utilization', 'equipment'],
        fields: [
          { name: 'equipment_id', label: 'Equipment', type: 'relation', required: true, relation: equipmentRel },
          ...(projectId ? [] : [{ name: 'project_id', label: 'Project', type: 'relation' as const, relation: projectRel }]),
          { name: 'usage_date', label: 'Date', type: 'date', required: true, defaultValue: today },
          { name: 'operator_name', label: 'Operator', type: 'text' },
          { name: 'hours_operated', label: 'Hours operated', type: 'number', min: 0, max: 24, required: true, defaultValue: 0 },
          { name: 'idle_hours', label: 'Idle hours', type: 'number', min: 0, max: 24, defaultValue: 0 },
          { name: 'fuel_litres', label: 'Fuel (litres)', type: 'number', min: 0, defaultValue: 0 },
          { name: 'fuel_cost', label: 'Fuel cost', type: 'money', defaultValue: 0 },
          { name: 'meter_reading', label: 'Hour meter / odometer', type: 'number', min: 0 },
          { name: 'work_done', label: 'Work done', type: 'textarea' },
        ],
        columns: [
          { key: 'usage_date', header: 'Date', format: 'date' },
          { key: 'equipment', header: 'Equipment', value: (r) => (r.equipment ? `${r.equipment.code} ${r.equipment.name}` : null) },
          ...(projectId ? [] : [{ key: 'project', header: 'Project', value: (r: any) => r.project?.name ?? null, hideOnMobile: true }]),
          { key: 'operator_name', header: 'Operator', hideOnMobile: true },
          { key: 'hours_operated', header: 'Hours', format: 'number' },
          { key: 'fuel_litres', header: 'Fuel L', format: 'number' },
          { key: 'fuel_cost', header: 'Fuel cost', format: 'money' },
          { key: 'meter_reading', header: 'Meter', format: 'number', hideOnMobile: true },
        ],
        emptyDescription: 'Log daily operating hours and fuel issued for each machine.',
      }}
    />
  )
}

export default function EquipmentPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'register'
  return (
    <div>
      <PageHeader title="Equipment & Machinery" description="Plant register, site assignments, operating hours, fuel, maintenance and breakdowns." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="register">
            <Tractor /> Register
          </TabsTrigger>
          <TabsTrigger value="assignments">
            <MapPinned /> Assignments
          </TabsTrigger>
          <TabsTrigger value="usage">
            <Fuel /> Usage & fuel
          </TabsTrigger>
          <TabsTrigger value="maintenance">
            <Wrench /> Maintenance & breakdowns
          </TabsTrigger>
          <TabsTrigger value="utilization">
            <Gauge /> Utilisation
          </TabsTrigger>
        </TabsList>

        <TabsContent value="register">
          <ResourcePage<any>
            config={{
              table: 'equipment',
              select: '*, project:projects(name,code)',
              singular: 'Equipment',
              plural: 'Equipment',
              order: { column: 'code' },
              perms: { create: P.equipmentManage, edit: P.equipmentManage, remove: P.equipmentManage },
              filters: [
                { key: 'status', label: 'Status', options: STATUSES },
                { key: 'category', label: 'Category', options: CATEGORIES },
                { key: 'ownership', label: 'Ownership', options: ['owned', 'hired', 'leased'].map((v) => ({ value: v, label: humanize(v) })) },
              ],
              fields: [
                { name: 'name', label: 'Name / description', type: 'text', required: true, span: 2, placeholder: 'e.g. Excavator 20t' },
                { name: 'code', label: 'Equipment ID', type: 'text', hint: 'Blank = auto (EQ-…)', disabled: (_v, e) => e },
                { name: 'category', label: 'Category', type: 'select', required: true, options: CATEGORIES, defaultValue: 'other' },
                { name: 'make', label: 'Make', type: 'text' },
                { name: 'model', label: 'Model', type: 'text' },
                { name: 'serial_no', label: 'Serial / chassis no.', type: 'text' },
                { name: 'registration_no', label: 'Registration (plate) no.', type: 'text' },
                { name: 'year', label: 'Year', type: 'number', min: 1950, max: 2100 },
                { name: 'ownership', label: 'Ownership', type: 'select', required: true, defaultValue: 'owned', options: ['owned', 'hired', 'leased'].map((v) => ({ value: v, label: humanize(v) })) },
                { name: 'purchase_date', label: 'Purchase / hire date', type: 'date' },
                { name: 'purchase_cost', label: 'Purchase cost', type: 'money' },
                { name: 'hourly_rate', label: 'Hourly charge rate', type: 'money', defaultValue: 0 },
                { name: 'status', label: 'Status', type: 'select', required: true, options: STATUSES, defaultValue: 'available' },
                { name: 'service_interval_hours', label: 'Service interval (hours)', type: 'number', min: 0 },
                { name: 'next_service_date', label: 'Next service date', type: 'date' },
                { name: 'notes', label: 'Notes', type: 'textarea' },
              ],
              columns: [
                { key: 'name', header: 'Equipment', value: (r) => `${r.code} ${r.name}`, cell: (r) => <div><p className="font-semibold">{r.name}</p><p className="font-mono text-xs text-subtle">{r.code}{r.registration_no ? ` · ${r.registration_no}` : ''}</p></div> },
                { key: 'category', header: 'Category', value: (r) => humanize(r.category) },
                { key: 'make', header: 'Make / model', value: (r) => [r.make, r.model].filter(Boolean).join(' ') || null, hideOnMobile: true },
                { key: 'ownership', header: 'Ownership', value: (r) => humanize(r.ownership), hideOnMobile: true },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'project', header: 'Current site', value: (r) => r.project?.name ?? null },
                { key: 'meter_reading', header: 'Meter', format: 'number', hideOnMobile: true },
                { key: 'next_service_date', header: 'Next service', format: 'date', cell: (r) => (r.next_service_date ? <span className={r.next_service_date < today() ? 'font-semibold text-danger' : ''}>{formatDate(r.next_service_date)}</span> : '—') },
              ],
            }}
          />
        </TabsContent>

        <TabsContent value="assignments">
          <ResourcePage<any>
            config={{
              table: 'equipment_assignments',
              select: '*, equipment:equipment(name,code), project:projects(name,code)',
              singular: 'Assignment',
              plural: 'Equipment assignments',
              order: { column: 'start_date', ascending: false },
              perms: { create: P.equipmentManage, edit: P.equipmentManage, remove: P.equipmentManage },
              invalidate: ['equipment'],
              fields: [
                { name: 'equipment_id', label: 'Equipment', type: 'relation', required: true, relation: equipmentRel },
                { name: 'project_id', label: 'Project', type: 'relation', required: true, relation: projectRel },
                { name: 'start_date', label: 'From', type: 'date', required: true, defaultValue: today },
                { name: 'end_date', label: 'Until (blank = ongoing)', type: 'date', hint: 'Set an end date to release the machine' },
                { name: 'notes', label: 'Notes', type: 'textarea' },
              ],
              columns: [
                { key: 'equipment', header: 'Equipment', value: (r) => (r.equipment ? `${r.equipment.code} ${r.equipment.name}` : null) },
                { key: 'project', header: 'Project', value: (r) => r.project?.name ?? null },
                { key: 'start_date', header: 'From', format: 'date' },
                { key: 'end_date', header: 'Until', format: 'date', cell: (r) => (r.end_date ? formatDate(r.end_date) : <StatusBadge status="active" />) },
                { key: 'notes', header: 'Notes', hideOnMobile: true },
              ],
              emptyDescription: 'Assigning a machine to a project marks it “in use” at that site.',
            }}
          />
        </TabsContent>

        <TabsContent value="usage">
          <EquipmentUsage />
        </TabsContent>

        <TabsContent value="maintenance">
          <ResourcePage<any>
            config={{
              table: 'maintenance_records',
              select: '*, equipment:equipment(name,code)',
              singular: 'Maintenance record',
              plural: 'Maintenance & breakdowns',
              order: { column: 'created_at', ascending: false },
              perms: { create: P.equipmentManage, edit: P.equipmentManage, remove: P.equipmentManage },
              invalidate: ['equipment', 'equipment_utilization'],
              filters: [
                { key: 'maintenance_type', label: 'Type', options: ['scheduled', 'repair', 'breakdown', 'inspection'].map((v) => ({ value: v, label: humanize(v) })) },
                { key: 'status', label: 'Status', options: ['scheduled', 'in_progress', 'completed', 'cancelled'].map((v) => ({ value: v, label: humanize(v) })) },
              ],
              fields: [
                { name: 'equipment_id', label: 'Equipment', type: 'relation', required: true, relation: equipmentRel },
                { name: 'maintenance_type', label: 'Type', type: 'select', required: true, defaultValue: 'scheduled', options: ['scheduled', 'repair', 'breakdown', 'inspection'].map((v) => ({ value: v, label: humanize(v) })) },
                { name: 'status', label: 'Status', type: 'select', required: true, defaultValue: 'scheduled', options: ['scheduled', 'in_progress', 'completed', 'cancelled'].map((v) => ({ value: v, label: humanize(v) })) },
                { name: 'scheduled_date', label: 'Scheduled / reported date', type: 'date', defaultValue: today },
                { name: 'completed_date', label: 'Completed date', type: 'date' },
                { name: 'description', label: 'Work required / fault description', type: 'textarea', required: true },
                { name: 'vendor', label: 'Workshop / mechanic', type: 'text' },
                { name: 'cost', label: 'Cost', type: 'money', defaultValue: 0 },
                { name: 'downtime_hours', label: 'Downtime (hours)', type: 'number', min: 0, defaultValue: 0 },
                { name: 'meter_reading', label: 'Meter reading', type: 'number', min: 0 },
              ],
              columns: [
                { key: 'equipment', header: 'Equipment', value: (r) => (r.equipment ? `${r.equipment.code} ${r.equipment.name}` : null) },
                { key: 'maintenance_type', header: 'Type', cell: (r) => <StatusBadge status={r.maintenance_type === 'breakdown' ? 'breakdown' : r.maintenance_type} /> },
                { key: 'description', header: 'Description', className: 'max-w-xs truncate' },
                { key: 'scheduled_date', header: 'Date', format: 'date' },
                { key: 'cost', header: 'Cost', format: 'money' },
                { key: 'downtime_hours', header: 'Downtime h', format: 'number', hideOnMobile: true },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              ],
              emptyDescription: 'Schedule services and record breakdowns, repair costs and downtime.',
            }}
          />
        </TabsContent>

        <TabsContent value="utilization">
          <Utilization />
        </TabsContent>
      </Tabs>
    </div>
  )
}
