/**
 * Operations domain — the scenarios of legacy-supabase/tests/db/run.mjs (site reports, inventory,
 * procurement) plus equipment, on the in-memory store with the real engine + hooks.
 * Security rules are not evaluated here (see firebase/rules/30_operations.rules).
 */
import { describe, expect, it } from 'vitest'
import { createTestDb, ok } from '../testing'

function setup() {
  const t = createTestDb()
  const U = {
    admin: t.addUser('super_admin'),
    md: t.addUser('managing_director'),
    pm: t.addUser('project_manager'),
    eng: t.addUser('site_engineer'),
    eng2: t.addUser('site_engineer'),
    proc: t.addUser('procurement_officer'),
    store: t.addUser('storekeeper'),
    acc: t.addUser('accountant'),
  }
  return { t, U }
}

async function withProjects() {
  const s = setup()
  const { t, U } = s
  const db = t.as(U.admin)
  const P1 = ok(await db.from('projects').insert({ name: 'Office Block A', project_manager_id: U.pm, status: 'active' }).select().single()).id as string
  const P2 = ok(await db.from('projects').insert({ name: 'Warehouse B', status: 'active' }).select().single()).id as string
  ok(await db.from('project_members').insert({ project_id: P1, user_id: U.eng, member_role: 'site_engineer' }))
  return { ...s, P1, P2 }
}

const notes = (t: ReturnType<typeof createTestDb>, user: string) => t.raw.all('notifications').filter((n) => n.user_id === user)

// ============================================================================ site reports

describe('site reports', () => {
  it('engineer submits; number assigned; PM notified; engineer cannot self-approve', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.eng)
    const r = ok(
      await db
        .from('site_reports')
        .insert({ project_id: P1, engineer_id: U.eng, work_performed: 'Blockwork level 2', workers_count: 24, progress_percent: 35, status: 'submitted', client_uuid: crypto.randomUUID() })
        .select()
        .single(),
    )
    expect(r.number).toMatch(/^DSR-/)
    expect(r.submitted_at).toBeTruthy()
    expect(r.id).toBe(r.client_uuid)
    const pmNotes = notes(t, U.pm).filter((n) => n.type === 'approval')
    expect(pmNotes).toHaveLength(1)
    expect(pmNotes[0].link).toBe(`/site-reports/${r.id}`)
    const self = await db.from('site_reports').update({ status: 'approved' }).eq('id', r.id)
    expect(self.error?.message).toMatch(/Not authorised to approve/)
    expect(t.raw.all('audit_logs').some((a) => a.table_name === 'site_reports' && a.record_id === r.id)).toBe(true)
  })

  it('engineer cannot report on a project they are not assigned to, or as someone else', async () => {
    const { t, U, P1, P2 } = await withProjects()
    const db = t.as(U.eng)
    const other = await db.from('site_reports').insert({ project_id: P2, engineer_id: U.eng, work_performed: 'x' })
    expect(other.error?.code).toBe('42501')
    const spoof = await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng2, work_performed: 'x' })
    expect(spoof.error?.code).toBe('42501')
    const approved = await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng, status: 'approved' })
    expect(approved.error?.message).toMatch(/cannot be created as approved/)
  })

  it('offline retry with the same client_uuid is rejected as a duplicate (23505) and found by client_uuid', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.eng)
    const cu = crypto.randomUUID()
    const first = ok(await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng, work_performed: 'a', client_uuid: cu }).select('id').single())
    const dup = await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng, work_performed: 'dup', client_uuid: cu }).select('id').single()
    expect(dup.error?.code).toBe('23505')
    const found = ok(await db.from('site_reports').select('id').eq('client_uuid', cu).single())
    expect(found.id).toBe(first.id)
    expect(t.raw.all('site_reports')).toHaveLength(1)
  })

  it('PM approval rolls progress onto the project, notifies the engineer and locks the report', async () => {
    const { t, U, P1 } = await withProjects()
    let db = t.as(U.eng)
    const r = ok(await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng, work_performed: 'Slab', progress_percent: 35, status: 'submitted' }).select().single())
    db = t.as(U.pm)
    ok(await db.from('site_reports').update({ status: 'approved' }).eq('id', r.id))
    expect(t.raw.get('projects', P1)!.progress).toBe(35)
    const rep = t.raw.get('site_reports', r.id)!
    expect(rep.approved_by).toBe(U.pm)
    expect(rep.approved_at).toBeTruthy()
    expect(notes(t, U.eng).some((n) => n.title === 'Site report approved' && n.type === 'success')).toBe(true)
    db = t.as(U.eng)
    const edit = await db.from('site_reports').update({ work_performed: 'edited' }).eq('id', r.id)
    expect(edit.error?.message).toMatch(/locked/)
  })

  it('rejection notifies the engineer with the review comment; resubmission notifies the PM again', async () => {
    const { t, U, P1 } = await withProjects()
    let db = t.as(U.eng)
    const r = ok(await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng, work_performed: 'Slab', status: 'submitted' }).select().single())
    db = t.as(U.pm)
    ok(await db.from('site_reports').update({ status: 'rejected', review_comment: 'Add photos' }).eq('id', r.id))
    expect(notes(t, U.eng).find((n) => n.title === 'Site report returned')?.body).toBe(`${r.number}: Add photos`)
    db = t.as(U.eng)
    ok(await db.from('site_reports').update({ status: 'submitted' }).eq('id', r.id))
    expect(notes(t, U.pm).filter((n) => n.type === 'approval')).toHaveLength(2)
  })

  it('photos inherit project/engineer from the report; deleting a draft report cascades to photos', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.eng)
    const r = ok(await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng, work_performed: 'x' }).select().single())
    const photo = ok(await db.from('site_report_photos').insert({ report_id: r.id, storage_path: `${P1}/${r.id}/a.jpg` }).select().single())
    expect(photo).toMatchObject({ project_id: P1, engineer_id: U.eng, created_by: U.eng })
    const full = ok(await db.from('site_reports').select('id, photos:site_report_photos(id,storage_path)').eq('id', r.id).single())
    expect(full.photos).toHaveLength(1)
    const other = t.as(U.eng2)
    const denied = await other.from('site_report_photos').insert({ report_id: r.id, storage_path: 'x.jpg' })
    expect(denied.error?.code).toBe('42501')
    ok(await t.as(U.eng).from('site_reports').delete().eq('id', r.id))
    expect(t.raw.all('site_report_photos')).toHaveLength(0)
  })

  it('validates CHECK constraints (weather, progress range)', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.eng)
    const bad = await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng, weather: 'snow' })
    expect(bad.error?.code).toBe('23514')
    const pct = await db.from('site_reports').insert({ project_id: P1, engineer_id: U.eng, progress_percent: 120 })
    expect(pct.error?.code).toBe('23514')
  })
})

// ============================================================================ inventory

async function withMaterial() {
  const s = await withProjects()
  const db = s.t.as(s.U.store)
  const mat = ok(await db.from('materials').insert({ name: 'Cement 50kg', unit: 'bag', unit_price: 17500, min_stock: 50, current_stock: 999 }).select().single())
  return { ...s, MAT: mat.id as string, mat }
}

describe('inventory ledger', () => {
  it('materials get a code and start at zero stock; receipts and issues maintain the balance', async () => {
    const { t, U, P1, MAT, mat } = await withMaterial()
    expect(mat.code).toMatch(/^MAT-/)
    expect(mat.current_stock).toBe(0)
    const db = t.as(U.store)
    const rec = ok(await db.from('inventory_transactions').insert({ material_id: MAT, txn_type: 'receipt', quantity: 100, unit_price: 18000 }).select().single())
    expect(rec.balance_after).toBe(100)
    expect(t.raw.get('materials', MAT)!.unit_price).toBe(18000) // receipts update the material price
    const iss = ok(await db.from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 30 }).select().single())
    expect(iss.balance_after).toBe(70)
    expect(iss.unit_price).toBe(18000) // defaulted from the material
    expect(iss.approved_by).toBeNull()
    expect(t.raw.get('materials', MAT)!.current_stock).toBe(70)
    expect(t.raw.get('materials', MAT)!.last_txn_id).toBe(iss.id)
  })

  it('stock cannot go negative without authorised approval', async () => {
    const { t, U, P1, MAT } = await withMaterial()
    let db = t.as(U.store)
    ok(await db.from('inventory_transactions').insert({ material_id: MAT, txn_type: 'receipt', quantity: 70 }))
    const short = await db.from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 100 })
    expect(short.error?.message).toMatch(/Insufficient stock/)
    const noPerm = await db.from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 100, negative_override: true })
    expect(noPerm.error?.message).toMatch(/requires authorised approval/)
    db = t.as(U.pm)
    const r = ok(
      await db.from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 100, negative_override: true }).select().single(),
    )
    expect(r.balance_after).toBe(-30)
    expect(r.approved_by).toBe(U.pm)
  })

  it('adjustments need inventory.adjust', async () => {
    const { t, U, MAT } = await withMaterial()
    const db = t.as(U.store)
    const adj = await db.from('inventory_transactions').insert({ material_id: MAT, txn_type: 'adjustment_in', quantity: 5 })
    expect(adj.error?.message).toMatch(/Not authorised to post stock adjustments/)
    ok(await t.as(U.admin).from('inventory_transactions').insert({ material_id: MAT, txn_type: 'adjustment_in', quantity: 5 }))
    expect(t.raw.get('materials', MAT)!.current_stock).toBe(5)
  })

  it('balances cannot be edited directly and ledger rows are immutable', async () => {
    const { t, U, MAT } = await withMaterial()
    const db = t.as(U.store)
    const txn = ok(await db.from('inventory_transactions').insert({ material_id: MAT, txn_type: 'receipt', quantity: 10 }).select().single())
    const direct = await db.from('materials').update({ current_stock: 999 }).eq('id', MAT)
    expect(direct.error?.message).toMatch(/only change through inventory transactions/)
    ok(await db.from('inventory_transactions').insert({ material_id: MAT, txn_type: 'receipt', quantity: 5 }))
    // pointing the balance at an older ledger row is not a ledger posting either
    const spoof = await db.from('materials').update({ current_stock: 10, last_txn_id: txn.id }).eq('id', MAT)
    expect(spoof.error?.message).toMatch(/only change through inventory transactions/)
    ok(await db.from('materials').update({ name: 'Cement 50kg (Twiga)' }).eq('id', MAT))
    const admin = t.as(U.admin)
    const upd = await admin.from('inventory_transactions').update({ quantity: 1 }).eq('id', txn.id)
    expect(upd.error?.message).toMatch(/immutable/)
    const del = await admin.from('inventory_transactions').delete().eq('id', txn.id)
    expect(del.error?.message).toMatch(/immutable/)
    const delMat = await admin.from('materials').delete().eq('id', MAT)
    expect(delMat.error?.code).toBe('23503')
  })

  it('low-stock alert notifies inventory managers when crossing the minimum (once)', async () => {
    const { t, U, P1, MAT } = await withMaterial()
    let db = t.as(U.store)
    ok(await db.from('inventory_transactions').insert({ material_id: MAT, txn_type: 'receipt', quantity: 100 }))
    ok(await db.from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 30 }))
    expect(notes(t, U.store).filter((n) => n.title.startsWith('Low stock'))).toHaveLength(0)
    db = t.as(U.pm)
    ok(await db.from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 100, negative_override: true }))
    const low = notes(t, U.store).filter((n) => n.title === 'Low stock: Cement 50kg')
    expect(low).toHaveLength(1)
    expect(low[0].type).toBe('warning')
    expect(notes(t, U.pm).filter((n) => n.title.startsWith('Low stock'))).toHaveLength(0) // actor is not notified
  })

  it('users without inventory rights cannot post movements', async () => {
    const { t, U, MAT } = await withMaterial()
    const r = await t.as(U.eng).from('inventory_transactions').insert({ material_id: MAT, txn_type: 'receipt', quantity: 1 })
    expect(r.error?.code).toBe('42501')
  })
})

// ============================================================================ procurement

describe('procurement', () => {
  it('request → approval → PO → approval → GRN posts stock and updates PO; over-receipt rejected', async () => {
    const { t, U, P1, MAT } = await withMaterial()
    // opening state from the inventory scenario: balance −30
    ok(await t.as(U.pm).from('inventory_transactions').insert({ material_id: MAT, project_id: P1, txn_type: 'issue', quantity: 30, negative_override: true }))

    const SUP = ok(await t.as(U.proc).from('suppliers').insert({ name: 'Twiga Cement Ltd' }).select().single()).id

    let db = t.as(U.eng)
    const pr = ok(await db.from('purchase_requests').insert({ project_id: P1, requested_by: U.eng, status: 'draft' }).select().single())
    expect(pr.number).toMatch(/^PR-/)
    const pri = ok(
      await db.from('purchase_request_items').insert({ request_id: pr.id, material_id: MAT, description: 'Cement', quantity: 200, unit: 'bag', estimated_rate: 17000 }).select().single(),
    )
    expect(pri.amount).toBe(3400000)
    expect(pri).toMatchObject({ project_id: P1, requested_by: U.eng })
    ok(await db.from('purchase_requests').update({ status: 'submitted' }).eq('id', pr.id))
    expect(notes(t, U.md).some((n) => n.title === `Purchase request ${pr.number}` && n.type === 'approval')).toBe(true)

    const procApprove = await t.as(U.proc).from('purchase_requests').update({ status: 'approved' }).eq('id', pr.id)
    expect(procApprove.error?.message).toMatch(/Not authorised/)
    ok(await t.as(U.md).from('purchase_requests').update({ status: 'approved' }).eq('id', pr.id))
    expect(t.raw.get('purchase_requests', pr.id)!.approved_by).toBe(U.md)
    expect(notes(t, U.eng).some((n) => n.title === 'Purchase request approved' && n.type === 'success')).toBe(true)
    // the requester can no longer change items once approved
    const lateItem = await t.as(U.eng).from('purchase_request_items').insert({ request_id: pr.id, description: 'Sand', quantity: 1 })
    expect(lateItem.error?.code).toBe('42501')

    db = t.as(U.proc)
    const po = ok(
      await db.from('purchase_orders').insert({ supplier_id: SUP, project_id: P1, request_id: pr.id, expected_date: '2030-01-01' }).select().single(),
    )
    expect(po.number).toMatch(/^PO-/)
    const poi = ok(
      await db.from('purchase_order_items').insert({ po_id: po.id, material_id: MAT, description: 'Cement', quantity: 200, unit: 'bag', rate: 17000 }).select().single(),
    )
    expect(poi.amount).toBe(3400000)
    ok(await db.from('purchase_orders').update({ status: 'pending_approval' }).eq('id', po.id))
    expect(notes(t, U.md).some((n) => n.title === `PO ${po.number} awaiting approval`)).toBe(true)
    const totals = ok(await db.from('purchase_order_totals').select('*').eq('po_id', po.id).single())
    expect(totals).toMatchObject({ subtotal: 3400000, tax_amount: 612000, total: 4012000, qty_ordered: 200, qty_received: 0 })

    const sendEarly = await db.from('purchase_orders').update({ status: 'sent' }).eq('id', po.id)
    expect(sendEarly.error?.message).toMatch(/Only approved purchase orders can be sent/)
    const procPo = await db.from('purchase_orders').update({ status: 'approved' }).eq('id', po.id)
    expect(procPo.error?.message).toMatch(/Not authorised/)
    ok(await t.as(U.md).from('purchase_orders').update({ status: 'approved' }).eq('id', po.id))
    expect(t.raw.get('purchase_orders', po.id)!.approved_by).toBe(U.md)
    const locked = await db.from('purchase_order_items').update({ quantity: 500 }).eq('id', poi.id)
    expect(locked.error?.message).toMatch(/locked/)
    const lockedAdd = await db.from('purchase_order_items').insert({ po_id: po.id, description: 'Extra', quantity: 1 })
    expect(lockedAdd.error?.message).toMatch(/locked/)

    db = t.as(U.store)
    const g1 = ok(await db.from('goods_received').insert({ po_id: po.id, supplier_id: SUP, project_id: P1 }).select().single())
    expect(g1.number).toMatch(/^GRN-/)
    expect(g1.received_by).toBe(U.store)
    const gi = ok(
      await db.from('goods_received_items').insert({ grn_id: g1.id, po_item_id: poi.id, material_id: MAT, quantity_received: 120, unit_price: 17000 }).select().single(),
    )
    expect(t.raw.get('purchase_orders', po.id)!.status).toBe('partially_received')
    expect(t.raw.get('purchase_order_items', poi.id)!.received_qty).toBe(120)
    expect(t.raw.get('materials', MAT)!.current_stock).toBe(90) // −30 + 120
    const posted = t.raw.get('inventory_transactions', gi.id)!
    expect(posted).toMatchObject({ grn_item_id: gi.id, txn_type: 'receipt', quantity: 120, reference: g1.number, project_id: P1, balance_after: 90 })

    // over-receipt beyond +10% on a partially received PO
    const g2 = ok(await db.from('goods_received').insert({ po_id: po.id, supplier_id: SUP, project_id: P1 }).select().single())
    const over = await db.from('goods_received_items').insert({ grn_id: g2.id, po_item_id: poi.id, material_id: MAT, quantity_received: 101 })
    expect(over.error?.message).toMatch(/exceeds ordered quantity/)
    expect(t.raw.get('materials', MAT)!.current_stock).toBe(90) // rolled back

    ok(await db.from('goods_received_items').insert({ grn_id: g2.id, po_item_id: poi.id, material_id: MAT, quantity_received: 80, unit_price: 17000 }))
    expect(t.raw.get('purchase_orders', po.id)!.status).toBe('received')
    expect(t.raw.get('materials', MAT)!.current_stock).toBe(170)
    const after = ok(await db.from('purchase_order_totals').select('*').eq('po_id', po.id).single())
    expect(after.qty_received).toBe(200)

    // nothing more can be received against a fully received PO
    const g3 = await db.from('goods_received').insert({ po_id: po.id, supplier_id: SUP })
    expect(g3.error?.message).toMatch(/Goods can only be received against an approved purchase order/)

    // GRN lines are immutable
    const editGi = await t.as(U.admin).from('goods_received_items').update({ quantity_received: 1 }).eq('id', gi.id)
    expect(editGi.error?.message).toMatch(/immutable/)
    const delGi = await t.as(U.admin).from('goods_received_items').delete().eq('id', gi.id)
    expect(delGi.error?.message).toMatch(/immutable/)

    // audit trail for the procurement documents
    const audited = new Set(t.raw.all('audit_logs').map((a) => a.table_name))
    for (const tb of ['suppliers', 'purchase_requests', 'purchase_request_items', 'purchase_orders', 'purchase_order_items', 'goods_received', 'goods_received_items', 'inventory_transactions', 'materials'])
      expect(audited.has(tb)).toBe(true)
  })

  it('GRNs cannot be raised against a draft PO; new documents cannot start approved', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.proc)
    const SUP = ok(await db.from('suppliers').insert({ name: 'S' }).select().single()).id
    const po = ok(await db.from('purchase_orders').insert({ supplier_id: SUP, project_id: P1 }).select().single())
    const g = await t.as(U.store).from('goods_received').insert({ po_id: po.id, supplier_id: SUP })
    expect(g.error?.message).toMatch(/approved purchase order/)
    const poApproved = await db.from('purchase_orders').insert({ supplier_id: SUP, status: 'approved' })
    expect(poApproved.error?.message).toMatch(/must start as draft or pending approval/)
    const prApproved = await t.as(U.eng).from('purchase_requests').insert({ project_id: P1, requested_by: U.eng, status: 'approved' })
    expect(prApproved.error?.message).toMatch(/must be draft or submitted/)
  })

  it('a draft PO and its items can be deleted; a draft PR cascades its items', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.proc)
    const SUP = ok(await db.from('suppliers').insert({ name: 'S' }).select().single()).id
    const po = ok(await db.from('purchase_orders').insert({ supplier_id: SUP, project_id: P1 }).select().single())
    ok(await db.from('purchase_order_items').insert({ po_id: po.id, description: 'x', quantity: 2, rate: 5 }))
    ok(await db.from('purchase_orders').delete().eq('id', po.id))
    expect(t.raw.all('purchase_order_items')).toHaveLength(0)
    const eng = t.as(U.eng)
    const pr = ok(await eng.from('purchase_requests').insert({ project_id: P1, requested_by: U.eng }).select().single())
    ok(await eng.from('purchase_request_items').insert({ request_id: pr.id, description: 'x', quantity: 1 }))
    ok(await eng.from('purchase_requests').delete().eq('id', pr.id))
    expect(t.raw.all('purchase_request_items')).toHaveLength(0)
  })

  it('requesters see their own requests (with items) through the own-row scope', async () => {
    const { t, U, P1 } = await withProjects()
    const eng = t.as(U.eng)
    const pr = ok(await eng.from('purchase_requests').insert({ project_id: P1, requested_by: U.eng }).select().single())
    ok(await eng.from('purchase_request_items').insert({ request_id: pr.id, description: 'x', quantity: 1, estimated_rate: 2.5 }))
    const rows = ok(await eng.from('purchase_requests').select('id, items:purchase_request_items(*)'))
    expect(rows).toHaveLength(1)
    expect(rows[0].items[0].amount).toBe(2.5)
  })

  it('supplier invoices compute their total and enforce the (supplier, invoice_no) unique key', async () => {
    const { t, U } = await withProjects()
    const db = t.as(U.proc)
    const SUP = ok(await db.from('suppliers').insert({ name: 'S' }).select().single()).id
    const inv = ok(await db.from('supplier_invoices').insert({ supplier_id: SUP, invoice_no: 'TW-1', amount: 1000, tax_amount: 180 }).select().single())
    expect(inv.total).toBe(1180)
    const dup = await db.from('supplier_invoices').insert({ supplier_id: SUP, invoice_no: 'TW-1', amount: 1 })
    expect(dup.error?.code).toBe('23505')
    const badEmail = await db.from('suppliers').insert({ name: 'T', email: 'nope' })
    expect(badEmail.error?.code).toBe('23514')
  })
})

// ============================================================================ equipment

describe('equipment', () => {
  it('codes, assignments, usage meter and maintenance drive the equipment status', async () => {
    const { t, U, P1, P2 } = await withProjects()
    const db = t.as(U.admin)
    const e = ok(await db.from('equipment').insert({ name: 'Excavator CAT 320' }).select().single())
    expect(e.code).toMatch(/^EQ-/)
    expect(e.status).toBe('available')

    const a1 = ok(await db.from('equipment_assignments').insert({ equipment_id: e.id, project_id: P1, start_date: '2026-01-01' }).select().single())
    expect(t.raw.get('equipment', e.id)).toMatchObject({ current_project_id: P1, status: 'in_use' })

    // a new open assignment closes the previous one
    const a2 = ok(await db.from('equipment_assignments').insert({ equipment_id: e.id, project_id: P2, start_date: '2026-02-01' }).select().single())
    expect(t.raw.get('equipment_assignments', a1.id)!.end_date).toBe('2026-02-01')
    expect(t.raw.get('equipment', e.id)).toMatchObject({ current_project_id: P2, status: 'in_use' })

    // usage logs only ever raise the meter reading
    ok(await db.from('equipment_usage_logs').insert({ equipment_id: e.id, project_id: P2, hours_operated: 8, meter_reading: 1200 }))
    ok(await db.from('equipment_usage_logs').insert({ equipment_id: e.id, project_id: P2, hours_operated: 8, meter_reading: 1100 }))
    expect(t.raw.get('equipment', e.id)!.meter_reading).toBe(1200)
    const badHours = await db.from('equipment_usage_logs').insert({ equipment_id: e.id, hours_operated: 25 })
    expect(badHours.error?.code).toBe('23514')

    // breakdown → maintenance → completed (back in use on its project)
    const m = ok(await db.from('maintenance_records').insert({ equipment_id: e.id, maintenance_type: 'breakdown', description: 'Hydraulic leak' }).select().single())
    expect(t.raw.get('equipment', e.id)!.status).toBe('breakdown')
    ok(await db.from('maintenance_records').update({ maintenance_type: 'repair', status: 'in_progress' }).eq('id', m.id))
    expect(t.raw.get('equipment', e.id)!.status).toBe('maintenance')
    ok(await db.from('maintenance_records').update({ status: 'completed', completed_date: '2026-02-10' }).eq('id', m.id))
    expect(t.raw.get('equipment', e.id)!.status).toBe('in_use')

    // ending the assignment releases the equipment
    ok(await db.from('equipment_assignments').update({ end_date: '2026-03-01' }).eq('id', a2.id))
    expect(t.raw.get('equipment', e.id)).toMatchObject({ current_project_id: null, status: 'available' })

    const badDates = await db.from('equipment_assignments').insert({ equipment_id: e.id, project_id: P1, start_date: '2026-05-01', end_date: '2026-04-01' })
    expect(badDates.error?.code).toBe('23514')
    expect(t.raw.all('audit_logs').some((a) => a.table_name === 'maintenance_records')).toBe(true)
  })

  it('a PM cannot silently take over equipment assigned to a project they cannot access', async () => {
    const { t, U, P1, P2 } = await withProjects()
    const admin = t.as(U.admin)
    const e = ok(await admin.from('equipment').insert({ name: 'Crane' }).select().single())
    ok(await admin.from('equipment_assignments').insert({ equipment_id: e.id, project_id: P2 }))
    const r = await t.as(U.pm).from('equipment_assignments').insert({ equipment_id: e.id, project_id: P1 })
    expect(r.error?.code).toBe('42501')
    expect(t.raw.get('equipment', e.id)!.current_project_id).toBe(P2)
  })
})
