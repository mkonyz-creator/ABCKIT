/**
 * In-app file viewer. Opened by the AI assistant's open_document tool (window event, see src/lib/ai/uiActions.ts).
 * The file is downloaded under the signed-in user's own storage rules; PDFs and pictures are shown as they are,
 * Word / Excel / PowerPoint / CSV / text as their extracted text.
 */
import { Download, FileWarning, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { db } from '@/lib/backend'
import { extractFile, fileKind } from '@/lib/ai/fileText'
import { OPEN_FILE_EVENT, type OpenFileRequest } from '@/lib/ai/uiActions'
import { errorMessage } from '@/lib/utils'

type View = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; url: string; kind: ReturnType<typeof fileKind>; text?: string; note?: string }

export function FileViewer() {
  const [req, setReq] = useState<OpenFileRequest | null>(null)
  const [view, setView] = useState<View>({ state: 'loading' })

  useEffect(() => {
    const onOpen = (e: Event) => {
      setView({ state: 'loading' })
      setReq((e as CustomEvent<OpenFileRequest>).detail)
    }
    window.addEventListener(OPEN_FILE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_FILE_EVENT, onOpen)
  }, [])

  useEffect(() => {
    if (!req) return
    let url = ''
    let cancelled = false
    void (async () => {
      try {
        const { data, error } = await (db.storage as any).from(req.bucket).download(req.path)
        if (error || !data) throw error ?? new Error('File not found')
        const blob = data as Blob
        url = URL.createObjectURL(blob)
        const kind = fileKind(req.fileName, req.mime || blob.type)
        if (kind === 'pdf' || kind === 'image') {
          if (!cancelled) setView({ state: 'ready', url, kind })
          return
        }
        const x = await extractFile(blob, req.fileName, req.mime, 200_000)
        if (cancelled) return
        if (x.kind === 'text') setView({ state: 'ready', url, kind, text: x.text, note: x.truncated ? 'Only the beginning of this file is shown — download it to see everything.' : undefined })
        else setView({ state: 'ready', url, kind, note: x.kind === 'unsupported' ? x.reason : undefined })
      } catch (e) {
        if (!cancelled) setView({ state: 'error', message: errorMessage(e) })
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [req])

  if (!req) return null
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && setReq(null)}
      size="xl"
      title={req.title}
      description={req.fileName}
      footer={
        view.state === 'ready' ? (
          <a href={view.url} download={req.fileName} className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong px-3 text-sm font-medium hover:bg-surface-2">
            <Download className="size-4" /> Download
          </a>
        ) : (
          <Button variant="ghost" onClick={() => setReq(null)}>
            Close
          </Button>
        )
      }
    >
      {view.state === 'loading' && (
        <p className="flex items-center gap-2 py-10 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Opening the file…
        </p>
      )}
      {view.state === 'error' && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
          <FileWarning className="mt-0.5 size-4 shrink-0" /> The file could not be opened: {view.message}
        </p>
      )}
      {view.state === 'ready' && (
        <div className="space-y-2">
          {view.kind === 'pdf' && <iframe src={view.url} title={req.title} className="h-[70vh] w-full rounded-md border border-border bg-white" />}
          {view.kind === 'image' && <img src={view.url} alt={req.title} className="mx-auto max-h-[70vh] rounded-md border border-border object-contain" />}
          {view.text !== undefined && (
            <pre className="scrollbar-thin max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2/40 p-3 font-sans text-sm">{view.text || '(empty file)'}</pre>
          )}
          {view.note && <p className="text-xs text-muted">{view.note}</p>}
        </div>
      )}
    </Dialog>
  )
}
