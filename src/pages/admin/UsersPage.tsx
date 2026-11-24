import { useQuery } from '@tanstack/react-query'
import { Copy, Eye, EyeOff, FolderKanban, KeyRound, LockKeyhole, Mail, MoreHorizontal, Power, ShieldCheck, UserPlus, Users, Wand2 } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select } from '@/components/ui/form'
import { generatePassword, newPasswordProblem } from '@/backend/authTypes'
import { Avatar, Badge, Card, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PageHeader, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { useInvalidate, useList, useProjectOptions } from '@/lib/hooks'
import { db, unwrap } from '@/lib/backend'
import type { Profile, Role } from '@/lib/types'
import { errorMessage, formatDateTime, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { EmailAccessPanel } from './EmailAccessPanel'

const MEMBER_ROLES = ['project_manager', 'site_engineer', 'quantity_surveyor', 'supervisor', 'storekeeper', 'member']

function InviteDialog({ open, onOpenChange, roles }: { open: boolean; onOpenChange: (o: boolean) => void; roles: Role[] }) {
  const invalidate = useInvalidate()
  const [f, setF] = useState({ email: '', full_name: '', role_key: 'employee' })
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return toast.error('Enter a valid email')
    if (f.full_name.trim().length < 2) return toast.error('Enter the full name')
    setBusy(true)
    const email = f.email.trim().toLowerCase()
    const redirectTo = `${window.location.origin}${window.location.pathname}#/reset-password`
    const { data, error } = await db.functions.invoke('admin-users', {
      body: { action: 'invite', email, full_name: f.full_name.trim(), role_key: f.role_key, redirect_to: redirectTo },
    })
    if (error || data?.error) {
      setBusy(false)
      return toast.error(data?.error ?? errorMessage(error), { duration: 10_000 })
    }
    // the function creates the account; the "set your password" email is sent from here
    const sent = await db.auth.resetPasswordForEmail(email, { redirectTo })
    setBusy(false)
    if (sent.error) toast.warning(`User created, but the password email could not be sent (${errorMessage(sent.error)}). Use “Send password reset” to retry.`)
    else toast.success(`Invitation sent to ${email}`)
    await invalidate('profiles')
    setF({ email: '', full_name: '', role_key: 'employee' })
    onOpenChange(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite user"
      description="They receive an email link to set their password. The account is active immediately with the chosen role."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            <UserPlus /> Send invitation
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Full name" required>
          <Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        </Field>
        <Field label="Email" required>
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Role" required>
          <Select value={f.role_key} onChange={(e) => setF({ ...f, role_key: e.target.value })}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  )
}

function SetPasswordDialog({ user, onClose }: { user: Profile; onClose: () => void }) {
  const [pw, setPw] = useState({ a: '', b: '' })
  const [show, setShow] = useState(false)
  const [signOut, setSignOut] = useState(true)
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)
  const problem = newPasswordProblem(pw.a) ?? (pw.a !== pw.b ? 'The two passwords do not match.' : null)

  const generate = () => {
    const p = generatePassword()
    setPw({ a: p, b: p })
    setShow(true)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pw.a)
      toast.success('Password copied')
    } catch {
      toast.error('Could not copy — select the password and copy it manually')
    }
  }
  const submit = async () => {
    setTouched(true)
    if (problem) return toast.error(problem)
    setBusy(true)
    const { data, error } = await db.functions.invoke('admin-users', { body: { action: 'set_password', user_id: user.id, password: pw.a, sign_out: signOut } })
    setBusy(false)
    if (error || data?.error) {
      const code = (error as { code?: string } | null)?.code ?? ''
      if (!data?.error && ['functions/not-found', 'functions/internal', 'functions/unavailable'].includes(code))
        return toast.error('Setting a password directly needs ABCkit’s server functions (Firebase Blaze plan). You can email the user a password-reset link instead.', {
          duration: 15_000,
          action: {
            label: 'Send reset email',
            onClick: async () => {
              const sent = await db.auth.resetPasswordForEmail(user.email, { redirectTo: `${window.location.origin}${window.location.pathname}#/reset-password` })
              if (sent.error) toast.error(errorMessage(sent.error))
              else {
                toast.success(`Password reset email sent to ${user.email}`)
                onClose()
              }
            },
          },
        })
      return toast.error(data?.error ?? errorMessage(error))
    }
    if (data?.demo) toast.success(`[DEMO] Checks passed — nothing was changed. Demo accounts always use the demo password.`)
    else toast.success(`New password set for ${user.full_name}${data?.sessions_ended ? ' — signed out of all devices' : ''}. Give it to them securely.`)
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Set new password — ${user.full_name}`}
      description={`For ${user.email}. Tell the user their new password in person or by phone, and ask them to change it from their Profile page after signing in.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            <KeyRound /> Set password
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="New password" htmlFor="admin-new-pw" required error={touched ? (newPasswordProblem(pw.a) ?? undefined) : undefined} hint="At least 10 characters with letters and numbers.">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="admin-new-pw"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                maxLength={128}
                value={pw.a}
                onChange={(e) => setPw({ ...pw, a: e.target.value })}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-subtle hover:text-foreground"
                aria-label={show ? 'Hide password' : 'Show password'}
                aria-pressed={show}
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <Button variant="outline" onClick={generate} title="Generate a strong password">
              <Wand2 /> Generate
            </Button>
            <Button variant="outline" size="icon" onClick={copy} disabled={!pw.a} aria-label="Copy password">
              <Copy />
            </Button>
          </div>
        </Field>
        <Field label="Confirm new password" htmlFor="admin-new-pw2" required error={touched && pw.a !== pw.b ? 'The two passwords do not match.' : undefined}>
          <Input id="admin-new-pw2" type={show ? 'text' : 'password'} autoComplete="new-password" maxLength={128} value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} className="font-mono" />
        </Field>
        <Checkbox checked={signOut} onChange={(e) => setSignOut(e.target.checked)} label="Sign this user out of all devices now (recommended)" />
        <p className="text-xs text-muted">The password is never stored by ABCkit or written to the audit log — the log only records that an administrator changed it.</p>
      </div>
    </Dialog>
  )
}

function ProjectAccessDialog({ user, onClose }: { user: Profile; onClose: () => void }) {
  const invalidate = useInvalidate()
  const projects = useProjectOptions()
  const q = useQuery({
    queryKey: ['project_members', user.id],
    queryFn: async () => unwrap(await db.from('project_members').select('project_id,member_role,project:projects(name,code)').eq('user_id', user.id)) as any[],
  })
  const [pid, setPid] = useState('')
  const [role, setRole] = useState('site_engineer')
  const add = async () => {
    if (!pid) return
    const { error } = await db.from('project_members').upsert({ project_id: pid, user_id: user.id, member_role: role })
    if (error) return toast.error(errorMessage(error))
    setPid('')
    await Promise.all([q.refetch(), invalidate('project_members')])
  }
  const remove = async (projectId: string) => {
    const { error } = await db.from('project_members').delete().eq('project_id', projectId).eq('user_id', user.id)
    if (error) return toast.error(errorMessage(error))
    await q.refetch()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={`Project access — ${user.full_name}`} description="Users without company-wide project access only see the projects listed here (and projects they manage).">
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Project" className="min-w-56 flex-1">
          <Select value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="">Select…</option>
            {projects.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Role on project">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {MEMBER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" onClick={add} disabled={!pid}>
          Add
        </Button>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm text-muted">No project memberships.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {q.data!.map((m) => (
            <li key={m.project_id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1">
                <span className="font-mono text-xs text-subtle">{m.project?.code}</span> {m.project?.name}
              </span>
              <Badge>{m.member_role.replace('_', ' ')}</Badge>
              <Button size="sm" variant="ghost" onClick={() => remove(m.project_id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

function PermissionMatrix({ roles }: { roles: Role[] }) {
  const invalidate = useInvalidate()
  const { refresh } = useAuth()
  const perms = useList<{ id: string; key: string; module: string; description: string }>('permissions', { order: { column: 'key' } })
  const rp = useList<{ role_id: string; permission_id: string }>('role_permissions')
  const has = useMemo(() => new Set((rp.data ?? []).map((x) => `${x.role_id}:${x.permission_id}`)), [rp.data])
  const editable = roles.filter((r) => r.key !== 'super_admin')
  const modules = useMemo(() => {
    const m = new Map<string, typeof perms.data>()
    for (const p of perms.data ?? []) m.set(p.module, [...(m.get(p.module) ?? []), p])
    return [...m.entries()]
  }, [perms.data])

  const toggle = async (role: Role, permId: string, on: boolean) => {
    const res = on
      ? await db.from('role_permissions').insert({ role_id: role.id, permission_id: permId })
      : await db.from('role_permissions').delete().eq('role_id', role.id).eq('permission_id', permId)
    if (res.error) return toast.error(errorMessage(res.error))
    await invalidate('role_permissions')
    await refresh()
  }

  if (perms.isLoading || rp.isLoading) return <Spinner />
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-3 text-sm text-muted">
        Super Administrator always has every permission. Changes take effect immediately and are recorded in the audit log.
      </div>
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="border-b border-border">
              <th className="sticky left-0 z-20 min-w-64 bg-surface px-3 py-2 text-left font-semibold">Permission</th>
              {editable.map((r) => (
                <th key={r.id} className="min-w-20 px-1 py-2 text-center font-semibold [writing-mode:vertical-rl] sm:[writing-mode:horizontal-tb]">
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map(([mod, list]) => (
              <Fragment key={mod}>
                <tr className="bg-black text-white">
                  <td colSpan={editable.length + 1} className="sticky left-0 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide">
                    {mod}
                  </td>
                </tr>
                {list!.map((p) => (
                  <tr key={p.id} className="border-b border-border hover:bg-surface-2/50">
                    <td className="sticky left-0 bg-surface px-3 py-1.5">
                      <p className="font-medium">{p.description}</p>
                      <p className="font-mono text-[10px] text-subtle">{p.key}</p>
                    </td>
                    {editable.map((r) => {
                      const on = has.has(`${r.id}:${p.id}`)
                      return (
                        <td key={r.id} className="text-center">
                          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={on} onChange={(e) => toggle(r, p.id, e.target.checked)} aria-label={`${r.name}: ${p.description}`} />
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default function UsersPage() {
  const { profile: me } = useAuth()
  const invalidate = useInvalidate()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'users'
  const users = useList<Profile>('profiles', { select: '*, role:roles(id,key,name)', order: { column: 'full_name' } })
  const roles = useList<Role>('roles', { order: { column: 'name' } })
  const [invite, setInvite] = useState(false)
  const [access, setAccess] = useState<Profile | null>(null)
  const [pwFor, setPwFor] = useState<Profile | null>(null)
  const roleList = useMemo(() => {
    const order = ['super_admin', 'managing_director', 'project_manager', 'site_engineer', 'quantity_surveyor', 'accountant', 'procurement_officer', 'storekeeper', 'hr_officer', 'employee']
    return [...(roles.data ?? [])].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  }, [roles.data])

  const update = async (u: Profile, patch: Partial<Profile>, msg: string) => {
    if ('is_active' in patch) {
      // Preferred: the adminUsers function also disables/enables the sign-in account and revokes refresh tokens.
      const { data, error: fnErr } = await db.functions.invoke('admin-users', { body: { action: 'set_active', user_id: u.id, active: patch.is_active } })
      if (!fnErr && !data?.error) {
        toast.success(msg)
        await invalidate('profiles')
        return
      }
      if (data?.error) return toast.error(data.error)
      // Only when the function is not deployed fall back to the profile flag (database access is still revoked immediately);
      // a refusal from the function (e.g. last Super Administrator) is shown as is.
      const code = (fnErr as { code?: string } | null)?.code ?? ''
      if (!['functions/not-found', 'functions/internal', 'functions/unavailable'].includes(code)) return toast.error(errorMessage(fnErr))
    }
    const { error } = await db.from('profiles').update(patch).eq('id', u.id)
    if (error) return toast.error(errorMessage(error))
    toast.success(msg)
    await invalidate('profiles')
  }
  const sendReset = async (u: Profile) => {
    const { error } = await db.auth.resetPasswordForEmail(u.email, { redirectTo: `${window.location.origin}${window.location.pathname}#/reset-password` })
    if (error) return toast.error(errorMessage(error))
    toast.success(`Password reset email sent to ${u.email}`)
  }

  return (
    <div>
      <PageHeader
        title="User Management"
        description="Accounts, roles, activation, project-level access and company email access."
        actions={
          <Button variant="primary" onClick={() => setInvite(true)}>
            <UserPlus /> Invite user
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList>
          <TabsTrigger value="users">
            <Users /> Users
          </TabsTrigger>
          <TabsTrigger value="roles">
            <ShieldCheck /> Roles & permissions
          </TabsTrigger>
          <TabsTrigger value="email-access">
            <Mail /> Email access
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <Card>
            <DataTable<Profile>
              rows={users.data}
              loading={users.isLoading}
              error={users.error}
              rowKey={(u) => u.id}
              exportTitle="System users"
              filters={[
                { key: 'role', label: 'Role', options: roleList.map((r) => ({ value: r.key, label: r.name })), predicate: (u, v) => u.role?.key === v },
                { key: 'is_active', label: 'Status', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive / pending' }], predicate: (u, v) => String(u.is_active) === v },
              ]}
              initialFilters={params.get('pending') ? { is_active: 'false' } : undefined}
              columns={[
                {
                  key: 'full_name',
                  header: 'User',
                  value: (u) => `${u.full_name} ${u.email}`,
                  cell: (u) => (
                    <div className="flex items-center gap-3">
                      <Avatar name={u.full_name} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {u.full_name} {u.id === me?.id && <Badge>you</Badge>}
                        </p>
                        <p className="truncate text-xs text-muted">{u.email}</p>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'role',
                  header: 'Role',
                  value: (u) => u.role?.name ?? null,
                  cell: (u) => (
                    <Select className="h-8 w-48 text-xs" value={u.role_id} onChange={(e) => update(u, { role_id: e.target.value }, 'Role updated')} onClick={(e) => e.stopPropagation()} aria-label={`Role for ${u.full_name}`}>
                      {roleList.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                  ),
                },
                { key: 'is_active', header: 'Status', value: (u) => (u.is_active ? 'Active' : 'Inactive'), cell: (u) => (u.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Inactive</Badge>) },
                { key: 'last_seen_at', header: 'Last active', value: (u) => u.last_seen_at, cell: (u) => (u.last_seen_at ? <span title={formatDateTime(u.last_seen_at)}>{timeAgo(u.last_seen_at)}</span> : <span className="text-subtle">Never</span>) },
                { key: 'created_at', header: 'Created', format: 'date', hideOnMobile: true },
              ]}
              rowActions={(u) => (
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label="User actions">
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => setAccess(u)}>
                      <FolderKanban /> Project access
                    </MenuItem>
                    <MenuItem
                      disabled={u.id === me?.id || (u.role_id === 'super_admin' && me?.role_id !== 'super_admin')}
                      onSelect={() => setPwFor(u)}
                    >
                      <LockKeyhole /> Set new password
                    </MenuItem>
                    <MenuItem onSelect={() => sendReset(u)}>
                      <KeyRound /> Send password reset email
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem danger={u.is_active} disabled={u.id === me?.id} onSelect={() => update(u, { is_active: !u.is_active }, u.is_active ? 'User deactivated — access revoked' : 'User activated')}>
                      <Power /> {u.is_active ? 'Deactivate' : 'Activate'}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            />
          </Card>
          <p className="mt-3 text-xs text-muted">
            Deactivated users are blocked by the database immediately (every permission check requires an active profile); their existing session is rejected on its next request.
          </p>
        </TabsContent>
        <TabsContent value="roles">
          <PermissionMatrix roles={roleList} />
        </TabsContent>
        <TabsContent value="email-access">
          <EmailAccessPanel users={users.data} roles={roleList} />
        </TabsContent>
      </Tabs>
      <InviteDialog open={invite} onOpenChange={setInvite} roles={roleList} />
      {access && <ProjectAccessDialog user={access} onClose={() => setAccess(null)} />}
      {pwFor && <SetPasswordDialog user={pwFor} onClose={() => setPwFor(null)} />}
    </div>
  )
}
