/* End-to-end: real engine + projects hooks + FirestoreStore against the emulator with the real rules. */
import { initializeApp } from 'firebase/app'
import { connectFirestoreEmulator, deleteDoc, doc, getFirestore, setDoc, updateDoc, type Firestore } from 'firebase/firestore'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@/backend/client'
import { FirestoreStore } from '@/backend/firestoreStore'
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
const dec = (v: any): any =>
  'nullValue' in v ? null : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue
    : 'stringValue' in v ? v.stringValue : 'arrayValue' in v ? (v.arrayValue.values ?? []).map(dec)
    : Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, dec(x)]))
async function adminGet(coll: string, id: string): Promise<any> {
  const r = await fetch(`${BASE}/${coll}/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer owner' } })
  if (!r.ok) return null
  const j = await r.json()
  return Object.fromEntries(Object.entries(j.fields ?? {}).map(([k, x]) => [k, dec(x)]))
}
async function adminAll(coll: string): Promise<any[]> {
  const r = await fetch(`${BASE}/${coll}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } })
  const j = await r.json()
  return (j.documents ?? []).map((d: any) => Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, x]) => [k, dec(x)])))
}

const roles: Record<string, string> = {
  admin: 'super_admin', md: 'managing_director', pm: 'project_manager', eng: 'site_engineer', eng2: 'site_engineer',
  qs: 'quantity_surveyor', emp: 'employee',
}
const fsOf: Record<string, Firestore> = {}
const dbOf: Record<string, ReturnType<typeof createDb>> = {}

function ok<T>(res: { data: T; error: any }): T {
  if (res.error) throw new Error(`${res.error.code}: ${res.error.message}`)
  return res.data
}
async function denied(p: Promise<unknown>) {
  try {
    await p
  } catch (e: any) {
    expect(String(e?.code ?? e?.message)).toMatch(/permission-denied|PERMISSION_DENIED/)
    return
  }
  throw new Error('expected permission-denied')
}
const fresh = () => Object.values(dbOf).forEach((d) => d.invalidateMe())

beforeAll(async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  const now = new Date().toISOString()
  for (const [t, id, row] of seedDocuments(now)) await adminPut(t, id, row)
  await adminPut('meta', 'bootstrap', { owner: 'admin', at: now })
  for (const [u, role] of Object.entries(roles)) {
    await adminPut('profiles', u, { id: u, full_name: u, email: `${u}@t.local`, role_id: role, is_active: true, created_at: now, updated_at: now })
    const app = initializeApp({ projectId: PROJECT, apiKey: 'fake' }, u)
    const fs = getFirestore(app)
    connectFirestoreEmulator(fs, '127.0.0.1', 8080, { mockUserToken: { sub: u, user_id: u, auth_time: Math.floor(Date.now() / 1000) } as any })
    fsOf[u] = fs
    dbOf[u] = createDb({ store: new FirestoreStore(fs), currentUser: () => ({ uid: u, email: `${u}@t.local` }) })
  }
})

let P1 = '', P2 = '', P3 = '', BOQ = '', SEC = '', ITEM = '', DOC = ''

describe('projects domain rules (emulator)', () => {
  it('clients + projects + membership (PM auto-member, denormalised perms)', async () => {
    const c = ok(await dbOf.pm.from('clients').insert({ name: 'Ministry of Works' }).select().single())
    const p = ok(await dbOf.pm.from('projects').insert({ name: 'Office Block A', client_id: c.id, project_manager_id: 'pm', status: 'active' }).select().single())
    P1 = p.id
    expect(p.code).toMatch(/^PRJ-/)
    expect((await adminGet('project_members', `${P1}__pm`))?.perms).toContain('boq.manage')
    P2 = ok(await dbOf.admin.from('projects').insert({ name: 'Warehouse B', status: 'active' }).select().single()).id
    P3 = ok(await dbOf.admin.from('projects').insert({ name: 'Road C', status: 'active', project_manager_id: 'pm' }).select().single()).id
    fresh()
    ok(await dbOf.pm.from('project_members').insert({ project_id: P1, user_id: 'eng', member_role: 'site_engineer' }))
    fresh()
    expect(ok(await dbOf.eng.from('projects').select('id')).map((r) => r.id)).toEqual([P1])
    expect(ok(await dbOf.eng2.from('projects').select('id'))).toHaveLength(0)
    expect(ok(await dbOf.md.from('projects').select('id'))).toHaveLength(3)
    expect(ok(await dbOf.pm.from('projects').select('id')).map((r) => r.id).sort()).toEqual([P1, P3].sort())
    expect(ok(await dbOf.pm.from('project_members').select('user_id').eq('project_id', P1))).toHaveLength(2)
    expect(ok(await dbOf.eng.from('projects').select('id, client:clients(name)').eq('id', P1).single()).client.name).toBe('Ministry of Works')
    // forged denormalised perms / non-members
    await denied(setDoc(doc(fsOf.pm, 'project_members', `${P1}__eng2`), { project_id: P1, user_id: 'eng2', member_role: 'member', added_at: 'x', role_id: 'site_engineer', perms: ['boq.approve'] }))
    await denied(setDoc(doc(fsOf.eng, 'project_members', `${P1}__eng2`), { project_id: P1, user_id: 'eng2', member_role: 'member', added_at: 'x', role_id: 'site_engineer', perms: (await adminGet('roles', 'site_engineer')).perms }))
    expect((await dbOf.emp.from('projects').insert({ name: 'Nope' })).error).toBeTruthy()
    await denied(updateDoc(doc(fsOf.pm, 'projects', P2), { name: 'Hijack' }))
    await denied(deleteDoc(doc(fsOf.pm, 'projects', P1)))
  })

  it('role change re-syncs memberships under the rules', async () => {
    ok(await dbOf.admin.from('profiles').update({ role_id: 'quantity_surveyor' }).eq('id', 'eng'))
    expect((await adminGet('project_members', `${P1}__eng`)).role_id).toBe('quantity_surveyor')
    ok(await dbOf.admin.from('profiles').update({ role_id: 'site_engineer' }).eq('id', 'eng'))
    ok(await dbOf.admin.from('role_permissions').insert({ role_id: 'site_engineer', permission_id: 'reports.view' }))
    expect((await adminGet('project_members', `${P1}__eng`)).perms).toContain('reports.view')
    fresh()
  })

  it('BOQ: amounts, totals, approval, lock, revision, delete', async () => {
    const b = ok(await dbOf.pm.from('boqs').insert({ project_id: P1, title: 'Tender BOQ' }).select().single())
    BOQ = b.id
    SEC = ok(await dbOf.pm.from('boq_sections').insert({ boq_id: BOQ, code: 'A', title: 'Substructure', sort_order: 1 }).select().single()).id
    ITEM = ok(await dbOf.pm.from('boq_items').insert({ section_id: SEC, description: 'Excavation', unit: 'm3', quantity: 120.5, rate: 8500 }).select().single()).id
    ok(await dbOf.pm.from('boq_items').insert({ section_id: SEC, description: 'Concrete', unit: 'm3', quantity: 45, rate: 320000 }))
    ok(await dbOf.pm.from('boq_items').update({ quantity: 2.5, rate: 10.005 }).eq('id', ITEM))
    expect((await adminGet('boq_items', ITEM)).amount).toBe(25.01)
    const [t] = ok(await dbOf.eng.from('boq_totals').select('*').eq('boq_id', BOQ))
    expect(t.item_count).toBe(2)
    expect(ok(await dbOf.eng2.from('boq_items').select('id'))).toHaveLength(0)
    expect(ok(await dbOf.md.from('boq_items').select('id'))).toHaveLength(2)
    // raw writes bypassing hooks
    await denied(updateDoc(doc(fsOf.pm, 'boq_items', ITEM), { amount: 1 }))
    await denied(updateDoc(doc(fsOf.pm, 'boqs', BOQ), { status: 'approved', approved_by: 'pm', approved_at: new Date().toISOString() }))
    await denied(updateDoc(doc(fsOf.eng, 'boq_items', ITEM), { quantity: 1, amount: 10.01 }))
    expect((await dbOf.pm.from('boqs').update({ status: 'approved' }).eq('id', BOQ)).error?.message).toMatch(/Not authorised/)
    ok(await dbOf.md.from('boqs').update({ status: 'approved' }).eq('id', BOQ))
    expect((await adminGet('boqs', BOQ)).approved_by).toBe('md')
    await denied(updateDoc(doc(fsOf.pm, 'boq_items', ITEM), { quantity: 3, amount: 30.02 }))
    await denied(updateDoc(doc(fsOf.pm, 'boqs', BOQ), { status: 'draft' }))
    await denied(deleteDoc(doc(fsOf.pm, 'boq_sections', SEC)))
    const copy = ok(await dbOf.pm.rpc('duplicate_boq', { p_boq: BOQ })) as string
    expect((await adminAll('boq_items')).filter((i) => i.boq_id === copy)).toHaveLength(2)
    ok(await dbOf.md.from('boqs').update({ status: 'superseded' }).eq('id', BOQ))
    ok(await dbOf.pm.from('boqs').delete().eq('id', BOQ))
    expect((await adminAll('boq_items')).filter((i) => i.boq_id === BOQ)).toHaveLength(0)
  })

  it('approved BOQ deletes cascade through the lock', async () => {
    const b = ok(await dbOf.pm.from('boqs').insert({ project_id: P1, title: 'Second BOQ' }).select().single())
    const s = ok(await dbOf.pm.from('boq_sections').insert({ boq_id: b.id, title: 'A' }).select().single())
    ok(await dbOf.pm.from('boq_items').insert({ section_id: s.id, description: 'x', quantity: 1, rate: 1 }))
    ok(await dbOf.md.from('boqs').update({ status: 'approved' }).eq('id', b.id))
    ok(await dbOf.pm.from('boqs').delete().eq('id', b.id))
    expect((await adminAll('boq_sections')).filter((i) => i.boq_id === b.id)).toHaveLength(0)
  })

  it('documents: versions, access levels, scoping', async () => {
    DOC = ok(await dbOf.eng.from('documents').insert({ project_id: P1, title: 'Drawings', category: 'drawing' }).select().single()).id
    ok(await dbOf.eng.from('document_versions').insert({ document_id: DOC, version: 0, storage_path: `${P1}/${DOC}/a.pdf`, file_name: 'a.pdf', size_bytes: 10 }))
    ok(await dbOf.eng.from('document_versions').insert({ document_id: DOC, version: 0, storage_path: `${P1}/${DOC}/b.pdf`, file_name: 'b.pdf' }))
    expect((await adminGet('documents', DOC)).current_version).toBe(2)
    ok(await dbOf.md.from('documents').insert({ project_id: P1, title: 'Contract', access_level: 'restricted' }))
    ok(await dbOf.md.from('documents').insert({ project_id: P1, title: 'Minutes', access_level: 'management' }))
    ok(await dbOf.md.from('documents').insert({ project_id: null, title: 'Policy' }))
    expect(ok(await dbOf.eng.from('documents').select('title').order('title')).map((d) => d.title)).toEqual(['Drawings', 'Policy'])
    expect(ok(await dbOf.qs.from('documents').select('title').order('title')).map((d) => d.title)).toEqual(['Drawings', 'Minutes', 'Policy'])
    expect(ok(await dbOf.md.from('documents').select('id'))).toHaveLength(4)
    expect(ok(await dbOf.emp.from('documents').select('title'))).toEqual([{ title: 'Policy' }])
    expect(ok(await dbOf.eng.from('document_versions').select('version').eq('document_id', DOC).order('version'))).toEqual([{ version: 1 }, { version: 2 }])
    const vs = await adminAll('document_versions')
    await denied(updateDoc(doc(fsOf.eng, 'document_versions', vs[0].id), { file_name: 'evil.pdf' }))
    await denied(updateDoc(doc(fsOf.eng, 'documents', DOC), { current_version: 9 }))
    ok(await dbOf.md.from('documents').update({ access_level: 'restricted' }).eq('id', DOC))
    expect(ok(await dbOf.eng.from('document_versions').select('id'))).toHaveLength(0)
    ok(await dbOf.md.from('documents').delete().eq('id', DOC))
    expect((await adminAll('document_versions')).filter((v) => v.document_id === DOC)).toHaveLength(0)
  })

  it('tasks: notifications, completion, overdue, assignee rights', async () => {
    const d = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10)
    const t = ok(await dbOf.pm.from('tasks').insert({ project_id: P1, title: 'Shop drawings', assigned_to: 'eng', due_date: d }).select().single())
    const t2 = ok(await dbOf.pm.from('tasks').insert({ project_id: P1, title: 'Order rebar', assigned_to: 'emp' }).select().single())
    expect(ok(await dbOf.eng.from('notifications').select('*').eq('type', 'task'))).toHaveLength(1)
    expect(ok(await dbOf.eng.rpc('notify_overdue_tasks'))).toBe(1)
    expect(ok(await dbOf.eng.rpc('notify_overdue_tasks'))).toBe(0)
    const done = ok(await dbOf.eng.from('tasks').update({ status: 'done' }).eq('id', t.id).select().single())
    expect(done.progress).toBe(100)
    expect(ok(await dbOf.emp.from('tasks').select('id'))).toEqual([{ id: t2.id }])
    ok(await dbOf.emp.from('tasks').update({ status: 'in_progress' }).eq('id', t2.id))
    await denied(updateDoc(doc(fsOf.emp, 'tasks', t2.id), { assigned_to: 'eng' }))
    await denied(updateDoc(doc(fsOf.eng, 'tasks', t.id), { status: 'done', progress: 50 }))
    expect(ok(await dbOf.eng2.from('tasks').select('id'))).toHaveLength(0)
    ok(await dbOf.pm.from('tasks').insert({ project_id: null, title: 'Company task' }))
    expect(ok(await dbOf.eng.from('tasks').select('id'))).toHaveLength(3)
  })

  it('big BOQ duplicate (expression / access limits per transaction)', async () => {
    const P = ok(await dbOf.admin.from('projects').insert({ name: 'Big', project_manager_id: 'pm' }).select().single()).id
    fresh()
    const b = ok(await dbOf.pm.from('boqs').insert({ project_id: P, title: 'Big BOQ' }).select().single())
    for (let s = 0; s < 3; s++) {
      const sec = ok(await dbOf.pm.from('boq_sections').insert({ boq_id: b.id, title: 'S' + s, sort_order: s }).select().single())
      ok(await dbOf.pm.from('boq_items').insert(Array.from({ length: 20 }, (_, i) => ({ section_id: sec.id, description: 'i' + i, quantity: i, rate: 3.3 }))))
    }
    const copy = ok(await dbOf.pm.rpc('duplicate_boq', { p_boq: b.id })) as string
    expect((await adminAll('boq_items')).filter((i) => i.boq_id === copy)).toHaveLength(60)
  })

  it('super admin deletes a project with everything in it', async () => {
    ok(await dbOf.admin.from('boqs').insert({ project_id: P1, title: 'Third BOQ' }))
    ok(await dbOf.admin.from('projects').delete().eq('id', P1))
    for (const c of ['boqs', 'tasks', 'documents', 'project_members']) expect((await adminAll(c)).filter((r) => r.project_id === P1), c).toHaveLength(0)
  })
})
