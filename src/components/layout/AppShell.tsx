import * as D from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  ClipboardPlus,
  CloudOff,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu as MenuIcon,
  MonitorSmartphone,
  Moon,
  RefreshCw,
  Search,
  Sun,
  User,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Avatar, Badge, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/misc'
import { useOnline } from '@/lib/hooks'
import { pendingCount, syncAll, useDrafts } from '@/lib/offline'
import { P } from '@/lib/permissions'
import { toast } from 'sonner'
import { db, exitDemo, resetDemoData } from '@/lib/backend'
import type { Notification } from '@/lib/types'
import { cn, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { GlobalSearch } from './GlobalSearch'
import { allowed, NAV } from './nav'
import { BrandMark } from '@/components/ui/BrandMark'
import { FloatingAssistant } from '@/components/ai/FloatingAssistant'
import { FileViewer } from '@/components/ai/FileViewer'
import { NAVIGATE_EVENT } from '@/lib/ai/uiActions'
import { useTheme } from './theme'

export function Logo({ compact }: { compact?: boolean }) {
  const { settings } = useAuth()
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark className="size-10" />
      {!compact && (
        <div className="min-w-0 leading-tight">
          <p className="text-[15px] font-extrabold tracking-tight text-white">
            ABC<span className="text-accent">kit</span>
          </p>
          <p className="truncate text-[10px] uppercase tracking-[0.12em] text-sidebar-muted">{settings?.company_name ?? 'Aricom Building Contractors'}</p>
        </div>
      )}
    </div>
  )
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth()
  const groups = ['Overview', 'Projects', 'Resources', 'Business', 'Admin'] as const
  const unread = useUnreadCount()
  return (
    <nav aria-label="Main" className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4">
      {groups.map((g) => {
        const items = NAV.filter((n) => n.group === g && allowed(n, can))
        if (!items.length) return null
        return (
          <div key={g} className="mb-5">
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-muted">{g}</p>
            <ul className="space-y-0.5">
              {items.map((n) => (
                <li key={n.to}>
                  <NavLink
                    to={n.to}
                    end={n.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-fg transition-colors hover:bg-sidebar-hover hover:text-white',
                        isActive && 'bg-sidebar-hover font-semibold text-white before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-accent',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <n.icon className={cn('size-[18px] shrink-0', isActive ? 'text-accent' : 'text-sidebar-muted group-hover:text-sidebar-fg')} />
                        <span className="truncate">{n.label}</span>
                        {n.to === '/notifications' && unread > 0 && (
                          <span className="ml-auto rounded-full bg-accent px-1.5 text-[10px] font-bold text-black tabular">{unread > 99 ? '99+' : unread}</span>
                        )}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

function useUnreadCount() {
  const { session } = useAuth()
  const q = useQuery({
    queryKey: ['notifications', 'unread', session?.user.id],
    enabled: !!session,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false)
      return count ?? 0
    },
  })
  return q.data ?? 0
}

function NotificationBell() {
  const { session } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const unread = useUnreadCount()
  const list = useQuery({
    queryKey: ['notifications', 'recent', session?.user.id],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await db.from('notifications').select('*').order('created_at', { ascending: false }).limit(8)
      if (error) throw error
      return data as Notification[]
    },
  })

  // live updates
  useEffect(() => {
    if (!session) return
    const ch = db
      .channel(`notifications-${session.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${session.user.id}` }, () => {
        void qc.invalidateQueries({ queryKey: ['notifications'] })
      })
      .subscribe()
    return () => {
      void db.removeChannel(ch)
    }
  }, [session, qc])

  const open = async (n: Notification) => {
    if (!n.is_read) {
      await db.from('notifications').update({ is_read: true }).eq('id', n.id)
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    }
    if (n.link) navigate(n.link)
  }

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} className="relative">
          <Bell />
          {unread > 0 && <span className="absolute right-2 top-2 size-2 rounded-full bg-accent ring-2 ring-surface" />}
        </Button>
      </MenuTrigger>
      <MenuContent>
        <div className="w-[min(92vw,360px)]">
          <div className="flex items-center justify-between px-2.5 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <Badge tone="accent">{unread} new</Badge>}
          </div>
          <MenuSeparator />
          {(list.data ?? []).length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">You're all caught up.</p>
          ) : (
            list.data!.map((n) => (
              <MenuItem key={n.id} onSelect={() => open(n)}>
                <div className="flex w-full min-w-0 gap-2.5">
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.is_read ? 'bg-transparent' : 'bg-accent')} />
                  <div className="min-w-0">
                    <p className={cn('truncate text-sm', !n.is_read && 'font-semibold')}>{n.title}</p>
                    {n.body && <p className="line-clamp-2 text-xs text-muted">{n.body}</p>}
                    <p className="mt-0.5 text-[11px] text-subtle">{timeAgo(n.created_at)}</p>
                  </div>
                </div>
              </MenuItem>
            ))
          )}
          <MenuSeparator />
          <MenuItem onSelect={() => navigate('/notifications')}>View all notifications</MenuItem>
        </div>
      </MenuContent>
    </Menu>
  )
}

function SyncIndicator() {
  const online = useOnline()
  const drafts = useDrafts()
  const pending = pendingCount(drafts)
  const conflicts = drafts.filter((d) => d.state === 'conflict' || d.state === 'error').length
  if (online && pending === 0) return null
  return (
    <Link
      to="/site-reports?tab=offline"
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
        !online ? 'border-warning/40 bg-warning-soft text-warning' : conflicts ? 'border-danger/40 bg-danger-soft text-danger' : 'border-info/30 bg-info-soft text-info',
      )}
      title="Records saved on this device that are not yet on the server"
    >
      {!online ? <CloudOff className="size-3.5" /> : <RefreshCw className="size-3.5" />}
      <span className="hidden sm:inline">{!online ? 'Offline' : conflicts ? 'Sync issue' : 'Syncing'}</span>
      {pending > 0 && <span className="tabular">· {pending} unsynced</span>}
    </Link>
  )
}

export function AppShell() {
  const { profile, signOut, signOutEverywhere, can, isDemo } = useAuth()
  const { theme, toggle } = useTheme()
  const [drawer, setDrawer] = useState(false)
  const [search, setSearch] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => setDrawer(false), [location.pathname])
  // the AI assistant's open_page tool (the path was checked against the menu and the user's permissions)
  useEffect(() => {
    const onNav = (e: Event) => navigate((e as CustomEvent<string>).detail)
    window.addEventListener(NAVIGATE_EVENT, onNav)
    return () => window.removeEventListener(NAVIGATE_EVENT, onNav)
  }, [navigate])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearch(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-black">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 flex-col bg-sidebar lg:flex">
        <div className="flex h-16 items-center border-b border-white/10 px-5">
          <Logo />
        </div>
        <SidebarNav />
        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <Avatar name={profile?.full_name} />
            <div className="min-w-0 text-xs">
              <p className="truncate font-semibold text-white">{profile?.full_name}</p>
              <p className="truncate text-sidebar-muted">{profile?.role?.name}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      <D.Root open={drawer} onOpenChange={setDrawer}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-black/60 lg:hidden" />
          <D.Content className="fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl lg:hidden" aria-describedby={undefined}>
            <D.Title className="sr-only">Navigation</D.Title>
            <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
              <Logo />
              <D.Close className="rounded p-2 text-sidebar-fg hover:bg-sidebar-hover" aria-label="Close menu">
                <X className="size-5" />
              </D.Close>
            </div>
            <SidebarNav onNavigate={() => setDrawer(false)} />
          </D.Content>
        </D.Portal>
      </D.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        {isDemo && (
          <div role="note" className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 bg-accent px-4 py-1.5 text-xs font-medium text-black">
            <strong className="uppercase tracking-wide">Demo mode</strong>
            <span className="hidden sm:inline">Sample [DEMO] data stored only in this browser — not secure, not company data. Signed in as {profile?.role?.name}.</span>
            <span className="ml-auto flex gap-3">
              <button className="underline underline-offset-2" onClick={() => void signOut()}>
                Switch role
              </button>
              <button
                className="underline underline-offset-2"
                onClick={() => confirm('Reset the demo? All changes you made will be lost.') && void resetDemoData().then(() => window.location.reload())}
              >
                Reset demo
              </button>
              <button className="underline underline-offset-2" onClick={exitDemo}>
                Exit demo
              </button>
            </span>
          </div>
        )}
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-surface/90 px-3 backdrop-blur sm:px-5">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
            <MenuIcon />
          </Button>
          <div className="lg:hidden">
            <Link to="/" aria-label="Dashboard" className="flex items-center gap-1.5 font-extrabold">
              <BrandMark className="size-8" title="" />
              <span>
                ABC<span className="text-accent-ink">kit</span>
              </span>
            </Link>
          </div>
          <button
            onClick={() => setSearch(true)}
            className="ml-auto hidden h-10 w-full max-w-md items-center gap-2 rounded-md border border-border bg-surface-2/60 px-3 text-sm text-subtle transition-colors hover:border-border-strong sm:flex lg:ml-0"
          >
            <Search className="size-4" />
            Search projects, materials, people…
            <kbd className="ml-auto rounded border border-border bg-surface px-1.5 font-mono text-[10px]">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <SyncIndicator />
            <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setSearch(true)} aria-label="Search">
              <Search />
            </Button>
            <Button variant="ghost" size="icon" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <NotificationBell />
            <Menu>
              <MenuTrigger asChild>
                <button className="ml-1 rounded-full focus-visible:outline-2" aria-label="Account menu">
                  <Avatar name={profile?.full_name} />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>
                  <span className="block text-sm text-foreground">{profile?.full_name}</span>
                  <span className="block font-normal">{profile?.email}</span>
                  {profile?.role?.name && <span className="mt-1 block text-[11px] font-semibold uppercase tracking-wide text-accent-ink">{profile.role.name}</span>}
                </MenuLabel>
                <MenuSeparator />
                <MenuItem onSelect={() => navigate('/profile')}>
                  <User /> My profile
                </MenuItem>
                <MenuItem onSelect={() => void syncAll()}>
                  <RefreshCw /> Sync offline data
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={() => void signOut()}>
                  <LogOut /> Sign out
                </MenuItem>
                {!isDemo && (
                  <MenuItem
                    onSelect={() => {
                      if (!confirm('Sign out on ALL devices? Every open session of your account (phones, other computers) will be ended.')) return
                      void signOutEverywhere().then((err) => err && toast.error(err))
                    }}
                  >
                    <MonitorSmartphone /> Sign out of all devices
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-[1500px] flex-1 px-4 pb-28 pt-5 sm:px-6 lg:pb-10">
          <Outlet />
        </main>

        {/* Mobile quick actions */}
        <nav aria-label="Quick actions" className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <ul className="grid grid-cols-5">
            {[
              { to: '/', icon: LayoutDashboard, label: 'Home', show: true },
              { to: '/projects', icon: FolderKanban, label: 'Projects', show: can(P.projectsView) },
              { to: '/site-reports/new', icon: ClipboardPlus, label: 'Report', show: can(P.siteReport), primary: true },
              { to: '/tasks', icon: ListChecks, label: 'Tasks', show: can(P.tasksView) },
              { to: '/notifications', icon: Bell, label: 'Alerts', show: true },
            ].map((i) =>
              i.show ? (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end={i.to === '/'}
                    className={({ isActive }) =>
                      cn('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium', isActive ? 'text-accent-ink' : 'text-muted')
                    }
                  >
                    {i.primary ? (
                      <span className="-mt-6 flex size-12 items-center justify-center rounded-full bg-accent text-black shadow-lg ring-4 ring-surface">
                        <i.icon className="size-5" />
                      </span>
                    ) : (
                      <i.icon className="size-5" />
                    )}
                    {i.label}
                  </NavLink>
                </li>
              ) : (
                <li key={i.to} />
              ),
            )}
          </ul>
        </nav>
      </div>
      <GlobalSearch open={search} onOpenChange={setSearch} />
      <FloatingAssistant />
      <FileViewer />
    </div>
  )
}
