import { db, unwrap } from './backend'
import { safeFileName } from './utils'

export const DOC_CATEGORIES = [
  { value: 'contract', label: 'Contracts' },
  { value: 'drawing', label: 'Drawings' },
  { value: 'boq', label: 'BOQs' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'receipt', label: 'Receipts' },
  { value: 'site_report', label: 'Site reports' },
  { value: 'permit', label: 'Permits' },
  { value: 'technical', label: 'Technical documents' },
  { value: 'photo', label: 'Project photographs' },
  { value: 'correspondence', label: 'Correspondence' },
  { value: 'other', label: 'Other' },
]

const MAX_BYTES = 50 * 1024 * 1024
const ALLOWED_EXT = /\.(pdf|jpe?g|png|webp|gif|heic|docx?|xlsx?|pptx?|txt|csv|zip|dwg|dxf)$/i
const BLOCKED_EXT = /\.(exe|bat|cmd|com|msi|scr|js|vbs|ps1|sh|jar|apk|html?|svg)$/i

/** Client-side validation — storage bucket limits & MIME allow-list enforce the same server-side. */
export function validateUpload(file: File): string | null {
  if (file.size === 0) return 'The file is empty'
  if (file.size > MAX_BYTES) return 'Files must be 50 MB or smaller'
  if (BLOCKED_EXT.test(file.name)) return 'This file type is not allowed'
  if (!ALLOWED_EXT.test(file.name)) return 'Unsupported file type. Allowed: PDF, images, Office documents, CSV, ZIP, DWG/DXF'
  return null
}

function contentType(file: File) {
  if (file.type) return file.type
  if (/\.dwg$/i.test(file.name)) return 'image/vnd.dwg'
  if (/\.dxf$/i.test(file.name)) return 'image/vnd.dxf'
  return 'application/octet-stream'
}

/** Upload a new version of a document (creates the document first if no id is given). */
export async function uploadDocument(opts: {
  file: File
  documentId?: string
  projectId?: string | null
  title?: string
  category?: string
  description?: string | null
  accessLevel?: 'project' | 'management' | 'restricted'
  tags?: string[]
  changeNote?: string
}) {
  const err = validateUpload(opts.file)
  if (err) throw new Error(err)
  let docId = opts.documentId
  let projectId = opts.projectId ?? null
  if (!docId) {
    const d = unwrap(
      await db
        .from('documents')
        .insert({
          project_id: projectId,
          title: opts.title || opts.file.name,
          category: opts.category ?? 'other',
          description: opts.description ?? null,
          access_level: opts.accessLevel ?? 'project',
          tags: opts.tags ?? [],
        })
        .select('id,project_id')
        .single(),
    ) as { id: string; project_id: string | null }
    docId = d.id
  } else if (opts.projectId === undefined) {
    const d = unwrap(await db.from('documents').select('project_id').eq('id', docId).single()) as { project_id: string | null }
    projectId = d.project_id
  }
  const path = `${projectId ?? 'general'}/${docId}/${Date.now()}-${safeFileName(opts.file.name)}`
  const up = await db.storage.from('documents').upload(path, opts.file, { contentType: contentType(opts.file), upsert: false })
  if (up.error) {
    if (!opts.documentId) await db.from('documents').delete().eq('id', docId)
    throw up.error
  }
  unwrap(
    await db.from('document_versions').insert({
      document_id: docId,
      version: 0, // assigned by trigger
      storage_path: path,
      file_name: opts.file.name,
      mime_type: contentType(opts.file),
      size_bytes: opts.file.size,
      change_note: opts.changeNote ?? null,
    }),
  )
  return { documentId: docId, path }
}

export async function downloadDocument(path: string, fileName: string) {
  const { data, error } = await db.storage.from('documents').createSignedUrl(path, 120, { download: fileName })
  if (error) throw error
  window.open(data.signedUrl, '_blank', 'noopener')
}
