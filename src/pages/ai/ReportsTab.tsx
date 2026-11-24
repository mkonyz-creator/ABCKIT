import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Download, FileText, Mail, PenLine, Printer, Sparkles, Sunrise } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Markdown } from '@/components/ai/Markdown'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Textarea } from '@/components/ui/form'
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { db, IS_DEMO, unwrap } from '@/lib/backend'
import type { LoopStep } from '@/lib/ai/loop'
import type { AiReport } from '@/shared/ai/contract'
import { cn, downloadBlob, formatDateTime, humanize, slug } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AiErrorNotice, WorkingIndicator } from './parts'
import { C, generateReport, REPORT_PROMPTS, useAiInvalidate } from './useAi'

export function ReportsTab() {
  const { profile, settings } = useAuth()
  const [params, setParams] = useSearchParams()
  const selected = params.get('report')
  const invalidate = useAiInvalidate()
  const reports = useQuery({
    queryKey: [C.reports, 'list'],
    queryFn: async () => unwrap(await db.from(C.reports).select('*').order('generated_at', { ascending: false }).limit(200)) as AiReport[],
  })
  const people = useQuery({
    queryKey: ['profiles', 'names'],
    queryFn: async () => new Map((unwrap(await db.from('profiles').select('id,full_name')) as Array<{ id: string; full_name: string }>).map((p) => [p.id, p.full_name])),
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [steps, setSteps] = useState<LoopStep[]>([])
  const [error, setError] = useState<unknown>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [custom, setCustom] = useState('')

  const open = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('report', id)
    else next.delete('report')
    setParams(next)
  }

  const generate = async (kind: AiReport['kind'], title: string, prompt: string) => {
    setBusy(kind)
    setError(null)
    setSteps([])
    try {
      const { report } = await generateReport({ kind, title, prompt, userName: profile?.full_name ?? '', role: profile?.role?.name ?? '', onStep: (s) => setSteps((p) => [...p.filter((x) => x.round !== s.round), s]) })
      await invalidate(C.reports, C.activity)
      toast.success('Report saved')
      open(report.id)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  const current = reports.data?.find((r) => r.id === selected) ?? null

  if (reports.error) return <ErrorState error={reports.error} onRetry={() => reports.refetch()} />

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => generate('daily_brief', REPORT_PROMPTS.daily_brief.title, REPORT_PROMPTS.daily_brief.prompt)} loading={busy === 'daily_brief'} disabled={!!busy}>
          <Sunrise /> Daily brief
        </Button>
        <Button onClick={() => generate('operations', REPORT_PROMPTS.operations.title, REPORT_PROMPTS.operations.prompt)} loading={busy === 'operations'} disabled={!!busy}>
          <FileText /> Operations report
        </Button>
        <Button onClick={() => generate('email_digest', REPORT_PROMPTS.email_digest.title, REPORT_PROMPTS.email_digest.prompt)} loading={busy === 'email_digest'} disabled={!!busy}>
          <Mail /> Email digest
        </Button>
        <Button onClick={() => setCustomOpen(true)} disabled={!!busy}>
          <PenLine /> Custom prompt
        </Button>
      </div>
      {busy && <WorkingIndicator steps={steps} label={IS_DEMO ? 'Composing the [DEMO] report' : 'Writing the report'} />}
      {error ? <AiErrorNotice error={error} title="Could not generate the report" /> : null}

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className={cn('no-print', selected && 'hidden lg:block')}>
          <CardHeader title="Saved reports" description="Visible to everyone with AI access; reports are never edited after saving." />
          {reports.isLoading ? (
            <Skeleton className="m-4 h-40" />
          ) : !reports.data?.length ? (
            <EmptyState title="No reports yet" description="Generate a daily brief to start." />
          ) : (
            <ul className="scrollbar-thin max-h-[65vh] divide-y divide-border overflow-y-auto">
              {reports.data.map((r) => (
                <li key={r.id}>
                  <button onClick={() => open(r.id)} className={cn('block w-full px-4 py-3 text-left hover:bg-surface-2', r.id === selected && 'bg-accent-soft/60')}>
                    <p className="line-clamp-2 text-sm font-medium">{r.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-subtle">
                      <Badge>{humanize(r.kind)}</Badge>
                      {formatDateTime(r.generated_at)} · {people.data?.get(r.generated_by) ?? '—'}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className={cn(!selected && 'hidden lg:block')}>
          {current ? (
            <Card className="print-area">
              <div className="no-print flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 sm:px-5">
                <Button variant="ghost" size="sm" className="-ml-2 lg:hidden" onClick={() => open(null)}>
                  <ArrowLeft /> Reports
                </Button>
                <p className="text-xs text-muted">
                  {humanize(current.kind)} · {formatDateTime(current.generated_at)} · {people.data?.get(current.generated_by) ?? '—'} · {current.model}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => window.print()}>
                    <Printer /> Print / PDF
                  </Button>
                  <Button size="sm" onClick={() => downloadBlob(new Blob([current.content_md], { type: 'text/markdown;charset=utf-8' }), `${slug(current.title) || 'ai-report'}.md`)}>
                    <Download /> Markdown
                  </Button>
                </div>
              </div>
              <div className="px-4 py-4 sm:px-6">
                <p className="mb-3 hidden text-xs print:block">
                  {settings?.company_name ?? 'ARICOM BUILDING CONTRACTORS'} · ABCkit AI report · generated {formatDateTime(current.generated_at)} by {people.data?.get(current.generated_by) ?? '—'}
                </p>
                <Markdown text={current.content_md} />
                {current.prompt && (
                  <details className="no-print mt-4 text-xs text-muted">
                    <summary className="cursor-pointer">Prompt used</summary>
                    <p className="mt-1 whitespace-pre-wrap">{current.prompt}</p>
                  </details>
                )}
              </div>
            </Card>
          ) : (
            <Card>
              <EmptyState icon={<Sparkles className="size-6" />} title={selected && !reports.isLoading ? 'Report not found' : 'Select a report'} description="AI reports are generated from the ABCkit records your role can see." />
            </Card>
          )}
        </div>
      </div>

      <Dialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        title="Custom report"
        description="Describe the report you need. The assistant gathers the data it needs from ABCkit (within your permissions)."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={custom.trim().length < 5}
              onClick={() => {
                setCustomOpen(false)
                void generate('custom', custom.trim().slice(0, 80), custom.trim())
              }}
            >
              <Sparkles /> Generate
            </Button>
          </>
        }
      >
        <Field label="Prompt">
          <Textarea rows={5} maxLength={3000} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Summarise procurement for the Office Block this month: orders, late deliveries and supplier issues." />
        </Field>
      </Dialog>
    </div>
  )
}
