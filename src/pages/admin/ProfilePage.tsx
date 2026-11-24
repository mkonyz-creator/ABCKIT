import { useQuery } from '@tanstack/react-query'
import { KeyRound, MonitorSmartphone, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Avatar, Card, CardHeader, KeyValue, PageHeader, StatusBadge } from '@/components/ui/misc'
import { db, unwrap } from '@/lib/backend'
import { errorMessage, formatDate, formatDateTime, formatMoney, humanize } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { passwordProblem } from '../auth/AuthPages'

export default function ProfilePage() {
  const { profile, refresh, session, signOutEverywhere, isDemo } = useAuth()
  const [f, setF] = useState({ full_name: '', phone: '', job_title: '', username: '' })
  const [pw, setPw] = useState({ a: '', b: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (profile) setF({ full_name: profile.full_name, phone: profile.phone ?? '', job_title: profile.job_title ?? '', username: profile.username ?? '' })
  }, [profile])

  const me = useQuery({
    queryKey: ['employees', 'me', profile?.id],
    enabled: !!profile,
    queryFn: async () => {
      const emp = unwrap(await db.from('employees').select('*').eq('profile_id', profile!.id).maybeSingle()) as any
      if (!emp) return null
      const [att, leave, pay] = await Promise.all([
        db.from('attendance').select('work_date,status,hours_worked,overtime_hours').eq('employee_id', emp.id).order('work_date', { ascending: false }).limit(14),
        db.from('leave_requests').select('id,leave_type,start_date,end_date,days,status').eq('employee_id', emp.id).order('start_date', { ascending: false }).limit(10),
        db.from('payroll_records').select('id,period_start,period_end,net_pay,status,paid_on').eq('employee_id', emp.id).order('period_end', { ascending: false }).limit(6),
      ])
      return { emp, att: att.data ?? [], leave: leave.data ?? [], pay: pay.data ?? [] }
    },
  })

  const saveProfile = async () => {
    if (f.full_name.trim().length < 2) return toast.error('Enter your full name')
    setBusy(true)
    const { error } = await db
      .from('profiles')
      .update({ full_name: f.full_name.trim(), phone: f.phone || null, job_title: f.job_title || null, username: f.username.trim() || null })
      .eq('id', profile!.id)
    setBusy(false)
    if (error) return toast.error(errorMessage(error))
    toast.success('Profile updated')
    await refresh()
  }
  const changePw = async () => {
    const p = passwordProblem(pw.a)
    if (p) return toast.error(p)
    if (pw.a !== pw.b) return toast.error('Passwords do not match')
    setBusy(true)
    const { error } = await db.auth.updateUser({ password: pw.a })
    setBusy(false)
    if (error) return toast.error(errorMessage(error))
    toast.success('Password changed')
    setPw({ a: '', b: '' })
  }

  const [leaveOpen, setLeaveOpen] = useState(false)
  const [leave, setLeave] = useState({ leave_type: 'annual', start_date: '', end_date: '', reason: '' })
  const requestLeave = async () => {
    if (!leave.start_date || !leave.end_date) return toast.error('Choose the start and end dates')
    if (leave.end_date < leave.start_date) return toast.error('The end date must be on or after the start date')
    setBusy(true)
    const { error } = await db.from('leave_requests').insert({ employee_id: me.data!.emp.id, ...leave, reason: leave.reason || null })
    setBusy(false)
    if (error) return toast.error(errorMessage(error))
    toast.success('Leave request submitted')
    setLeaveOpen(false)
    setLeave({ leave_type: 'annual', start_date: '', end_date: '', reason: '' })
    await me.refetch()
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="My profile" />
      <Card className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
        <Avatar name={profile?.full_name} className="size-14 text-lg" />
        <div>
          <p className="text-lg font-semibold">{profile?.full_name}</p>
          <p className="text-sm text-muted">
            {profile?.email} · {profile?.role?.name}
          </p>
          <p className="text-xs text-subtle">Session since {formatDateTime(session?.user.last_sign_in_at)}</p>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <div className="grid gap-4 p-4 sm:p-5">
            <Field label="Full name">
              <Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </Field>
            <Field label="Job title">
              <Input value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} />
            </Field>
            <Field label="Username" hint="Optional — lets you sign in with this instead of your email. 3–30 letters, digits, dot, dash or underscore.">
              <Input value={f.username} autoCapitalize="none" spellCheck={false} maxLength={30} onChange={(e) => setF({ ...f, username: e.target.value })} />
            </Field>
            <Button variant="primary" loading={busy} onClick={saveProfile}>
              <Save /> Save
            </Button>
          </div>
        </Card>
        <Card>
          <CardHeader title="Change password" />
          <div className="grid gap-4 p-4 sm:p-5">
            <Field label="New password" hint="At least 10 characters with letters and numbers">
              <Input type="password" autoComplete="new-password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} />
            </Field>
            <Field label="Confirm">
              <Input type="password" autoComplete="new-password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} />
            </Field>
            <Button loading={busy} onClick={changePw}>
              <KeyRound /> Update password
            </Button>
          </div>
        </Card>
      </div>
      {!isDemo && (
        <Card>
          <CardHeader
            title="Sessions"
            description="Lost a phone or signed in on a shared computer? End every session of your account. Sessions also end automatically 30 days after sign-in."
          />
          <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
            <Button
              variant="danger"
              onClick={() => {
                if (!confirm('Sign out on ALL devices, including this one?')) return
                void signOutEverywhere().then((err) => err && toast.error(err))
              }}
            >
              <MonitorSmartphone /> Sign out of all devices
            </Button>
          </div>
        </Card>
      )}
      {me.data && (
        <Card>
          <CardHeader title="My employment record" actions={<Button size="sm" onClick={() => setLeaveOpen(true)}>Request leave</Button>} />
          <Dialog
            open={leaveOpen}
            onOpenChange={setLeaveOpen}
            size="sm"
            title="Request leave"
            footer={
              <>
                <Button variant="ghost" onClick={() => setLeaveOpen(false)}>
                  Cancel
                </Button>
                <Button variant="primary" loading={busy} onClick={requestLeave}>
                  Submit request
                </Button>
              </>
            }
          >
            <div className="grid gap-4">
              <Field label="Leave type">
                <Select value={leave.leave_type} onChange={(e) => setLeave({ ...leave, leave_type: e.target.value })}>
                  {['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'unpaid', 'other'].map((t) => (
                    <option key={t} value={t}>
                      {humanize(t)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="From">
                  <Input type="date" value={leave.start_date} onChange={(e) => setLeave({ ...leave, start_date: e.target.value })} />
                </Field>
                <Field label="To">
                  <Input type="date" min={leave.start_date} value={leave.end_date} onChange={(e) => setLeave({ ...leave, end_date: e.target.value })} />
                </Field>
              </div>
              <Field label="Reason">
                <Textarea rows={2} value={leave.reason} onChange={(e) => setLeave({ ...leave, reason: e.target.value })} />
              </Field>
            </div>
          </Dialog>
          <div className="space-y-5 p-4 sm:p-5">
            <KeyValue cols={4} items={[{ label: 'Employee no.', value: me.data.emp.employee_no }, { label: 'Position', value: me.data.emp.position }, { label: 'Department', value: me.data.emp.department }, { label: 'Hired', value: formatDate(me.data.emp.hire_date) }]} />
            <div className="grid gap-4 md:grid-cols-3">
              <MiniList title="Recent attendance" rows={me.data.att.map((a: any) => [formatDate(a.work_date, 'dd MMM'), <StatusBadge key="s" status={a.status} />])} />
              <MiniList title="Leave" rows={me.data.leave.map((l: any) => [`${formatDate(l.start_date, 'dd MMM')} – ${formatDate(l.end_date, 'dd MMM')}`, <StatusBadge key="s" status={l.status} />])} />
              <MiniList title="Payslips" rows={me.data.pay.map((p: any) => [formatDate(p.period_end, 'MMM yyyy'), formatMoney(p.net_pay)])} />
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

function MiniList({ title, rows }: { title: string; rows: Array<[React.ReactNode, React.ReactNode]> }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">None</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span>{r[0]}</span>
              <span>{r[1]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
