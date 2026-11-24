import { useQuery } from '@tanstack/react-query'
import { BadgeDollarSign, CalendarOff, CheckCircle2, ClipboardCheck, Lock, MapPinned, Play, Trophy, Users, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ResourcePage } from '@/components/crud/ResourcePage'
import { ResourceForm, toFormValues, type FieldDef } from '@/components/crud/ResourceForm'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/form'
import { Card, CardHeader, MenuItem, PageHeader, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useInvalidate } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db, unwrap } from '@/lib/backend'
import { errorMessage, formatMoney, humanize, today } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AttendanceSheet, EmployeePerformance } from './Attendance'

const DEPARTMENTS = ['Management', 'Site Operations', 'Engineering', 'Quantity Surveying', 'Finance', 'Procurement', 'Stores', 'Human Resources', 'Plant & Equipment', 'Administration'].map((d) => ({ value: d, label: d }))
const POSITIONS = ['Managing Director', 'Project Manager', 'Site Engineer', 'Quantity Surveyor', 'Site Supervisor', 'Foreman', 'Accountant', 'Procurement Officer', 'Storekeeper', 'HR Officer', 'Mason', 'Carpenter', 'Steel Fixer', 'Plumber', 'Electrician', 'Painter', 'Welder', 'Plant Operator', 'Driver', 'Labourer', 'Security Guard', 'Office Assistant'].map((p) => ({ value: p, label: p }))
const employeeRel = { table: 'employees', select: 'id,full_name,employee_no,status', label: (e: any) => `${e.employee_no} · ${e.full_name}`, order: 'full_name', filter: (e: any) => e.status !== 'terminated' }

const compFields: FieldDef[] = [
  { name: 'pay_basis', label: 'Pay basis', type: 'select', required: true, defaultValue: 'monthly', options: [{ value: 'monthly', label: 'Monthly salary' }, { value: 'daily', label: 'Daily rate' }, { value: 'hourly', label: 'Hourly (daily rate ÷ 8)' }] },
  { name: 'basic_salary', label: 'Basic monthly salary', type: 'money', defaultValue: 0 },
  { name: 'daily_rate', label: 'Daily rate', type: 'money', defaultValue: 0 },
  { name: 'overtime_rate', label: 'Overtime rate / hour', type: 'money', defaultValue: 0 },
  { name: 'allowances', label: 'Fixed allowances / period', type: 'money', defaultValue: 0 },
  { name: 'bank_name', label: 'Bank', type: 'text' },
  { name: 'bank_account', label: 'Bank account no.', type: 'text' },
  { name: 'nssf_no', label: 'NSSF no.', type: 'text' },
  { name: 'tin', label: 'TIN', type: 'text' },
  { name: 'national_id', label: 'NIDA no.', type: 'text' },
]

function CompensationDialog({ employee, onClose }: { employee: { id: string; full_name: string }; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const invalidate = useInvalidate()
  const q = useQuery({
    queryKey: ['employee_compensation', employee.id],
    gcTime: 0, // never keep confidential pay data cached after the dialog closes
    queryFn: async () => unwrap(await db.from('employee_compensation').select('*').eq('employee_id', employee.id).maybeSingle()),
  })
  const initial = useMemo(() => (q.isSuccess ? toFormValues(compFields, q.data as Record<string, any> | null) : null), [q.isSuccess, q.data])
  const save = async (v: Record<string, any>) => {
    setBusy(true)
    try {
      unwrap(await db.from('employee_compensation').upsert({ ...v, employee_id: employee.id }))
      toast.success('Pay details saved')
      await invalidate('employee_compensation')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Pay details — ${employee.full_name}`}
      description={
        <span className="inline-flex items-center gap-1">
          <Lock className="size-3" /> Confidential: visible only to payroll-authorised roles
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="comp-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      {initial ? <ResourceForm id="comp-form" fields={compFields} initial={initial} editing onSubmit={save} /> : <p className="text-sm text-muted">Loading…</p>}
    </Dialog>
  )
}

function Payroll() {
  const { can } = useAuth()
  const invalidate = useInvalidate()
  const first = today().slice(0, 8) + '01'
  const [period, setPeriod] = useState({ start: first, end: today() })
  const [busy, setBusy] = useState(false)

  const generate = async () => {
    setBusy(true)
    try {
      // the backend creates at most PAYROLL_BATCH payslips per call (Firestore: ≤ 500 writes per transaction)
      const PAYROLL_BATCH = 200
      let n = 0
      for (;;) {
        const k = unwrap(await db.rpc('generate_payroll', { p_start: period.start, p_end: period.end, p_limit: PAYROLL_BATCH })) as number
        n += k
        if (k < PAYROLL_BATCH) break
      }
      toast.success(n ? `Generated ${n} draft payroll record(s) from attendance` : 'Payroll for this period already exists for all employees with pay details')
      await invalidate('payroll_records')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {can(P.hrPayroll) && (
        <Card>
          <CardHeader title="Run payroll" description="Creates draft payslips from pay details and attendance (days, hours, overtime) for the period." />
          <div className="flex flex-wrap items-end gap-3 p-4 sm:px-5">
            <Field label="Period start">
              <Input type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} />
            </Field>
            <Field label="Period end">
              <Input type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} />
            </Field>
            <Button variant="primary" loading={busy} onClick={generate}>
              <Play /> Generate payroll
            </Button>
          </div>
        </Card>
      )}
      <ResourcePage<any>
        config={{
          table: 'payroll_records',
          select: '*, employee:employees(full_name,employee_no,position)',
          singular: 'Payroll record',
          plural: 'Payroll',
          order: { column: 'period_end', ascending: false },
          perms: { create: P.hrPayroll, edit: P.hrPayroll, remove: P.hrPayroll },
          canEditRow: (r) => r.status === 'draft' || r.status === 'approved',
          canDeleteRow: (r) => r.status === 'draft',
          filters: [{ key: 'status', label: 'Status', options: ['draft', 'approved', 'paid', 'void'].map((s) => ({ value: s, label: humanize(s) })) }],
          fields: [
            { name: 'employee_id', label: 'Employee', type: 'relation', required: true, relation: employeeRel },
            { name: 'period_start', label: 'Period start', type: 'date', required: true },
            { name: 'period_end', label: 'Period end', type: 'date', required: true },
            { name: 'days_worked', label: 'Days worked', type: 'number', min: 0 },
            { name: 'overtime_hours', label: 'Overtime hours', type: 'number', min: 0 },
            { name: 'basic_pay', label: 'Basic pay', type: 'money', required: true },
            { name: 'overtime_pay', label: 'Overtime pay', type: 'money', defaultValue: 0 },
            { name: 'allowances', label: 'Allowances', type: 'money', defaultValue: 0 },
            { name: 'deductions', label: 'Deductions (PAYE, NSSF, loans…)', type: 'money', defaultValue: 0 },
            { name: 'status', label: 'Status', type: 'select', required: true, defaultValue: 'draft', options: ['draft', 'approved', 'paid', 'void'].map((s) => ({ value: s, label: humanize(s) })) },
            { name: 'paid_on', label: 'Paid on', type: 'date' },
            { name: 'payment_ref', label: 'Payment reference', type: 'text' },
            { name: 'notes', label: 'Notes', type: 'textarea' },
          ],
          beforeSave: (v) => {
            const o = { ...v }
            delete o.gross_pay
            delete o.net_pay
            return o
          },
          columns: [
            { key: 'employee', header: 'Employee', value: (r) => r.employee?.full_name, cell: (r) => <div><p className="font-medium">{r.employee?.full_name}</p><p className="text-xs text-subtle">{r.employee?.employee_no}</p></div> },
            { key: 'period_end', header: 'Period', value: (r) => `${r.period_start} → ${r.period_end}` },
            { key: 'days_worked', header: 'Days', format: 'number' },
            { key: 'gross_pay', header: 'Gross', format: 'money' },
            { key: 'deductions', header: 'Deductions', format: 'money', hideOnMobile: true },
            { key: 'net_pay', header: 'Net pay', format: 'money', cell: (r) => <strong>{formatMoney(r.net_pay)}</strong> },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ],
          emptyDescription: 'Add pay details for employees, record attendance, then generate payroll.',
        }}
      />
    </div>
  )
}

function LeaveRequests() {
  const { can } = useAuth()
  const invalidate = useInvalidate()
  const decide = async (id: string, status: 'approved' | 'rejected') => {
    const { error } = await db.from('leave_requests').update({ status }).eq('id', id)
    if (error) return toast.error(errorMessage(error))
    toast.success(`Leave ${status}`)
    await invalidate('leave_requests')
  }
  return (
    <ResourcePage<any>
      config={{
        table: 'leave_requests',
        select: '*, employee:employees(full_name,employee_no), approver:profiles!leave_requests_approved_by_fkey(full_name)',
        singular: 'Leave request',
        plural: 'Leave requests',
        order: { column: 'start_date', ascending: false },
        perms: { create: P.hrView, edit: P.hrManage },
        canEditRow: (r) => r.status === 'pending',
        filters: [
          { key: 'status', label: 'Status', options: ['pending', 'approved', 'rejected', 'cancelled'].map((s) => ({ value: s, label: humanize(s) })) },
          { key: 'leave_type', label: 'Type', options: ['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'unpaid', 'other'].map((s) => ({ value: s, label: humanize(s) })) },
        ],
        fields: [
          { name: 'employee_id', label: 'Employee', type: 'relation', required: true, relation: employeeRel },
          { name: 'leave_type', label: 'Leave type', type: 'select', required: true, defaultValue: 'annual', options: ['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'unpaid', 'other'].map((s) => ({ value: s, label: humanize(s) })) },
          { name: 'start_date', label: 'From', type: 'date', required: true },
          { name: 'end_date', label: 'To', type: 'date', required: true },
          { name: 'reason', label: 'Reason', type: 'textarea' },
        ],
        extraActions: (r) =>
          r.status === 'pending' && can(P.hrManage) ? (
            <>
              <MenuItem onSelect={() => decide(r.id, 'approved')}>
                <CheckCircle2 /> Approve
              </MenuItem>
              <MenuItem onSelect={() => decide(r.id, 'rejected')}>
                <XCircle /> Reject
              </MenuItem>
            </>
          ) : null,
        columns: [
          { key: 'employee', header: 'Employee', value: (r) => r.employee?.full_name },
          { key: 'leave_type', header: 'Type', value: (r) => humanize(r.leave_type) },
          { key: 'start_date', header: 'From', format: 'date' },
          { key: 'end_date', header: 'To', format: 'date' },
          { key: 'days', header: 'Days', format: 'number' },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'approver', header: 'Decided by', value: (r) => r.approver?.full_name ?? null, hideOnMobile: true },
        ],
      }}
    />
  )
}

export function EmployeeAssignments({ projectId }: { projectId?: string }) {
  return (
    <ResourcePage<any>
      config={{
        table: 'employee_assignments',
        select: '*, employee:employees(full_name,employee_no,position), project:projects(name,code)',
        singular: 'Assignment',
        plural: 'Project assignments',
        eq: projectId ? { project_id: projectId } : undefined,
        createDefaults: projectId ? { project_id: projectId } : undefined,
        order: { column: 'start_date', ascending: false },
        perms: { create: P.hrManage, edit: P.hrManage, remove: P.hrManage },
        fields: [
          { name: 'employee_id', label: 'Employee', type: 'relation', required: true, relation: employeeRel },
          ...(projectId ? [] : [{ name: 'project_id', label: 'Project', type: 'relation' as const, required: true, relation: { table: 'projects', select: 'id,name,code,is_archived', label: (p: any) => `${p.code} · ${p.name}`, order: 'name', filter: (p: any) => !p.is_archived } }]),
          { name: 'role', label: 'Role on project', type: 'text', placeholder: 'e.g. Foreman' },
          { name: 'start_date', label: 'From', type: 'date', required: true, defaultValue: today },
          { name: 'end_date', label: 'Until (blank = ongoing)', type: 'date' },
        ],
        columns: [
          { key: 'employee', header: 'Employee', value: (r) => r.employee?.full_name, cell: (r) => <div><p className="font-medium">{r.employee?.full_name}</p><p className="text-xs text-subtle">{r.employee?.position}</p></div> },
          ...(projectId ? [] : [{ key: 'project', header: 'Project', value: (r: any) => r.project?.name }]),
          { key: 'role', header: 'Role' },
          { key: 'start_date', header: 'From', format: 'date' },
          { key: 'end_date', header: 'Until', format: 'date' },
        ],
      }}
    />
  )
}

export default function WorkforcePage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'employees'
  const [comp, setComp] = useState<{ id: string; full_name: string } | null>(null)

  return (
    <div>
      <PageHeader title="Workforce & HR" description="Employees, site assignments, attendance & timesheets, leave and payroll." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="employees">
            <Users /> Employees
          </TabsTrigger>
          <TabsTrigger value="attendance">
            <ClipboardCheck /> Attendance
          </TabsTrigger>
          <TabsTrigger value="assignments">
            <MapPinned /> Assignments
          </TabsTrigger>
          <TabsTrigger value="leave">
            <CalendarOff /> Leave
          </TabsTrigger>
          {can(P.hrPayroll) && (
            <TabsTrigger value="payroll">
              <BadgeDollarSign /> Payroll
            </TabsTrigger>
          )}
          <TabsTrigger value="performance">
            <Trophy /> Performance
          </TabsTrigger>
        </TabsList>
        <TabsContent value="employees">
          <ResourcePage<any>
            config={{
              table: 'employees',
              singular: 'Employee',
              plural: 'Employees',
              order: { column: 'full_name' },
              perms: { create: P.hrManage, edit: P.hrManage, remove: P.hrManage },
              initialSearch: params.get('q') ?? undefined,
              filters: [
                { key: 'department', label: 'Department', options: DEPARTMENTS },
                { key: 'status', label: 'Status', options: ['active', 'on_leave', 'suspended', 'terminated'].map((s) => ({ value: s, label: humanize(s) })) },
                { key: 'employment_type', label: 'Employment', options: ['permanent', 'contract', 'casual', 'intern'].map((s) => ({ value: s, label: humanize(s) })) },
              ],
              fields: [
                { name: 'full_name', label: 'Full name', type: 'text', required: true, span: 2 },
                { name: 'employee_no', label: 'Employee ID', type: 'text', hint: 'Blank = auto (EMP-…)', disabled: (_v, e) => e },
                { name: 'gender', label: 'Gender', type: 'select', options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }] },
                { name: 'position', label: 'Job position', type: 'select', required: true, options: POSITIONS, defaultValue: 'Labourer' },
                { name: 'department', label: 'Department', type: 'select', required: true, options: DEPARTMENTS, defaultValue: 'Site Operations' },
                { name: 'trade', label: 'Trade / skill', type: 'text' },
                { name: 'employment_type', label: 'Employment type', type: 'select', required: true, defaultValue: 'permanent', options: ['permanent', 'contract', 'casual', 'intern'].map((s) => ({ value: s, label: humanize(s) })) },
                { name: 'hire_date', label: 'Hire date', type: 'date' },
                { name: 'status', label: 'Status', type: 'select', required: true, defaultValue: 'active', options: ['active', 'on_leave', 'suspended', 'terminated'].map((s) => ({ value: s, label: humanize(s) })) },
                { name: 'phone', label: 'Phone', type: 'tel' },
                { name: 'email', label: 'Email', type: 'email' },
                { name: 'emergency_contact', label: 'Emergency contact', type: 'text', span: 2 },
                {
                  name: 'profile_id',
                  label: 'Linked user account',
                  type: 'relation',
                  hint: 'Lets the employee see their own attendance, leave and payslips',
                  relation: { table: 'profiles', select: 'id,full_name,email', label: (p) => `${p.full_name} (${p.email})`, order: 'full_name' },
                },
              ],
              extraActions: (e) =>
                can(P.hrPayroll) ? (
                  <MenuItem onSelect={() => setComp(e)}>
                    <Lock /> Pay details
                  </MenuItem>
                ) : null,
              columns: [
                { key: 'full_name', header: 'Employee', value: (r) => `${r.employee_no} ${r.full_name}`, cell: (r) => <div><p className="font-semibold">{r.full_name}</p><p className="font-mono text-xs text-subtle">{r.employee_no}</p></div> },
                { key: 'position', header: 'Position' },
                { key: 'department', header: 'Department', hideOnMobile: true },
                { key: 'employment_type', header: 'Type', value: (r) => humanize(r.employment_type), hideOnMobile: true },
                { key: 'phone', header: 'Phone' },
                { key: 'hire_date', header: 'Hired', format: 'date', hideOnMobile: true },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              ],
            }}
          />
        </TabsContent>
        <TabsContent value="attendance">
          <AttendanceSheet />
        </TabsContent>
        <TabsContent value="assignments">
          <EmployeeAssignments />
        </TabsContent>
        <TabsContent value="leave">
          <LeaveRequests />
        </TabsContent>
        <TabsContent value="payroll">{can(P.hrPayroll) && <Payroll />}</TabsContent>
        <TabsContent value="performance">
          <EmployeePerformance />
        </TabsContent>
      </Tabs>
      {comp && <CompensationDialog employee={comp} onClose={() => setComp(null)} />}
    </div>
  )
}
