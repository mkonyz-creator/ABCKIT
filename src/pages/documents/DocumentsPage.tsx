import { useQuery } from '@tanstack/react-query'
import { Download, FileImage, FileSpreadsheet, FileText, History, Lock, MoreHorizontal, Trash2, Upload, UploadCloud } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DataTable } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Badge, Card, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PageHeader, Spinner } from '@/components/ui/misc'
import { DOC_CATEGORIES, downloadDocument, uploadDocument, validateUpload } from '@/lib/documents'
import { useInvalidate, useList, useProjectOptions } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db, unwrap } from '@/lib/backend'
import { cn, errorMessage, formatDateTime, humanize } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

interface Doc {
  id: string
  project_id: string | null
  title: string
  category: string
  description: string | null
  tags: string[]
  access_level: 'project' | 'management' | 'restricted'
  current_version: number
  current_path: string | null
  file_name: string | null
  mime_type: string | null
  size_bytes: number | null
  created_by: string
  updated_at: string
  is_demo: boolean
  project?: { name: string; code: string } | null
  creator?: { full_name: string } | null
}

function fmtSize(b: number | null) {
  if (!b) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function FileIcon({ mime, name }: { mime: string | null; name: string | null }) {
  const cls = 'size-4 shrink-0'
  if (mime?.startsWith('image/')) return <FileImage className={cn(cls, 'text-info')} />
  if (/sheet|excel|csv/.test(mime ?? '') || /\.(xlsx?|csv)$/i.test(name ?? '')) return <FileSpreadsheet className={cn(cls, 'text-success')} />
  return <FileText className={cn(cls, 'text-accent-ink')} />
}

/** fields the AI assistant fills in before the user picks the file (start_document_upload) */
export interface UploadPrefill {
  title?: string
  category?: string
  project_id?: string
  description?: string
  tags?: string
}

function UploadDialog({ open, onOpenChange, projectId, prefill }: { open: boolean; onOpenChange: (o: boolean) => void; projectId?: string; prefill?: UploadPrefill }) {
  const { can } = useAuth()
  const invalidate = useInvalidate()
  const projects = useProjectOptions()
  const [files, setFiles] = useState<File[]>([])
  const [f, setF] = useState({
    project_id: projectId ?? prefill?.project_id ?? '',
    title: prefill?.title ?? '',
    category: prefill?.category && DOC_CATEGORIES.some((c) => c.value === prefill.category) ? prefill.category : 'other',
    access_level: 'project',
    tags: prefill?.tags ?? '',
    description: prefill?.description ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const pick = (list: FileList | null) => {
    if (!list) return
    const ok: File[] = []
    for (const file of Array.from(list)) {
      const err = validateUpload(file)
      if (err) toast.error(`${file.name}: ${err}`)
      else ok.push(file)
    }
    setFiles((cur) => [...cur, ...ok].slice(0, 20))
  }

  const submit = async () => {
    if (!files.length) return toast.error('Choose at least one file')
    setBusy(true)
    let done = 0
    for (const file of files) {
      try {
        await uploadDocument({
          file,
          projectId: f.project_id || null,
          title: files.length === 1 && f.title.trim() ? f.title.trim() : file.name.replace(/\.[^.]+$/, ''),
          category: f.category,
          description: f.description || null,
          accessLevel: f.access_level as Doc['access_level'],
          tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
        })
        done++
      } catch (e) {
        toast.error(`${file.name}: ${errorMessage(e)}`)
      }
    }
    setBusy(false)
    if (done) {
      toast.success(`Uploaded ${done} file(s)`)
      await invalidate('documents')
      setFiles([])
      onOpenChange(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Upload documents"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            <Upload /> Upload {files.length > 0 && `(${files.length})`}
          </Button>
        </>
      }
    >
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          pick(e.dataTransfer.files)
        }}
        onClick={() => input.current?.click()}
        className={cn('flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors', drag ? 'border-accent bg-accent-soft' : 'border-border-strong hover:border-accent')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      >
        <UploadCloud className="mb-2 size-8 text-accent-ink" />
        <p className="font-medium">Drop files here or click to browse</p>
        <p className="mt-1 text-xs text-muted">PDF, images, Word, Excel, PowerPoint, CSV, ZIP, DWG/DXF · max 50 MB each</p>
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => pick(e.target.files)} />
      </div>
      {files.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border text-sm">
          {files.map((file, i) => (
            <li key={i} className="flex items-center gap-2 px-3 py-2">
              <FileIcon mime={file.type} name={file.name} />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="text-xs text-muted">{fmtSize(file.size)}</span>
              <button className="text-subtle hover:text-danger" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${file.name}`}>
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {!projectId && (
          <Field label="Project">
            <Select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
              <option value="">General / company-wide</option>
              {projects.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Category" required>
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {DOC_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        {files.length <= 1 && (
          <Field label="Title" hint="Defaults to the file name">
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </Field>
        )}
        <Field label="Access" hint="Who can open these files">
          <Select value={f.access_level} onChange={(e) => setF({ ...f, access_level: e.target.value })}>
            <option value="project">Project team</option>
            <option value="management">Management only</option>
            {can(P.documentsRestricted) && <option value="restricted">Restricted (confidential)</option>}
          </Select>
        </Field>
        <Field label="Tags" hint="Comma separated">
          <Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="e.g. structural, rev B" />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  )
}

function VersionsDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const { can } = useAuth()
  const invalidate = useInvalidate()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const q = useQuery({
    queryKey: ['document_versions', doc.id],
    queryFn: async () =>
      unwrap(await db.from('document_versions').select('*, uploader:profiles!document_versions_uploaded_by_fkey(full_name)').eq('document_id', doc.id).order('version', { ascending: false })) as any[],
  })
  const upload = async (file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      await uploadDocument({ file, documentId: doc.id, changeNote: note || undefined })
      toast.success('New version uploaded')
      setNote('')
      await Promise.all([q.refetch(), invalidate('documents')])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={doc.title} description="Version history">
      {can(P.documentsManage) && (
        <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface-2/50 p-3">
          <Field label="Change note" className="min-w-48 flex-1">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Revision C – updated column schedule" />
          </Field>
          <Button variant="primary" loading={busy} onClick={() => input.current?.click()}>
            <Upload /> Upload new version
          </Button>
          <input ref={input} type="file" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
        </div>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {(q.data ?? []).map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
              <Badge tone={v.version === doc.current_version ? 'accent' : 'neutral'}>v{v.version}</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{v.file_name}</p>
                <p className="text-xs text-muted">
                  {formatDateTime(v.created_at)} · {v.uploader?.full_name ?? '—'} · {fmtSize(v.size_bytes)}
                  {v.change_note && ` · ${v.change_note}`}
                </p>
              </div>
              <Button size="sm" onClick={() => downloadDocument(v.storage_path, v.file_name).catch((e) => toast.error(errorMessage(e)))}>
                <Download /> Download
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

export function DocumentsPanel({ projectId, initialSearch, initialCategory, uploadPrefill, onPrefillUsed }: { projectId?: string; initialSearch?: string; initialCategory?: string; uploadPrefill?: UploadPrefill | null; onPrefillUsed?: () => void }) {
  const { can, profile } = useAuth()
  const invalidate = useInvalidate()
  const projects = useProjectOptions(true)
  const docs = useList<Doc>('documents', {
    select: '*, project:projects(name,code), creator:profiles!documents_created_by_fkey(full_name)',
    eq: { project_id: projectId },
    order: { column: 'updated_at', ascending: false },
  })
  const [upload, setUpload] = useState(false)
  // the assistant asked for the upload form: open it once with its fields filled in
  const [prefill, setPrefill] = useState<{ n: number; v: UploadPrefill } | null>(null)
  const latest = useRef({ can, onPrefillUsed })
  useEffect(() => {
    latest.current = { can, onPrefillUsed }
  })
  useEffect(() => {
    if (!uploadPrefill || !latest.current.can(P.documentsManage)) return
    setPrefill((cur) => ({ n: (cur?.n ?? 0) + 1, v: uploadPrefill }))
    setUpload(true)
    latest.current.onPrefillUsed?.()
  }, [uploadPrefill])
  const [versions, setVersions] = useState<Doc | null>(null)
  const [del, setDel] = useState<Doc | null>(null)
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    if (!del) return
    setBusy(true)
    try {
      unwrap(await db.from('documents').delete().eq('id', del.id))
      toast.success('Document deleted')
      await invalidate('documents')
      setDel(null)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <DataTable<Doc>
        rows={docs.data}
        loading={docs.isLoading}
        error={docs.error}
        rowKey={(d) => d.id}
        isDemo={(d) => d.is_demo}
        onRowClick={(d) => d.current_path && downloadDocument(d.current_path, d.file_name ?? d.title).catch((e) => toast.error(errorMessage(e)))}
        exportTitle="Document register"
        initialSearch={initialSearch}
        initialFilters={initialCategory ? { category: initialCategory } : undefined}
        filters={[
          { key: 'category', label: 'Category', options: DOC_CATEGORIES },
          ...(projectId ? [] : [{ key: 'project_id', label: 'Project', options: [{ value: '__none', label: 'General / company' }, ...projects.options], predicate: (d: Doc, v: string) => (v === '__none' ? !d.project_id : d.project_id === v) }]),
          { key: 'access_level', label: 'Access', options: [{ value: 'project', label: 'Project team' }, { value: 'management', label: 'Management' }, { value: 'restricted', label: 'Restricted' }] },
        ]}
        columns={[
          {
            key: 'title',
            header: 'Document',
            value: (d) => `${d.title} ${d.file_name ?? ''} ${d.tags.join(' ')}`,
            cell: (d) => (
              <div className="flex min-w-0 items-start gap-2">
                <FileIcon mime={d.mime_type} name={d.file_name} />
                <div className="min-w-0">
                  <p className="truncate font-medium">{d.title}</p>
                  <p className="truncate text-xs text-subtle">
                    {d.file_name} {d.tags.length > 0 && `· ${d.tags.join(', ')}`}
                  </p>
                </div>
              </div>
            ),
          },
          { key: 'category', header: 'Category', value: (d) => DOC_CATEGORIES.find((c) => c.value === d.category)?.label ?? humanize(d.category) },
          ...(projectId ? [] : [{ key: 'project', header: 'Project', value: (d: Doc) => d.project?.name ?? 'General', hideOnMobile: true }]),
          { key: 'current_version', header: 'Ver.', format: 'number', cell: (d) => <Badge>v{d.current_version}</Badge> },
          { key: 'size_bytes', header: 'Size', format: 'number', cell: (d) => fmtSize(d.size_bytes), hideOnMobile: true },
          { key: 'access_level', header: 'Access', cell: (d) => (d.access_level === 'project' ? <span className="text-xs text-muted">Project team</span> : <Badge tone={d.access_level === 'restricted' ? 'danger' : 'warning'}><Lock className="size-3" />{humanize(d.access_level)}</Badge>) },
          { key: 'updated_at', header: 'Updated', format: 'date', hideOnMobile: true },
          { key: 'creator', header: 'Uploaded by', value: (d) => d.creator?.full_name ?? null, hideOnMobile: true },
        ]}
        rowActions={(d) => (
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Document actions">
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem disabled={!d.current_path} onSelect={() => downloadDocument(d.current_path!, d.file_name ?? d.title).catch((e) => toast.error(errorMessage(e)))}>
                <Download /> Download latest
              </MenuItem>
              <MenuItem onSelect={() => setVersions(d)}>
                <History /> Versions ({d.current_version})
              </MenuItem>
              {can(P.documentsManage) && (d.created_by === profile?.id || can(P.documentsRestricted)) && (
                <>
                  <MenuSeparator />
                  <MenuItem danger onSelect={() => setDel(d)}>
                    <Trash2 /> Delete
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        )}
        emptyTitle="No documents yet"
        emptyDescription="Upload contracts, drawings, permits, invoices and photos — each upload keeps its full version history."
        toolbar={
          can(P.documentsManage) && (
            <Button size="sm" variant="primary" onClick={() => setUpload(true)}>
              <Upload /> Upload
            </Button>
          )
        }
      />
      <UploadDialog key={prefill?.n ?? 0} open={upload} onOpenChange={setUpload} projectId={projectId} prefill={prefill?.v} />
      {versions && <VersionsDialog doc={versions} onClose={() => setVersions(null)} />}
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Delete document?"
        message={`“${del?.title}” and its version history records will be removed from the register. Stored files remain in backup storage for recovery.`}
        confirmLabel="Delete"
        danger
        loading={busy}
        onConfirm={remove}
      />
    </Card>
  )
}

export default function DocumentsPage() {
  const [params, setParams] = useSearchParams()
  const uploading = params.get('upload') === '1'
  const prefillKey = uploading ? params.toString() : ''
  const uploadPrefill = useMemo<UploadPrefill | null>(() => {
    if (!prefillKey) return null
    const p = new URLSearchParams(prefillKey)
    const v = (k: string) => p.get(k) ?? undefined
    return { title: v('title'), category: v('category'), project_id: v('project'), description: v('description'), tags: v('tags') }
  }, [prefillKey])
  // the form is open: drop the parameters so a reload does not open it again
  const clearUploadParams = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams])
  return (
    <div>
      <PageHeader title="Documents" description="Central repository: contracts, drawings, BOQs, invoices, receipts, site reports, permits, technical documents and photographs." />
      <DocumentsPanel
        initialSearch={params.get('q') ?? undefined}
        initialCategory={uploading ? undefined : (params.get('category') ?? undefined)}
        uploadPrefill={uploadPrefill}
        onPrefillUsed={clearUploadParams}
      />
    </div>
  )
}
