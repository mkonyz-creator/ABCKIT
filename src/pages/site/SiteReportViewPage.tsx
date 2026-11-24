import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, FileDown, Pencil, Printer, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Card, CardHeader, DemoBadge, ErrorState, KeyValue, PageHeader, Spinner, StatusBadge } from '@/components/ui/misc'
import { buildPdf } from '@/lib/export'
import { useInvalidate, useSignedUrl } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db, unwrap } from '@/lib/backend'
import type { SiteReport } from '@/lib/types'
import { errorMessage, formatDate, formatDateTime, formatNumber } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { WEATHER } from './siteConfig'

type FullReport = SiteReport & {
  project: { id: string; name: string; code: string; location: string | null; client: { name: string } | null }
  photos: Array<{ id: string; storage_path: string; caption: string | null }>
}

export default function SiteReportViewPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const invalidate = useInvalidate()
  const { can, profile, settings } = useAuth()
  const [review, setReview] = useState<null | 'approved' | 'rejected'>(null)
  const [busy, setBusy] = useState(false)

  const q = useQuery({
    queryKey: ['site_reports', 'one', id],
    queryFn: async () =>
      unwrap(
        await db
          .from('site_reports')
          .select('*, project:projects(id,name,code,location,client:clients(name)), engineer:profiles!site_reports_engineer_id_fkey(id,full_name), approver:profiles!site_reports_approved_by_fkey(id,full_name), photos:site_report_photos(id,storage_path,caption)')
          .eq('id', id!)
          .single(),
      ) as FullReport,
  })

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (!q.data) return <Spinner />
  const r = q.data
  const canEdit = r.engineer_id === profile?.id && ['draft', 'rejected', 'submitted'].includes(r.status) && can(P.siteReport)
  const canReview = can(P.siteApprove) && r.status === 'submitted'

  const doReview = async (comment?: string) => {
    if (!review) return
    setBusy(true)
    try {
      unwrap(await db.from('site_reports').update({ status: review, review_comment: comment ?? null }).eq('id', r.id))
      toast.success(review === 'approved' ? 'Report approved' : 'Report returned to engineer')
      setReview(null)
      await invalidate('site_reports', 'projects')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const exportPdf = async () => {
    try {
      const weather = WEATHER.find((w) => w.value === r.weather)?.label.replace(/^\S+\s/, '') ?? r.weather ?? '—'
      const doc = await buildPdf(
        {
          title: 'Daily Site Report',
          subtitle: `${r.number} · ${formatDate(r.report_date, 'EEEE dd MMMM yyyy')} · Status: ${r.status.toUpperCase()}`,
          company: settings ? { name: settings.company_name, address: settings.address, phone: settings.phone, email: settings.email, tin: settings.tin } : undefined,
          fields: [
            { label: 'Project', value: `${r.project.code} – ${r.project.name}` },
            { label: 'Client', value: r.project.client?.name ?? '—' },
            { label: 'Location', value: r.project.location ?? '—' },
            { label: 'Site engineer', value: r.engineer?.full_name ?? '—' },
            { label: 'Weather', value: `${weather}${r.temperature_c != null ? `, ${r.temperature_c}°C` : ''}` },
            { label: 'Workers on site', value: String(r.workers_count) },
            { label: 'Progress', value: r.progress_percent != null ? `${r.progress_percent}%` : '—' },
            { label: 'Safety incidents', value: String(r.safety_incidents) },
          ],
        },
        [
          { heading: 'Work performed', columns: [{ header: 'Description', value: (x: any) => x.t }], rows: [{ t: r.work_performed || '—' }] },
          ...(r.labour.length ? [{ heading: 'Labour deployed', columns: [{ header: 'Trade', value: (x: any) => x.trade }, { header: 'Workers', value: (x: any) => x.count, format: 'number' as const }], rows: r.labour }] : []),
          ...(r.materials_used.length ? [{ heading: 'Materials used', columns: [{ header: 'Material', value: (x: any) => x.name }, { header: 'Qty', value: (x: any) => x.quantity, format: 'number' as const }, { header: 'Unit', value: (x: any) => x.unit }], rows: r.materials_used }] : []),
          ...(r.equipment_used.length ? [{ heading: 'Equipment used', columns: [{ header: 'Equipment', value: (x: any) => x.name }, { header: 'Hours', value: (x: any) => x.hours, format: 'number' as const }], rows: r.equipment_used }] : []),
          {
            heading: 'Observations',
            columns: [
              { header: 'Item', value: (x: any) => x.k },
              { header: 'Details', value: (x: any) => x.v },
            ],
            rows: [
              { k: 'Problems encountered', v: r.problems ?? '—' },
              { k: 'Health & safety', v: r.safety_observations ?? '—' },
              { k: 'Recommendations', v: r.recommendations ?? '—' },
              { k: 'Engineer comments', v: r.engineer_comments ?? '—' },
              ...(r.review_comment ? [{ k: 'Reviewer comment', v: r.review_comment }] : []),
            ],
          },
        ],
        (doc, y) => {
          if (y > doc.internal.pageSize.getHeight() - 60) {
            doc.addPage()
            y = 20
          }
          doc.setFontSize(9)
          doc.setFont('helvetica', 'bold')
          doc.text('Engineer signature', 14, y + 4)
          if (r.signature_data) doc.addImage(r.signature_data, 'PNG', 14, y + 6, 60, 22)
          doc.setFont('helvetica', 'normal')
          doc.text(`${r.engineer?.full_name ?? ''}`, 14, y + 32)
          doc.setFont('helvetica', 'bold')
          doc.text('Approval', 110, y + 4)
          doc.setFont('helvetica', 'normal')
          doc.text(r.status === 'approved' ? `Approved by ${r.approver?.full_name ?? ''}` : r.status.toUpperCase(), 110, y + 12)
          if (r.approved_at) doc.text(formatDateTime(r.approved_at), 110, y + 18)
          return y + 40
        },
      )
      doc.save(`${r.number}.pdf`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const weather = WEATHER.find((w) => w.value === r.weather)?.label ?? r.weather

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        breadcrumb={
          <Link to="/site-reports" className="no-print inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-3" /> Daily site reports
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            Daily Site Report <StatusBadge status={r.status} /> {r.is_demo && <DemoBadge />}
          </span>
        }
        description={`${r.number} · ${formatDate(r.report_date, 'EEEE dd MMMM yyyy')}`}
        actions={
          <div className="no-print flex flex-wrap gap-2">
            <Button onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            <Button onClick={exportPdf}>
              <FileDown /> PDF
            </Button>
            {canEdit && (
              <Button onClick={() => navigate(`/site-reports/${r.id}/edit`)}>
                <Pencil /> Edit
              </Button>
            )}
            {canReview && (
              <>
                <Button variant="danger" onClick={() => setReview('rejected')}>
                  <XCircle /> Return
                </Button>
                <Button variant="primary" onClick={() => setReview('approved')}>
                  <CheckCircle2 /> Approve
                </Button>
              </>
            )}
          </div>
        }
      />

      {r.status === 'rejected' && r.review_comment && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          <strong>Returned for correction:</strong> {r.review_comment}
        </div>
      )}

      <div className="print-area space-y-4">
        <Card className="p-4 sm:p-5">
          <KeyValue
            cols={4}
            items={[
              { label: 'Project', value: <Link className="text-accent-ink hover:underline" to={`/projects/${r.project.id}`}>{r.project.code} · {r.project.name}</Link> },
              { label: 'Site engineer', value: r.engineer?.full_name },
              { label: 'Weather', value: `${weather ?? '—'}${r.temperature_c != null ? ` · ${r.temperature_c}°C` : ''}` },
              { label: 'Workers on site', value: <span className="text-lg font-bold">{r.workers_count}</span> },
              { label: 'Progress', value: r.progress_percent != null ? `${formatNumber(r.progress_percent, 1)}%` : '—' },
              { label: 'Safety incidents', value: r.safety_incidents },
              { label: 'Submitted', value: r.submitted_at ? formatDateTime(r.submitted_at) : '—' },
              { label: 'Approved', value: r.approved_at ? `${formatDateTime(r.approved_at)} · ${r.approver?.full_name ?? ''}` : '—' },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Work performed" />
          <p className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed sm:px-5">{r.work_performed || '—'}</p>
        </Card>

        <div className="grid gap-4 md:grid-cols-3">
          <MiniTable title="Labour deployed" head={['Trade', 'No.']} rows={r.labour.map((l) => [l.trade, String(l.count)])} />
          <MiniTable title="Materials used" head={['Material', 'Qty']} rows={r.materials_used.map((m) => [m.name, `${formatNumber(m.quantity ?? 0)} ${m.unit ?? ''}`])} />
          <MiniTable title="Equipment used" head={['Equipment', 'Hrs']} rows={r.equipment_used.map((m) => [m.name, formatNumber(m.hours ?? 0)])} />
        </div>

        <Card className="p-4 sm:p-5">
          <KeyValue
            items={[
              { label: 'Problems encountered', value: <span className="whitespace-pre-wrap">{r.problems ?? '—'}</span> },
              { label: 'Health & safety observations', value: <span className="whitespace-pre-wrap">{r.safety_observations ?? '—'}</span> },
              { label: 'Recommendations', value: <span className="whitespace-pre-wrap">{r.recommendations ?? '—'}</span> },
              { label: 'Engineer comments', value: <span className="whitespace-pre-wrap">{r.engineer_comments ?? '—'}</span> },
            ]}
          />
        </Card>

        {r.photos.length > 0 && (
          <Card>
            <CardHeader title={`Site photos (${r.photos.length})`} />
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 sm:p-5">
              {r.photos.map((p) => (
                <SitePhoto key={p.id} path={p.storage_path} caption={p.caption} />
              ))}
            </div>
          </Card>
        )}

        <Card className="grid gap-6 p-4 sm:grid-cols-2 sm:p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Engineer signature</p>
            {r.signature_data ? <img src={r.signature_data} alt={`Signature of ${r.engineer?.full_name}`} className="mt-2 h-24 rounded border border-border bg-white" /> : <p className="mt-2 text-sm text-muted">Not signed</p>}
            <p className="mt-1 text-sm">{r.engineer?.full_name}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Approval status</p>
            <div className="mt-2">
              <StatusBadge status={r.status} />
            </div>
            {r.approver && <p className="mt-1 text-sm">{r.approver.full_name} · {formatDateTime(r.approved_at)}</p>}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={!!review}
        onOpenChange={(o) => !o && setReview(null)}
        title={review === 'approved' ? 'Approve this report?' : 'Return report to engineer?'}
        message={review === 'approved' ? 'Approving locks the report. If it records a progress %, the project progress is updated.' : 'The engineer will be notified and can correct and resubmit the report.'}
        confirmLabel={review === 'approved' ? 'Approve' : 'Return report'}
        danger={review === 'rejected'}
        requireReason={review === 'rejected' ? 'What needs correcting?' : undefined}
        loading={busy}
        onConfirm={doReview}
      />
    </div>
  )
}

function MiniTable({ title, head, rows }: { title: string; head: [string, string]; rows: string[][] }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">None recorded</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase text-subtle">
            <tr>
              <th className="px-4 py-1.5 font-semibold">{head[0]}</th>
              <th className="px-4 py-1.5 text-right font-semibold">{head[1]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-4 py-1.5">{r[0]}</td>
                <td className="px-4 py-1.5 text-right tabular">{r[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function SitePhoto({ path, caption }: { path: string; caption: string | null }) {
  const url = useSignedUrl('site-photos', path)
  return (
    <a href={url.data} target="_blank" rel="noreferrer" className="block aspect-square overflow-hidden rounded-lg border border-border bg-surface-2">
      {url.data ? <img src={url.data} alt={caption ?? 'Site photo'} loading="lazy" className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-xs text-subtle">Loading…</span>}
    </a>
  )
}
