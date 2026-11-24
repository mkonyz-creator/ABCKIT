/* End-to-end: real engine + operations hooks + FirestoreStore against the emulator with the real rules. */
import { initializeApp } from 'firebase/app'
import { connectFirestoreEmulator, doc, getFirestore, setDoc, updateDoc, deleteDoc, type Firestore } from 'firebase/firestore'
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
async function adminGet(coll: string, id: string): Promise<any> {
  const r = await fetch(`${BASE}/${coll}/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer owner' } })
  if (!r.ok) return null
  const j = await r.json()
  const dec = (v: any): any =>
    'nullValue' in v ? null : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue
      : 'stringValue' in v ? v.stringValue : 'arrayValue' in v ? (v.arrayValue.values ?? []).map(dec)
      : Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, dec(x)]))
  return Object.fromEntries(Object.entries(j.fields ?? {}).map(([k, x]) => [k, dec(x)]))
}
async function adminList(coll: string): Promise<number> {
  const r = await fetch(`${BASE}/${coll}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } })
  const j = await r.json()
  return (j.documents ?? []).length
}

const roles: Record<string, string> = {
  admin: 'super_admin', md: 'managing_director', pm: 'project_manager', eng: 'site_engineer', eng2: 'site_engineer',
  proc: 'procurement_officer', store: 'storekeeper',
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

let P1 = '', P2 = '', MAT = '', REPORT = ''

describe('operations rules (emulator)', () => {
  it('projects (stub rules) + membership', async () => {
    console.log('ADMINGET', JSON.stringify(await adminGet('numbering_sequences', 'project')), JSON.stringify(await adminGet('profiles', 'admin')))
    const { getDoc } = await import('firebase/firestore')
    try {
      console.log('SDKGET', JSON.stringify((await getDoc(doc(fsOf.admin, 'numbering_sequences', 'project'))).data()))
    } catch (e) {
      console.log('SDKERR', String(e))
    }
    P1 = ok(await dbOf.admin.from('projects').insert({ name: 'Office Block A', project_manager_id: 'pm', status: 'active' }).select().single()).id
    P2 = ok(await dbOf.admin.from('projects').insert({ name: 'Warehouse B', status: 'active' }).select().single()).id
    ok(await dbOf.admin.from('project_members').insert({ project_id: P1, user_id: 'eng', member_role: 'site_engineer' }))
    dbOf.eng.invalidateMe()
    dbOf.pm.invalidateMe()
  })

  it('site report: engineer submits, PM notified, approval rolls progress', async () => {
    const cu = crypto.randomUUID()
    const r = ok(await dbOf.eng.from('site_reports').insert({ project_id: P1, engineer_id: 'eng', work_performed: 'Blockwork', progress_percent: 35, status: 'submitted', client_uuid: cu }).select().single())
    REPORT = r.id
    expect(r.number).toMatch(/^DSR-/)
    const dup = await dbOf.eng.from('site_reports').insert({ project_id: P1, engineer_id: 'eng', work_performed: 'dup', client_uuid: cu })
    expect(dup.error?.code).toBe('23505')
    expect(ok(await dbOf.eng.from('site_reports').select('id').eq('client_uuid', cu).single()).id).toBe(cu)
    const other = await dbOf.eng.from('site_reports').insert({ project_id: P2, engineer_id: 'eng', work_performed: 'x' })
    expect(other.error).toBeTruthy()
    // bypassing hooks: engineer self-approval is rejected by rules
    await denied(updateDoc(doc(fsOf.eng, 'site_reports', REPORT), { status: 'approved', approved_by: 'eng' }))
    const photo = ok(await dbOf.eng.from('site_report_photos').insert({ report_id: REPORT, storage_path: `${P1}/${REPORT}/a.jpg` }).select().single())
    expect(photo.project_id).toBe(P1)
    expect(ok(await dbOf.eng.from('site_report_photos').select('id').eq('storage_path', `${P1}/${REPORT}/a.jpg`).maybeSingle())).toBeTruthy()
    ok(await dbOf.pm.from('site_reports').update({ status: 'approved' }).eq('id', REPORT))
    expect((await adminGet('projects', P1)).progress).toBe(35)
    const full = ok(await dbOf.pm.from('site_reports').select('*, photos:site_report_photos(id)').eq('id', REPORT).single())
    expect(full.photos).toHaveLength(1)
    expect(ok(await dbOf.eng.from('site_reports').select('id'))).toHaveLength(1)
    expect(ok(await dbOf.eng2.from('site_reports').select('id'))).toHaveLength(0)
    expect(ok(await dbOf.md.from('site_reports').select('id'))).toHaveLength(1)
    const edit = await dbOf.eng.from('site_reports').update({ work_performed: 'edited' }).eq('id', REPORT)
    expect(edit.error?.message).toMatch(/locked/)
    await denied(updateDoc(doc(fsOf.eng, 'site_reports', REPORT), { work_performed: 'edited' }))
  })

  it('inventory ledger: postings, negative override, immutability, direct edits blocked', async () => {
    MAT = ok(await dbOf.store.from('materials').insert({ name: 'Cement 50kg', unit: 'bag', unit_price: 17500, min_stock: 50 }).select().single()).id
    ok(await dbOf.store.from('inventory_transactions').insert({ material_id: MAT, txn_type: 'receipt', quantity: 100 }))
    const iss = ok(await dbOf.store.from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 30 }).select().single())
    expect(iss.balance_after).toBe(70)
    const neg = ok(await dbOf.pm.from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 100, negative_override: true }).select().single())
    expect(neg.balance_after).toBe(-30)
    expect((await adminGet('materials', MAT)).current_stock).toBe(-30)
    // raw writes that skip the hooks
    await denied(updateDoc(doc(fsOf.store, 'materials', MAT), { current_stock: 999 }))
    await denied(updateDoc(doc(fsOf.store, 'inventory_transactions', iss.id), { quantity: 1 }))
    await denied(deleteDoc(doc(fsOf.admin, 'inventory_transactions', iss.id)))
    const fake = crypto.randomUUID()
    await denied(
      setDoc(doc(fsOf.store, 'inventory_transactions', fake), {
        id: fake, material_id: MAT, project_id: null, txn_type: 'receipt', quantity: 5, balance_after: 500, grn_item_id: null,
        approved_by: null, negative_override: false, created_by: 'store', unit_price: 1,
      }),
    )
    // storekeeper cannot take stock negative even when skipping the hook
    const fake2 = crypto.randomUUID()
    await denied(
      setDoc(doc(fsOf.store, 'inventory_transactions', fake2), {
        id: fake2, material_id: MAT, project_id: null, txn_type: 'issue', quantity: 5, balance_after: -35, grn_item_id: null,
        approved_by: 'store', negative_override: true, created_by: 'store', unit_price: 1,
      }),
    )
    expect(ok(await dbOf.eng.from('inventory_transactions').select('id'))).toHaveLength(3)
    const low = await adminList('notifications')
    expect(low).toBeGreaterThan(0)
  })

  it('procurement: PR → approve → PO → approve → GRN (storekeeper) posts stock', async () => {
    const SUP = ok(await dbOf.proc.from('suppliers').insert({ name: 'Twiga' }).select().single()).id
    const pr = ok(await dbOf.eng.from('purchase_requests').insert({ project_id: P1, requested_by: 'eng', status: 'draft' }).select().single())
    ok(await dbOf.eng.from('purchase_request_items').insert({ request_id: pr.id, material_id: MAT, description: 'Cement', quantity: 200, unit: 'bag', estimated_rate: 17000 }))
    ok(await dbOf.eng.from('purchase_requests').update({ status: 'submitted' }).eq('id', pr.id))
    const mine = ok(await dbOf.eng.from('purchase_requests').select('id, items:purchase_request_items(id)'))
    expect(mine).toHaveLength(1)
    expect(mine[0].items).toHaveLength(1)
    await denied(updateDoc(doc(fsOf.proc, 'purchase_requests', pr.id), { status: 'approved', approved_by: 'proc' }))
    ok(await dbOf.md.from('purchase_requests').update({ status: 'approved' }).eq('id', pr.id))
    expect((await dbOf.eng.from('purchase_request_items').insert({ request_id: pr.id, description: 'x', quantity: 1 })).error?.code).toBe('42501')
    const fk = crypto.randomUUID()
    await denied(setDoc(doc(fsOf.eng, 'purchase_request_items', fk), { id: fk, request_id: pr.id, description: 'x', quantity: 1, unit: 'No.', estimated_rate: 0, amount: 0, material_id: null, project_id: P1, requested_by: 'eng' }))
  })

  it('procurement: PO + GRN', async () => {
    const SUP = ok(await dbOf.proc.from('suppliers').select('id').limit(1).single()).id
    const po = ok(await dbOf.proc.from('purchase_orders').insert({ supplier_id: SUP, project_id: P1 }).select().single())
    const poi = ok(await dbOf.proc.from('purchase_order_items').insert({ po_id: po.id, material_id: MAT, description: 'Cement', quantity: 200, unit: 'bag', rate: 17000 }).select().single())
    ok(await dbOf.proc.from('purchase_orders').update({ status: 'pending_approval' }).eq('id', po.id))
    await denied(updateDoc(doc(fsOf.proc, 'purchase_orders', po.id), { status: 'approved', approved_by: 'proc' }))
    ok(await dbOf.md.from('purchase_orders').update({ status: 'approved' }).eq('id', po.id))
    await denied(updateDoc(doc(fsOf.proc, 'purchase_order_items', poi.id), { quantity: 500 }))
    await denied(updateDoc(doc(fsOf.store, 'purchase_order_items', poi.id), { received_qty: 250 }))
    const totals = ok(await dbOf.proc.from('purchase_order_totals').select('*').eq('po_id', po.id).single())
    expect(totals.total).toBe(4012000)
    const g = ok(await dbOf.store.from('goods_received').insert({ po_id: po.id, supplier_id: SUP, project_id: P1 }).select().single())
    ok(await dbOf.store.from('goods_received_items').insert({ grn_id: g.id, po_item_id: poi.id, material_id: MAT, quantity_received: 120, unit_price: 17000 }))
    expect((await adminGet('purchase_orders', po.id)).status).toBe('partially_received')
    expect((await adminGet('materials', MAT)).current_stock).toBe(90)
    ok(await dbOf.proc.from('goods_received_items').insert({ grn_id: g.id, po_item_id: poi.id, material_id: MAT, quantity_received: 80, unit_price: 17000 }))
    expect((await adminGet('purchase_orders', po.id)).status).toBe('received')
    expect((await adminGet('materials', MAT)).current_stock).toBe(170)
    // a GRN line without the stock posting is rejected
    const gi = crypto.randomUUID()
    await denied(setDoc(doc(fsOf.store, 'goods_received_items', gi), { id: gi, grn_id: g.id, po_item_id: null, material_id: MAT, quantity_received: 5, quantity_rejected: 0, unit_price: 0, project_id: P1 }))
  })

  it('equipment: engineer usage log raises the meter; assignment/maintenance by PM', async () => {
    const e = ok(await dbOf.pm.from('equipment').insert({ name: 'Excavator' }).select().single())
    ok(await dbOf.pm.from('equipment_assignments').insert({ equipment_id: e.id, project_id: P1 }))
    ok(await dbOf.eng.from('equipment_usage_logs').insert({ equipment_id: e.id, project_id: P1, hours_operated: 8, meter_reading: 1200 }))
    expect((await adminGet('equipment', e.id)).meter_reading).toBe(1200)
    await denied(updateDoc(doc(fsOf.eng, 'equipment', e.id), { status: 'retired' }))
    ok(await dbOf.pm.from('maintenance_records').insert({ equipment_id: e.id, maintenance_type: 'breakdown', description: 'leak' }))
    expect((await adminGet('equipment', e.id)).status).toBe('breakdown')
  })

  it('site report: draft delete cascades photos; safety incidents', async () => {
    const r = ok(await dbOf.eng.from('site_reports').insert({ project_id: P1, engineer_id: 'eng', work_performed: 'x' }).select().single())
    ok(await dbOf.eng.from('site_report_photos').insert({ report_id: r.id, storage_path: 'p.jpg' }))
    ok(await dbOf.eng.from('safety_incidents').insert({ project_id: P1, report_id: r.id, description: 'slip' }))
    ok(await dbOf.eng.from('site_reports').delete().eq('id', r.id))
    expect(ok(await dbOf.eng.from('safety_incidents').select('report_id'))[0].report_id).toBeNull()
  })
})

describe('supplier invoices', () => {
  it('finance.approve holders may only move the payment status', async () => {
    const SUP = ok(await dbOf.proc.from('suppliers').select('id').limit(1).single()).id
    const inv = ok(await dbOf.proc.from('supplier_invoices').insert({ supplier_id: SUP, invoice_no: 'X-1', amount: 100 }).select().single())
    ok(await dbOf.md.from('supplier_invoices').update({ status: 'paid' }).eq('id', inv.id))
    expect((await adminGet('supplier_invoices', inv.id)).status).toBe('paid')
    await denied(updateDoc(doc(fsOf.md, 'supplier_invoices', inv.id), { amount: 1 }))
    await denied(updateDoc(doc(fsOf.md, 'supplier_invoices', inv.id), { status: 'void' }))
  })
})
