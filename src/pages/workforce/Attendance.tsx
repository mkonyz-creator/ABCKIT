import { useQuery } from '@tanstack/react-query'
import { CheckCheck, Save } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { DataTable } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/form'
import { Badge, Card, CardHeader, EmptyState, Spinner } from '@/components/ui/misc'
import { useInvalidate, useList, useProjectOptions } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db, unwrap } from '@/lib/backend'
import { errorMessage, formatNumber, today } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

const STATUSES = ['present', 'late', 'half_day', 'absent', 'sick', 'leave', 'off'] as const
type Status = (typeof STATUSES)[number]

interface Row {
  employee_id: string
  name: string
  no: string
  position: string
  status: Status | ''
  hours_worked: string
  overtime_hours: string
  notes: string
  existing: boolean
}

/** Daily attendance & timesheet sheet — one row per employee, saved in bulk (upsert). */
export function AttendanceSheet() {
  const { can } = useAuth()
  const invalidate = useInvalidate()
  const projects = useProjectOptions()
  const [date, setDate] = useState(today())
  const [projectId, setProjectId] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)

  const employees = useQuery({
    queryKey: ['employees', 'for-attendance', projectId],
    queryFn: async () => {
      if (projectId) {
        const a = unwrap(
          await db
            .from('employee_assignments')
            .select('employee:employees(id,full_name,employee_no,position,status)')
            .eq('project_id', projectId)
            .lte('start_date', date)
            .or(`end_date.is.null,end_date.gte.${date}`),
        ) as any[]
        return a.map((x) => x.employee).filter((e: any) => e && e.status !== 'terminated')
      }
      return unwrap(await db.from('employees').select('id,full_name,employee_no,position,status').in('status', ['active', 'on_leave']).order('full_name')) as any[]
    },
  })
  const existing = useList<any>('attendance', { eq: { work_date: date }, keyExtra: 'sheet' })

  useEffect(() => {
    const ex = new Map((existing.data ?? []).map((a: any) => [a.employee_id, a]))
    setRows(
      (employees.data ?? []).map((e: any) => {
        const a = ex.get(e.id)
        return {
          employee_id: e.id,
          name: e.full_name,
          no: e.employee_no,
          position: e.position,
          status: a?.status ?? (e.status === 'on_leave' ? 'leave' : ''),
          hours_worked: a ? String(a.hours_worked) : '',
          overtime_hours: a ? String(a.overtime_hours) : '0',
          notes: a?.notes ?? '',
          existing: !!a,
        }
      }),
    )
  }, [employees.data, existing.data])

  const markAll = () => setRows((rs) => rs.map((r) => (r.status ? r : { ...r, status: 'present', hours_worked: r.hours_worked || '8' })))

  const save = async () => {
    const toSave = rows.filter((r) => r.status)
    if (!toSave.length) return toast.error('Mark at least one employee')
    for (const r of toSave) {
      const h = Number(r.hours_worked || 0)
      const ot = Number(r.overtime_hours || 0)
      if (h < 0 || h > 24 || ot < 0 || ot > 16) return toast.error(`${r.name}: hours must be 0–24 and overtime 0–16`)
    }
    setBusy(true)
    try {
      const payload = toSave.map((r) => ({
        employee_id: r.employee_id,
        work_date: date,
        project_id: projectId || null,
        status: r.status,
        hours_worked: ['present', 'late'].includes(r.status) ? Number(r.hours_worked || 8) : r.status === 'half_day' ? Number(r.hours_worked || 4) : 0,
        overtime_hours: Number(r.overtime_hours || 0),
        notes: r.notes || null,
      }))
      // each row is 2 writes (record + audit log); a Firestore transaction allows at most 500
      for (let i = 0; i < payload.length; i += 200) {
        unwrap(await db.from('attendance').upsert(payload.slice(i, i + 200), { onConflict: 'employee_id,work_date' }))
      }
      toast.success(`Attendance saved for ${toSave.length} employee(s)`)
      await invalidate('attendance')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const summary = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) if (r.status) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [rows])
  const editable = can(P.hrAttendance)

  return (
    <Card>
      <CardHeader
        title="Daily attendance & timesheet"
        description={`${rows.length} employees · ${summary.present ?? 0} present · ${summary.absent ?? 0} absent`}
        actions={
          editable && (
            <>
              <Button size="sm" onClick={markAll}>
                <CheckCheck /> Mark unmarked present
              </Button>
              <Button size="sm" variant="primary" onClick={save} loading={busy}>
                <Save /> Save sheet
              </Button>
            </>
          )
        }
      />
      <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-3 sm:px-5">
        <Field label="Date">
          <Input type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Site / project" hint={projectId ? 'Employees assigned to this project on that date' : 'All active employees'} className="sm:col-span-2">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All employees</option>
            {projects.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {employees.isLoading || existing.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No employees" description={projectId ? 'Assign employees to this project first (Assignments tab).' : 'Register employees first.'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-surface-2/60 text-left text-[11px] uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Employee</th>
                <th className="px-2 py-2">Status</th>
                <th className="w-24 px-2 py-2 text-right">Hours</th>
                <th className="w-24 px-2 py-2 text-right">Overtime</th>
                <th className="px-2 py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.employee_id} className="border-t border-border">
                  <td className="px-4 py-2">
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-subtle">
                      {r.no} · {r.position} {r.existing && <Badge className="ml-1">saved</Badge>}
                    </p>
                  </td>
                  <td className="p-1">
                    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`Status for ${r.name}`}>
                      {STATUSES.map((s) => (
                        <button
                          key={s}
                          disabled={!editable}
                          role="radio"
                          aria-checked={r.status === s}
                          onClick={() => setRows(rows.map((x, j) => (j === i ? { ...x, status: s, hours_worked: x.hours_worked || (s === 'present' || s === 'late' ? '8' : s === 'half_day' ? '4' : '0') } : x)))}
                          className={`rounded-md border px-2 py-1 text-[11px] font-semibold capitalize transition-colors ${r.status === s ? (s === 'present' ? 'border-success bg-success text-white' : s === 'absent' ? 'border-danger bg-danger text-white' : 'border-foreground bg-foreground text-background') : 'border-border text-muted hover:border-border-strong'}`}
                        >
                          {s.replace('_', ' ')}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="p-1">
                    <Input type="number" min={0} max={24} step="0.5" disabled={!editable} className="h-9 text-right" value={r.hours_worked} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, hours_worked: e.target.value } : x)))} aria-label="Hours worked" />
                  </td>
                  <td className="p-1">
                    <Input type="number" min={0} max={16} step="0.5" disabled={!editable} className="h-9 text-right" value={r.overtime_hours} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, overtime_hours: e.target.value } : x)))} aria-label="Overtime hours" />
                  </td>
                  <td className="p-1">
                    <Input disabled={!editable} className="h-9" value={r.notes} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))} aria-label="Notes" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/** Attendance summary per employee for a period (performance report) */
export function EmployeePerformance() {
  const [from, setFrom] = useState(today().slice(0, 8) + '01')
  const [to, setTo] = useState(today())
  const q = useQuery({
    queryKey: ['attendance', 'perf', from, to],
    queryFn: async () =>
      unwrap(await db.from('attendance').select('employee_id,status,hours_worked,overtime_hours,employee:employees(full_name,employee_no,position,department)').gte('work_date', from).lte('work_date', to).limit(20000)) as any[],
  })
  const rows = useMemo(() => {
    const m = new Map<string, any>()
    for (const a of q.data ?? []) {
      const r = m.get(a.employee_id) ?? { employee_id: a.employee_id, name: a.employee?.full_name, no: a.employee?.employee_no, position: a.employee?.position, department: a.employee?.department, present: 0, late: 0, absent: 0, leave: 0, hours: 0, overtime: 0, days: 0 }
      r.days++
      if (a.status === 'present') r.present++
      else if (a.status === 'late') {
        r.late++
        r.present++
      } else if (a.status === 'half_day') r.present += 0.5
      else if (a.status === 'absent' || a.status === 'sick') r.absent++
      else if (a.status === 'leave') r.leave++
      r.hours += Number(a.hours_worked)
      r.overtime += Number(a.overtime_hours)
      m.set(a.employee_id, r)
    }
    return [...m.values()].map((r) => ({ ...r, attendance_rate: r.days - r.leave > 0 ? (r.present / (r.days - r.leave)) * 100 : 0 }))
  }, [q.data])
  return (
    <Card>
      <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-4 sm:px-5">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <DataTable
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        rowKey={(r) => r.employee_id}
        exportTitle="Employee attendance & performance"
        exportSubtitle={`Period ${from} to ${to}`}
        initialSort={{ key: 'attendance_rate', dir: 'asc' }}
        columns={[
          { key: 'name', header: 'Employee', cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-subtle">{r.no} · {r.position}</p></div> },
          { key: 'department', header: 'Department', hideOnMobile: true },
          { key: 'present', header: 'Days present', format: 'number' },
          { key: 'late', header: 'Late', format: 'number' },
          { key: 'absent', header: 'Absent', format: 'number' },
          { key: 'leave', header: 'Leave', format: 'number' },
          { key: 'hours', header: 'Hours', format: 'number' },
          { key: 'overtime', header: 'Overtime', format: 'number' },
          { key: 'attendance_rate', header: 'Attendance', format: 'percent', cell: (r) => <strong className={r.attendance_rate < 80 ? 'text-danger' : ''}>{formatNumber(r.attendance_rate, 1)}%</strong> },
        ]}
        emptyTitle="No attendance recorded in this period"
      />
    </Card>
  )
}
