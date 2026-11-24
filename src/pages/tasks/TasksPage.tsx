import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameMonth, isToday, startOfMonth, startOfWeek, subMonths } from 'date-fns'
import { AlertCircle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Diamond, List, PlayCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ResourcePage } from '@/components/crud/ResourcePage'
import type { FieldDef } from '@/components/crud/ResourceForm'
import { Button } from '@/components/ui/button'
import { Badge, Card, MenuItem, PageHeader, Progress, StatusBadge } from '@/components/ui/misc'
import { useInvalidate, useList } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db } from '@/lib/backend'
import type { Task } from '@/lib/types'
import { cn, errorMessage, formatDate, humanize, today } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

const PRIORITIES = ['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: humanize(v) }))
const STATUSES = ['todo', 'in_progress', 'review', 'blocked', 'done'].map((v) => ({ value: v, label: v === 'todo' ? 'To do' : humanize(v) }))
const isOverdue = (t: Task) => t.status !== 'done' && !!t.due_date && t.due_date < today()

function taskFields(projectId?: string): FieldDef[] {
  return [
    { name: 'title', label: 'Task', type: 'text', required: true, span: 2 },
    ...(projectId ? [] : [{ name: 'project_id', label: 'Project', type: 'relation' as const, relation: { table: 'projects', select: 'id,name,code,is_archived', label: (p: any) => `${p.code} · ${p.name}`, order: 'name', filter: (p: any) => !p.is_archived } }]),
    { name: 'assigned_to', label: 'Assign to', type: 'relation', relation: { table: 'profiles', select: 'id,full_name,is_active', label: (p) => p.full_name, order: 'full_name', filter: (p) => p.is_active } },
    { name: 'priority', label: 'Priority', type: 'select', required: true, options: PRIORITIES, defaultValue: 'medium' },
    { name: 'status', label: 'Status', type: 'select', required: true, options: STATUSES, defaultValue: 'todo' },
    { name: 'start_date', label: 'Start', type: 'date' },
    { name: 'due_date', label: 'Deadline', type: 'date' },
    { name: 'progress', label: 'Progress %', type: 'percent', defaultValue: 0 },
    { name: 'is_milestone', label: 'Project milestone', type: 'checkbox' },
    { name: 'description', label: 'Details', type: 'textarea' },
  ]
}

function Calendar({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }) {
  const [month, setMonth] = useState(new Date())
  const days = eachDayOfInterval({ start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }), end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }) })
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>()
    for (const t of tasks) if (t.due_date) m.set(t.due_date, [...(m.get(t.due_date) ?? []), t])
    return m
  }, [tasks])
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button size="icon-sm" variant="ghost" onClick={() => setMonth(subMonths(month, 1))} aria-label="Previous month">
          <ChevronLeft />
        </Button>
        <h2 className="min-w-36 text-center font-semibold">{format(month, 'MMMM yyyy')}</h2>
        <Button size="icon-sm" variant="ghost" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
          <ChevronRight />
        </Button>
        <Button size="sm" className="ml-2" onClick={() => setMonth(new Date())}>
          Today
        </Button>
        <span className="ml-auto text-xs text-muted">Tasks shown on their deadline</span>
      </div>
      <div className="grid grid-cols-7 border-b border-border bg-surface-2/60 text-center text-[11px] font-semibold uppercase text-muted">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const key = format(d, 'yyyy-MM-dd')
          const list = byDay.get(key) ?? []
          return (
            <div key={key} className={cn('min-h-20 border-b border-r border-border p-1 sm:min-h-28', !isSameMonth(d, month) && 'bg-surface-2/40 text-subtle')}>
              <div className={cn('mb-1 flex size-6 items-center justify-center rounded-full text-xs', isToday(d) && 'bg-accent font-bold text-black')}>{format(d, 'd')}</div>
              <div className="space-y-0.5">
                {list.slice(0, 3).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onOpen(t)}
                    className={cn(
                      'block w-full truncate rounded px-1 py-0.5 text-left text-[10px] font-medium sm:text-[11px]',
                      t.status === 'done' ? 'bg-success-soft text-success line-through' : isOverdue(t) ? 'bg-danger-soft text-danger' : t.is_milestone ? 'bg-black text-accent' : 'bg-accent-soft text-accent-ink',
                    )}
                    title={t.title}
                  >
                    {t.is_milestone && '◆ '}
                    {t.title}
                  </button>
                ))}
                {list.length > 3 && <p className="px-1 text-[10px] text-muted">+{list.length - 3} more</p>}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

export function TasksPanel({ projectId }: { projectId?: string }) {
  const { profile } = useAuth()
  const invalidate = useInvalidate()
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const tasks = useList<Task>('tasks', {
    select: '*, project:projects(id,name,code), assignee:profiles!tasks_assigned_to_fkey(id,full_name)',
    eq: { project_id: projectId },
    order: { column: 'due_date', ascending: true },
  })
  const counts = useMemo(() => {
    const d = tasks.data ?? []
    return { open: d.filter((t) => t.status !== 'done').length, overdue: d.filter(isOverdue).length, mine: d.filter((t) => t.assigned_to === profile?.id && t.status !== 'done').length, milestones: d.filter((t) => t.is_milestone).length }
  }, [tasks.data, profile?.id])

  const quick = async (t: Task, status: Task['status']) => {
    const { error } = await db.from('tasks').update({ status }).eq('id', t.id)
    if (error) return toast.error(errorMessage(error))
    toast.success(`Marked ${humanize(status).toLowerCase()}`)
    await invalidate('tasks')
  }

  const filterParam = params.get('filter')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{counts.open} open</Badge>
        <Badge tone={counts.overdue ? 'danger' : 'neutral'}>
          <AlertCircle className="size-3" /> {counts.overdue} overdue
        </Badge>
        <Badge>{counts.mine} assigned to me</Badge>
        <Badge tone="dark">
          <Diamond className="size-3" /> {counts.milestones} milestones
        </Badge>
        <div className="ml-auto inline-flex rounded-lg border border-border p-0.5" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'list'} onClick={() => setView('list')} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', view === 'list' && 'bg-foreground text-background')}>
            <List className="size-4" /> List
          </button>
          <button role="tab" aria-selected={view === 'calendar'} onClick={() => setView('calendar')} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', view === 'calendar' && 'bg-foreground text-background')}>
            <CalendarDays className="size-4" /> Calendar
          </button>
        </div>
      </div>
      {view === 'calendar' ? (
        <Calendar tasks={tasks.data ?? []} onOpen={(t) => setParams({ task: t.id })} />
      ) : (
        <ResourcePage<Task>
          config={{
            table: 'tasks',
            select: '*, project:projects(id,name,code), assignee:profiles!tasks_assigned_to_fkey(id,full_name)',
            singular: 'Task',
            plural: 'Tasks',
            eq: { project_id: projectId },
            createDefaults: projectId ? { project_id: projectId } : undefined,
            order: { column: 'due_date', ascending: true },
            perms: { create: P.tasksManage, edit: P.tasksView, remove: P.tasksManage },
            fields: taskFields(projectId),
            initialSearch: params.get('task') ? (tasks.data ?? []).find((t) => t.id === params.get('task'))?.title : undefined,
            initialFilters: filterParam === 'overdue' ? { due: 'overdue' } : filterParam === 'mine' ? { mine: 'me' } : undefined,
            beforeSave: (v) => {
              const o = { ...v }
              for (const k of ['project', 'assignee', 'completed_at']) delete o[k]
              return o
            },
            filters: [
              { key: 'status', label: 'Status', options: STATUSES },
              { key: 'priority', label: 'Priority', options: PRIORITIES },
              { key: 'due', label: 'Deadline', options: [{ value: 'overdue', label: 'Overdue' }, { value: 'week', label: 'Due in 7 days' }], predicate: (t, v) => (v === 'overdue' ? isOverdue(t) : !!t.due_date && t.status !== 'done' && t.due_date >= today() && t.due_date <= format(new Date(Date.now() + 7 * 864e5), 'yyyy-MM-dd')) },
              { key: 'mine', label: 'Assignee', options: [{ value: 'me', label: 'Assigned to me' }], predicate: (t) => t.assigned_to === profile?.id },
              { key: 'is_milestone', label: 'Type', options: [{ value: 'true', label: 'Milestones' }, { value: 'false', label: 'Tasks' }], predicate: (t, v) => String(t.is_milestone) === v },
            ],
            extraActions: (t) =>
              t.status !== 'done' ? (
                <>
                  {t.status === 'todo' && (
                    <MenuItem onSelect={() => quick(t, 'in_progress')}>
                      <PlayCircle /> Start
                    </MenuItem>
                  )}
                  <MenuItem onSelect={() => quick(t, 'done')}>
                    <CheckCircle2 /> Mark done
                  </MenuItem>
                </>
              ) : null,
            columns: [
              {
                key: 'title',
                header: 'Task',
                cell: (t) => (
                  <div className="min-w-0">
                    <p className={cn('font-medium', t.status === 'done' && 'text-muted line-through')}>
                      {t.is_milestone && <Diamond className="mr-1 inline size-3.5 fill-accent text-accent" />}
                      {t.title}
                    </p>
                    {!projectId && t.project && <p className="text-xs text-subtle">{t.project.name}</p>}
                  </div>
                ),
              },
              { key: 'assignee', header: 'Assigned to', value: (t) => t.assignee?.full_name ?? null },
              { key: 'priority', header: 'Priority', cell: (t) => <StatusBadge status={t.priority} /> },
              { key: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
              {
                key: 'due_date',
                header: 'Deadline',
                format: 'date',
                cell: (t) => (t.due_date ? <span className={cn(isOverdue(t) && 'font-semibold text-danger')}>{formatDate(t.due_date)}{isOverdue(t) && ' · overdue'}</span> : '—'),
              },
              {
                key: 'progress',
                header: 'Progress',
                format: 'percent',
                hideOnMobile: true,
                cell: (t) => (
                  <div className="ml-auto flex w-28 items-center gap-2">
                    <Progress value={t.progress} />
                    <span className="w-8 text-right text-xs tabular">{t.progress}%</span>
                  </div>
                ),
              },
            ],
            emptyDescription: 'Create tasks and milestones, assign them to team members and track deadlines.',
          }}
        />
      )}
    </div>
  )
}

export default function TasksPage() {
  return (
    <div>
      <PageHeader title="Tasks & Scheduling" description="Assignments, priorities, deadlines and milestones — in list or calendar view." />
      <TasksPanel />
    </div>
  )
}
