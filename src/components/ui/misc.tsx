import * as DM from '@radix-ui/react-dropdown-menu'
import * as T from '@radix-ui/react-tabs'
import { AlertTriangle, FlaskConical, Inbox, Loader2, RefreshCw } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn, errorMessage, humanize, initials } from '@/lib/utils'
import { Button } from './button'

// ---------------------------------------------------------------- Card
export function Card({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('rounded-xl border border-border bg-surface shadow-[0_1px_0_rgba(0,0,0,0.03)]', className)} {...props}>
      {children}
    </div>
  )
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Badges
const tone = {
  neutral: 'bg-surface-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent-ink border-accent/30',
  success: 'bg-success-soft text-success border-success/25',
  warning: 'bg-warning-soft text-warning border-warning/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
  info: 'bg-info-soft text-info border-info/25',
  dark: 'bg-foreground text-background border-foreground',
} as const
export type Tone = keyof typeof tone

export function Badge({ children, tone: t = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold', tone[t], className)}>
      {children}
    </span>
  )
}

const statusTones: Record<string, Tone> = {
  // projects
  planning: 'info', active: 'accent', on_hold: 'warning', completed: 'success', cancelled: 'neutral',
  // approvals / workflow
  draft: 'neutral', submitted: 'info', pending: 'warning', pending_approval: 'warning', approved: 'success',
  rejected: 'danger', void: 'neutral', superseded: 'neutral', sent: 'info', ordered: 'info',
  partially_received: 'warning', received: 'success',
  // invoices
  unpaid: 'danger', partially_paid: 'warning', paid: 'success', issued: 'info', disputed: 'danger',
  // tasks
  todo: 'neutral', in_progress: 'accent', review: 'info', blocked: 'danger', done: 'success',
  // equipment
  available: 'success', in_use: 'accent', maintenance: 'warning', breakdown: 'danger', retired: 'neutral',
  scheduled: 'info',
  // people
  on_leave: 'warning', suspended: 'danger', terminated: 'neutral', present: 'success', absent: 'danger',
  late: 'warning', half_day: 'warning', leave: 'info', sick: 'warning', off: 'neutral',
  // priority / severity
  low: 'neutral', medium: 'info', normal: 'info', high: 'warning', urgent: 'danger', critical: 'danger',
  near_miss: 'info', minor: 'warning', moderate: 'warning', major: 'danger', fatal: 'danger',
  open: 'danger', investigating: 'warning', closed: 'success', in_review: 'warning', resolved: 'success',
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return <span className="text-subtle">—</span>
  return (
    <Badge tone={statusTones[status] ?? 'neutral'} className={className}>
      {humanize(status)}
    </Badge>
  )
}

export function DemoBadge() {
  return (
    <Badge tone="warning" className="uppercase tracking-wide">
      <FlaskConical className="size-3" /> Demo
    </Badge>
  )
}

// ---------------------------------------------------------------- Progress
export function Progress({ value, className, tone: t = 'accent', label }: { value: number; className?: string; tone?: 'accent' | 'success' | 'danger'; label?: string }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <div
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progress'}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-2', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', { accent: 'bg-accent', success: 'bg-success', danger: 'bg-danger' }[t])}
        style={{ width: `${v}%` }}
      />
    </div>
  )
}

// ---------------------------------------------------------------- States
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <div role="status" className={cn('flex items-center justify-center gap-2 p-8 text-sm text-muted', className)}>
      <Loader2 className="size-5 animate-spin text-accent" />
      <span>{label}…</span>
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} />
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-surface-2 text-subtle">{icon ?? <Inbox className="size-6" />}</div>
      <p className="font-semibold">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle className="size-6" />
      </div>
      <p className="font-semibold">Something went wrong</p>
      <p className="mt-1 max-w-md text-sm text-muted">{errorMessage(error)}</p>
      {onRetry && (
        <Button className="mt-4" size="sm" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Avatar
export function Avatar({ name, src, className }: { name?: string | null; src?: string | null; className?: string }) {
  return src ? (
    <img src={src} alt="" className={cn('size-8 rounded-full object-cover', className)} />
  ) : (
    <span className={cn('inline-flex size-8 items-center justify-center rounded-full bg-accent text-xs font-bold text-black', className)} aria-hidden>
      {initials(name)}
    </span>
  )
}

// ---------------------------------------------------------------- Page header
export function PageHeader({ title, description, actions, breadcrumb }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-xs text-muted">{breadcrumb}</div>}
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Stat tile
export function StatCard({
  label,
  value,
  hint,
  icon,
  emphasis,
  onClick,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  emphasis?: boolean
  onClick?: () => void
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'group relative w-full overflow-hidden rounded-xl border p-4 text-left transition-colors',
        emphasis ? 'border-black bg-black text-white dark:border-border' : 'border-border bg-surface',
        onClick && 'cursor-pointer hover:border-accent',
      )}
    >
      {emphasis && <span className="absolute inset-x-0 top-0 h-1 bg-accent" />}
      <div className="flex items-start justify-between gap-2">
        <p className={cn('text-xs font-semibold uppercase tracking-wide', emphasis ? 'text-white/70' : 'text-muted')}>{label}</p>
        {icon && <span className={cn('[&_svg]:size-4', emphasis ? 'text-accent' : 'text-subtle group-hover:text-accent')}>{icon}</span>}
      </div>
      <p className="mt-2 truncate text-2xl font-bold tracking-tight">{value}</p>
      {hint && <p className={cn('mt-1 text-xs', emphasis ? 'text-white/70' : 'text-muted')}>{hint}</p>}
    </Comp>
  )
}

// ---------------------------------------------------------------- Tabs
export const Tabs = T.Root
export function TabsList({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <T.List className={cn('scrollbar-thin -mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-border px-1', className)}>{children}</T.List>
  )
}
export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <T.Trigger
      value={value}
      className="-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:text-foreground data-[state=active]:border-accent data-[state=active]:text-foreground [&_svg]:size-4"
    >
      {children}
    </T.Trigger>
  )
}
export const TabsContent = T.Content

// ---------------------------------------------------------------- Dropdown
export const Menu = DM.Root
export const MenuTrigger = DM.Trigger
export function MenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' | 'center' }) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 text-sm shadow-xl"
      >
        {children}
      </DM.Content>
    </DM.Portal>
  )
}
export function MenuItem({ children, onSelect, danger, disabled }: { children: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <DM.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-4',
        danger && 'text-danger',
      )}
    >
      {children}
    </DM.Item>
  )
}
export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-border" />
}
export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2.5 py-1.5 text-xs font-semibold text-muted">{children}</DM.Label>
}

// ---------------------------------------------------------------- Key/value
export function KeyValue({ items, cols = 2 }: { items: Array<{ label: string; value: ReactNode }>; cols?: 1 | 2 | 3 | 4 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', { 1: 'grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'grid-cols-2 lg:grid-cols-4' }[cols])}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-semibold uppercase tracking-wide text-subtle">{i.label}</dt>
          <dd className="mt-0.5 break-words text-sm">{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}
