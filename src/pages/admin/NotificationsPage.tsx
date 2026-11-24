import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bell, CheckCheck, CheckCircle2, ClipboardCheck, Info, ListTodo, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, EmptyState, ErrorState, PageHeader, Spinner } from '@/components/ui/misc'
import { db, unwrap } from '@/lib/backend'
import type { Notification } from '@/lib/types'
import { cn, errorMessage, formatDateTime, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

const ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, alert: AlertTriangle, task: ListTodo, approval: ClipboardCheck }

export default function NotificationsPage() {
  const { session } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [unreadOnly, setUnreadOnly] = useState(false)
  const q = useQuery({
    queryKey: ['notifications', 'all', session?.user.id, unreadOnly],
    queryFn: async () => {
      let r = db.from('notifications').select('*').order('created_at', { ascending: false }).limit(300)
      if (unreadOnly) r = r.eq('is_read', false)
      return unwrap(await r) as Notification[]
    },
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] })

  const markAll = async () => {
    const { error } = await db.from('notifications').update({ is_read: true }).eq('is_read', false)
    if (error) return toast.error(errorMessage(error))
    await refresh()
  }
  const open = async (n: Notification) => {
    if (!n.is_read) await db.from('notifications').update({ is_read: true }).eq('id', n.id)
    await refresh()
    if (n.link) navigate(n.link)
  }
  const remove = async (n: Notification) => {
    const { error } = await db.from('notifications').delete().eq('id', n.id)
    if (error) return toast.error(errorMessage(error))
    await refresh()
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        description="Approvals, assignments, stock alerts and deadlines that need your attention."
        actions={
          <>
            <Button size="sm" variant={unreadOnly ? 'dark' : 'outline'} onClick={() => setUnreadOnly((u) => !u)}>
              {unreadOnly ? 'Showing unread' : 'Show unread only'}
            </Button>
            <Button size="sm" onClick={markAll}>
              <CheckCheck /> Mark all read
            </Button>
          </>
        }
      />
      <Card>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <Spinner />
        ) : (q.data ?? []).length === 0 ? (
          <EmptyState icon={<Bell className="size-6" />} title={unreadOnly ? 'No unread notifications' : 'No notifications yet'} />
        ) : (
          <ul className="divide-y divide-border">
            {q.data!.map((n) => {
              const Icon = ICON[n.type] ?? Info
              return (
                <li key={n.id} className={cn('flex items-start gap-3 px-4 py-3 sm:px-5', !n.is_read && 'bg-accent-soft/40')}>
                  <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', n.type === 'alert' || n.type === 'warning' ? 'bg-danger-soft text-danger' : n.type === 'success' ? 'bg-success-soft text-success' : 'bg-surface-2 text-accent-ink')}>
                    <Icon className="size-4" />
                  </span>
                  <button className="min-w-0 flex-1 text-left" onClick={() => open(n)}>
                    <p className={cn('text-sm', !n.is_read && 'font-semibold')}>{n.title}</p>
                    {n.body && <p className="text-sm text-muted">{n.body}</p>}
                    <p className="mt-0.5 text-xs text-subtle" title={formatDateTime(n.created_at)}>
                      {timeAgo(n.created_at)}
                    </p>
                  </button>
                  <Button size="icon-sm" variant="ghost" onClick={() => remove(n)} aria-label="Delete notification">
                    <Trash2 />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
