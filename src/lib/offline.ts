/**
 * Offline drafting & background synchronisation for daily site reports.
 *
 * - Drafts (including photos as Blobs) are stored in IndexedDB.
 * - Each draft carries a client_uuid used as an idempotency key, so a report that
 *   was inserted but whose response was lost is never duplicated on retry.
 * - Edits to a report that already exists on the server record the server's
 *   updated_at when editing started; if the server copy changed in the meantime
 *   the draft is flagged as a conflict and the user chooses which copy wins.
 */
import { createStore, del, entries, get, set } from 'idb-keyval'
import { useSyncExternalStore } from 'react'
import { db } from './backend'
import { errorMessage } from './utils'

const store = createStore('abckit-offline', 'drafts')

export interface DraftPhoto {
  id: string
  blob: Blob
  name: string
  caption?: string
  uploaded?: boolean
}

export interface ReportDraft {
  key: string // = client_uuid
  serverId?: string
  baseUpdatedAt?: string
  data: Record<string, any>
  photos: DraftPhoto[]
  submit: boolean
  state: 'pending' | 'syncing' | 'conflict' | 'error' | 'local'
  error?: string
  savedAt: number
}

// ------------------------------------------------------------------ tiny store
let snapshot: ReportDraft[] = []
let syncing = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

async function reload() {
  const all = await entries<string, ReportDraft>(store)
  snapshot = all.map(([, v]) => v).sort((a, b) => b.savedAt - a.savedAt)
  emit()
}

export function useDrafts() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot,
  )
}

export function pendingCount(drafts: ReportDraft[]) {
  return drafts.filter((d) => d.state !== 'local').length
}

export async function getDraft(key: string) {
  return get<ReportDraft>(key, store)
}

/** state 'local' = saved on device only (not queued); anything else is queued for sync */
export async function saveDraft(d: Omit<ReportDraft, 'savedAt'>) {
  await set(d.key, { ...d, savedAt: Date.now() }, store)
  await reload()
  if (d.state === 'pending' && navigator.onLine) void syncAll()
}

export async function deleteDraft(key: string) {
  await del(key, store)
  await reload()
}

// ------------------------------------------------------------------ sync
async function update(key: string, patch: Partial<ReportDraft>) {
  const d = await get<ReportDraft>(key, store)
  if (!d) return
  await set(key, { ...d, ...patch }, store)
}

async function uploadPhotos(d: ReportDraft, reportId: string, projectId: string) {
  for (const p of d.photos) {
    if (p.uploaded) continue
    const path = `${projectId}/${reportId}/${p.id}.jpg`
    // photo row: ignore duplicates so retries are idempotent. Checked before uploading: the photo row is
    // only written after a successful upload, and Firebase Storage rules may refuse overwriting an object.
    const exists = await db.from('site_report_photos').select('id').eq('storage_path', path).maybeSingle()
    if (exists.error) throw exists.error
    if (!exists.data) {
      const up = await db.storage.from('site-photos').upload(path, p.blob, { contentType: p.blob.type || 'image/jpeg', upsert: false })
      if (up.error && !/exists|Duplicate/i.test(up.error.message)) throw up.error
      const ins = await db.from('site_report_photos').insert({ report_id: reportId, storage_path: path, caption: p.caption ?? null })
      if (ins.error) throw ins.error
    }
    p.uploaded = true
    await update(d.key, { photos: d.photos })
  }
}

async function syncOne(d: ReportDraft): Promise<void> {
  await update(d.key, { state: 'syncing', error: undefined })
  const payload = { ...d.data, status: d.submit ? 'submitted' : 'draft' }
  delete (payload as any).id
  try {
    let reportId = d.serverId
    if (reportId) {
      const cur = await db.from('site_reports').select('updated_at,status').eq('id', reportId).single()
      if (cur.error) throw cur.error
      if (d.baseUpdatedAt && cur.data.updated_at !== d.baseUpdatedAt) {
        await update(d.key, { state: 'conflict', error: 'This report was changed on the server after you started editing offline.' })
        return
      }
      if (cur.data.status === 'approved') {
        await update(d.key, { state: 'conflict', error: 'The report has been approved on the server and is locked.' })
        return
      }
      const res = await db.from('site_reports').update(payload).eq('id', reportId).select('id').single()
      if (res.error) throw res.error
    } else {
      const res = await db.from('site_reports').insert({ ...payload, client_uuid: d.key }).select('id').single()
      if (res.error) {
        if (res.error.code === '23505') {
          // already inserted by an earlier attempt whose response was lost
          const existing = await db.from('site_reports').select('id').eq('client_uuid', d.key).single()
          if (existing.error) throw existing.error
          reportId = existing.data.id
        } else throw res.error
      } else reportId = res.data.id
      await update(d.key, { serverId: reportId })
    }
    await uploadPhotos({ ...d, serverId: reportId }, reportId!, d.data.project_id)
    await del(d.key, store)
  } catch (e) {
    // Firestore reports a lost connection as code 'unavailable' / "client is offline" (not a fetch error)
    const code = (e as { code?: string })?.code
    const offline =
      !navigator.onLine ||
      code === 'unavailable' ||
      code === 'deadline-exceeded' ||
      /Failed to fetch|NetworkError|Load failed|client is offline|unavailable/i.test(errorMessage(e))
    await update(d.key, { state: offline ? 'pending' : 'error', error: errorMessage(e) })
  }
}

export async function syncAll(): Promise<{ synced: number; failed: number }> {
  if (syncing || !navigator.onLine) return { synced: 0, failed: 0 }
  const { data } = await db.auth.getSession()
  if (!data.session) return { synced: 0, failed: 0 }
  syncing = true
  let synced = 0
  let failed = 0
  try {
    const all = (await entries<string, ReportDraft>(store)).map(([, v]) => v)
    for (const d of all.filter((x) => x.state === 'pending' || x.state === 'error' || x.state === 'syncing')) {
      await syncOne(d)
      const after = await get<ReportDraft>(d.key, store)
      if (!after) synced++
      else if (after.state !== 'pending') failed++
    }
  } finally {
    syncing = false
    await reload()
  }
  return { synced, failed }
}

/** keep_mine: overwrite the server copy; keep_server: discard the local draft */
export async function resolveConflict(key: string, choice: 'keep_mine' | 'keep_server') {
  const d = await get<ReportDraft>(key, store)
  if (!d) return
  if (choice === 'keep_server') {
    await deleteDraft(key)
    return
  }
  const cur = d.serverId ? await db.from('site_reports').select('updated_at').eq('id', d.serverId).single() : null
  await set(key, { ...d, baseUpdatedAt: cur?.data?.updated_at ?? undefined, state: 'pending', error: undefined }, store)
  await reload()
  await syncAll()
}

export function initOfflineSync() {
  void reload().then(() => syncAll())
  window.addEventListener('online', () => void syncAll())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncAll()
  })
  setInterval(() => void syncAll(), 2 * 60_000)
}

// ------------------------------------------------------------------ images
/** Resize + re-encode camera photos (typically 4–8 MB) to ≈200–500 KB JPEGs. */
export async function compressImage(file: File, maxDim = 1600, quality = 0.8): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be attached as site photos')
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/jpeg', quality),
    )
  } catch {
    if (file.size > 10 * 1024 * 1024) throw new Error('Image is larger than 10 MB')
    return file
  }
}
