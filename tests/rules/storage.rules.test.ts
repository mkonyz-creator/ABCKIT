/* storage.rules against the Storage + Firestore emulators (cross-service reads). */
import { initializeApp } from 'firebase/app'
import { connectStorageEmulator, deleteObject, getBytes, getMetadata, getStorage, listAll, ref, uploadBytes, type FirebaseStorage } from 'firebase/storage'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedDocuments } from '@/backend/session'

const PROJECT = 'demo-abckit'
const BASE = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`
function enc(v: unknown): any {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (typeof v === 'string') return { stringValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } }
  return { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, enc(x)])) } }
}
async function adminPut(coll: string, id: string, row: Record<string, unknown>) {
  const r = await fetch(`${BASE}/${coll}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: enc(row).mapValue.fields }),
  })
  if (!r.ok) throw new Error(`${coll}/${id}: ${await r.text()}`)
}
const roles: Record<string, string> = {
  admin: 'super_admin', md: 'managing_director', pm: 'project_manager', eng: 'site_engineer', eng2: 'site_engineer', emp: 'employee', off: 'site_engineer',
}
const st: Record<string, FirebaseStorage> = {}
const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const img = (type = 'image/jpeg') => new Blob([new Uint8Array([1, 2, 3, 4])], { type })
async function denied(p: Promise<unknown>) {
  try {
    await p
  } catch (e: any) {
    expect(String(e?.code)).toMatch(/unauthorized/)
    return
  }
  throw new Error('expected storage/unauthorized')
}

beforeAll(async () => {
  const now = new Date().toISOString()
  const perms: Record<string, string[]> = {}
  for (const [t, id, row] of seedDocuments(now))
    if (t === 'roles') {
      await adminPut(t, id, row)
      perms[row.id] = row.perms
    }
  for (const [u, role] of Object.entries(roles)) await adminPut('profiles', u, { id: u, role_id: role, is_active: u !== 'off' })
  for (const u of ['pm', 'eng', 'emp', 'off'])
    await adminPut('project_members', `${P1}__${u}`, { project_id: P1, user_id: u, member_role: 'member', role_id: roles[u], perms: perms[roles[u]] })
  // stale copy: the member doc says project_manager but the live profile says site_engineer
  await adminPut('project_members', `${P1}__eng2`, { project_id: P1, user_id: 'eng2', member_role: 'member', role_id: 'project_manager', perms: perms.project_manager })
  for (const u of [...Object.keys(roles), 'anon']) {
    const app = initializeApp({ projectId: PROJECT, apiKey: 'fake', storageBucket: `${PROJECT}.appspot.com` }, 's-' + u)
    const s = getStorage(app)
    connectStorageEmulator(s, '127.0.0.1', 9199, u === 'anon' ? undefined : { mockUserToken: { sub: u, user_id: u } as any })
    st[u] = s
  }
})

describe('storage.rules (emulator)', () => {
  it('site photos: members with site.report upload to their projects only', async () => {
    await uploadBytes(ref(st.eng, `site-photos/${P1}/r1/a.jpg`), img())
    await uploadBytes(ref(st.eng, `site-photos/${P1}/r1/a.jpg`), img()) // offline retry overwrites
    await denied(uploadBytes(ref(st.eng, `site-photos/${P2}/r1/a.jpg`), img()))
    await denied(uploadBytes(ref(st.eng, `site-photos/not-a-uuid/r1/a.jpg`), img()))
    await denied(uploadBytes(ref(st.eng, `site-photos/${P1}/r1/a.pdf`), img('application/pdf')))
    await denied(uploadBytes(ref(st.emp, `site-photos/${P1}/r1/b.jpg`), img())) // employee: no site.report
    await denied(uploadBytes(ref(st.md, `site-photos/${P1}/r1/b.jpg`), img())) // MD: no site.report
    await denied(uploadBytes(ref(st.off, `site-photos/${P1}/r1/b.jpg`), img())) // deactivated
    await denied(uploadBytes(ref(st.eng2, `site-photos/${P1}/r1/b.jpg`), img())) // stale member copy
    expect((await getBytes(ref(st.md, `site-photos/${P1}/r1/a.jpg`))).byteLength).toBe(4) // company-wide
    expect((await getBytes(ref(st.pm, `site-photos/${P1}/r1/a.jpg`))).byteLength).toBe(4)
    await denied(getBytes(ref(st.emp, `site-photos/${P1}/r1/a.jpg`))) // no site.view
    await denied(getBytes(ref(st.anon, `site-photos/${P1}/r1/a.jpg`)))
  })

  it('project photos: list / read / upload / delete', async () => {
    await uploadBytes(ref(st.pm, `project-photos/${P1}/1-a.jpg`), img())
    await uploadBytes(ref(st.eng, `project-photos/${P1}/2-b.png`), img('image/png'))
    await denied(uploadBytes(ref(st.emp, `project-photos/${P1}/3.jpg`), img()))
    expect((await listAll(ref(st.emp, `project-photos/${P1}`))).items).toHaveLength(2) // member with projects.view
    expect((await getMetadata(ref(st.md, `project-photos/${P1}/1-a.jpg`))).size).toBe(4)
    await denied(listAll(ref(st.eng, `project-photos/${P2}`)))
    await denied(deleteObject(ref(st.eng, `project-photos/${P1}/2-b.png`)))
    await denied(uploadBytes(ref(st.pm, `project-photos/${P1}/1-a.jpg`), img()))
    await deleteObject(ref(st.pm, `project-photos/${P1}/2-b.png`))
  })

  it('documents: project folder and general folder', async () => {
    await uploadBytes(ref(st.eng, `documents/${P1}/d1/1-a.pdf`), img('application/pdf'))
    await denied(uploadBytes(ref(st.eng, `documents/${P1}/d1/1-a.exe`), img('application/x-msdownload')))
    await denied(uploadBytes(ref(st.eng, `documents/${P2}/d1/1-a.pdf`), img('application/pdf')))
    await denied(uploadBytes(ref(st.emp, `documents/${P1}/d1/2.pdf`), img('application/pdf'))) // no documents.manage
    await uploadBytes(ref(st.eng, `documents/general/d2/1-p.pdf`), img('application/pdf'))
    expect((await getBytes(ref(st.emp, `documents/general/d2/1-p.pdf`))).byteLength).toBe(4)
    expect((await getBytes(ref(st.emp, `documents/${P1}/d1/1-a.pdf`))).byteLength).toBe(4)
    await denied(getBytes(ref(st.eng2, `documents/${P2}/d1/1-a.pdf`)))
    await denied(uploadBytes(ref(st.eng, `documents/${P1}/d1/1-a.pdf`), img('application/pdf'))) // immutable
    await denied(deleteObject(ref(st.admin, `documents/${P1}/d1/1-a.pdf`)))
  })

  it('branding: public read, settings.manage writes', async () => {
    await uploadBytes(ref(st.admin, `branding/logo-1.png`), img('image/png'))
    await denied(uploadBytes(ref(st.md, `branding/logo-2.png`), img('image/png')))
    expect((await getBytes(ref(st.anon, `branding/logo-1.png`))).byteLength).toBe(4)
    await denied(uploadBytes(ref(st.admin, `other/x.png`), img('image/png')))
  })
})
