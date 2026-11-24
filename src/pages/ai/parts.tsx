import { AlertTriangle, CheckCircle2, CircleX, FlaskConical, Loader2, Lock, ShieldAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge, Card, type Tone } from '@/components/ui/misc'
import type { LoopStep } from '@/lib/ai/loop'
import { errorMessage, humanize } from '@/lib/utils'

export const PRIORITY_TONE: Record<string, Tone> = { low: 'neutral', medium: 'info', high: 'warning', urgent: 'danger' }

export function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  if (!priority) return <span className="text-subtle">—</span>
  return <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'}>{humanize(priority)}</Badge>
}

export const TOOL_TITLES: Record<string, string> = {
  get_company_overview: 'Reading company overview',
  get_projects: 'Checking projects & schedules',
  get_project_progress: 'Checking project progress',
  get_project_details: 'Reading project details',
  list_tasks: 'Checking tasks',
  get_pending_approvals: 'Looking for pending approvals',
  list_deliveries: 'Checking supplier deliveries',
  get_financial_summary: 'Reading finance summary',
  list_site_issues: 'Checking site issues',
  search_emails: 'Searching emails',
  get_email: 'Opening an email',
  summarize_email: 'Summarising an email',
  list_alerts: 'Reading alerts',
  search_knowledge: 'Searching the knowledge base',
  get_inventory_alerts: 'Checking stock levels',
  get_workforce_summary: 'Reading workforce summary',
  draft_email: 'Preparing a reply draft (not sent)',
  search_documents: 'Searching documents',
  open_document: 'Opening the file on your screen',
  read_document: 'Reading the file',
  open_page: 'Opening the page',
  open_dashboard: 'Opening the dashboard',
}

/** "thinking / working" indicator with the data tools being run */
export function WorkingIndicator({ steps, label = 'Working' }: { steps: LoopStep[]; label?: string }) {
  const tools = steps.flatMap((s) => s.tools)
  return (
    <div role="status" aria-live="polite" className="rounded-lg border border-border bg-surface-2/60 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <Loader2 className="size-4 animate-spin text-accent" /> {label}…
        {!tools.length && <span className="text-xs font-normal text-muted">asking the assistant</span>}
      </p>
      {tools.length > 0 && (
        <ul className="mt-2 space-y-1">
          {tools.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-xs text-muted">
              {t.status === 'running' ? <Loader2 className="size-3.5 animate-spin text-accent" /> : t.status === 'done' ? <CheckCircle2 className="size-3.5 text-success" /> : <CircleX className="size-3.5 text-danger" />}
              <span>{TOOL_TITLES[t.name] ?? humanize(t.name)}</span>
              <code className="hidden font-mono text-[10px] text-subtle sm:inline">{t.name}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** error from the AI service, shown as returned (function not deployed, AI not configured, limits…) */
export function AiErrorNotice({ error, title = 'The AI service returned an error' }: { error: unknown; title?: string }) {
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="font-semibold text-danger">{title}</p>
        <p className="mt-0.5 break-words text-foreground/80">{errorMessage(error)}</p>
      </div>
    </div>
  )
}

export function NoAccess({ title, description }: { title: string; description: string }) {
  return (
    <Card className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-surface-2 text-subtle">
        <ShieldAlert className="size-6" />
      </div>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted">{description}</p>
    </Card>
  )
}

export function DemoNote({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
      <FlaskConical className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

export function Untrusted({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-subtle">
      <Lock className="size-3" /> {children}
    </p>
  )
}
