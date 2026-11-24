/**
 * Operations domain — ported from legacy-supabase/migrations/…0300_operations.sql
 * (+ the operations parts of …0500_roles_rls.sql, enforced for real in firebase/rules/30_operations.rules):
 *
 *   site reports (numbering, submit → PM notification, approval → project progress roll-up, lock),
 *   site report photos, safety incidents, materials & the stock ledger (balance_after, low-stock alerts,
 *   negative-stock override, immutable rows), suppliers, purchase requests / orders (approval flow,
 *   notifications, PO item lock), goods received (stock posting, PO received quantities & status,
 *   over-receipt rejection), supplier invoices, equipment (codes, assignments, usage, maintenance).
 *
 * Security-relevant trigger checks are duplicated in the Firestore rules: hooks run in the browser and
 * only keep honest clients consistent; the rules are what a malicious client cannot bypass.
 */
import type { Filter } from '../filters'
import {
  defineGenerated,
  defineHooks,
  defineInherit,
  defineScope,
  defineView,
  enableAudit,
  projectScope,
  round2,
  type Row,
  type WriteCtx,
} from '../registry'

enableAudit(
  'site_reports',
  'safety_incidents',
  'materials',
  'inventory_transactions',
  'suppliers',
  'purchase_requests',
  'purchase_request_items',
  'purchase_orders',
  'purchase_order_items',
  'goods_received',
  'goods_received_items',
  'supplier_invoices',
  'equipment',
  'equipment_assignments',
  'maintenance_records',
)

// ============================================================================ helpers

const eq = (col: string, value: unknown): Filter => ({ kind: 'cmp', col, op: 'eq', value })
const isNull = (col: string): Filter => ({ kind: 'cmp', col, op: 'is', value: null })
const round3 = (n: unknown) => Math.round((Number(n) || 0) * 1000) / 1000
const num = (n: unknown) => Number(n) || 0
const EPS = 0.0005

function canAccessProject(ctx: WriteCtx, pid: unknown) {
  return pid == null || ctx.me.viewAll || ctx.me.projectIds.includes(String(pid))
}

function rls(ctx: WriteCtx, table: string): never {
  return ctx.fail(`new row violates row-level security policy for table "${table}"`, '42501')
}

/** true when the only columns that differ are denormalised (inherited) ones kept in sync by the engine */
function onlyChanged(row: Row, old: Row, allowed: string[]) {
  const keys = new Set([...Object.keys(row), ...Object.keys(old)])
  for (const k of keys) {
    if (k === 'updated_at' || allowed.includes(k)) continue
    if (JSON.stringify(row[k] ?? null) !== JSON.stringify(old[k] ?? null)) return false
  }
  return true
}

/** CHECK constraints from the SQL table definitions (the engine only enforces NOT NULL / UNIQUE / FK). */
type Check = [name: string, ok: (r: Row) => boolean]
function defineChecks(table: string, list: Check[]) {
  const run = (row: Row, ctx: WriteCtx) => {
    for (const [name, ok] of list) if (!ok(row)) ctx.fail(`new row for relation "${table}" violates check constraint "${table}_${name}_check"`, '23514')
  }
  defineHooks(table, { beforeInsert: run, beforeUpdate: (row, _old, ctx) => run(row, ctx) })
}
const oneOf = (col: string, values: string[], nullable = false): Check => [col, (r) => (r[col] == null ? nullable : values.includes(r[col]))]
const atLeast = (col: string, min: number, nullable = false): Check => [col, (r) => (r[col] == null ? nullable : Number(r[col]) >= min)]
const positive = (col: string): Check => [col, (r) => r[col] != null && Number(r[col]) > 0]
const between = (col: string, min: number, max: number, nullable = true): Check => [
  col,
  (r) => (r[col] == null ? nullable : Number(r[col]) >= min && Number(r[col]) <= max),
]
const nameLen = (col = 'name'): Check => [col, (r) => typeof r[col] === 'string' && r[col].length >= 1 && r[col].length <= 200]
const isArray = (col: string): Check => [col, (r) => Array.isArray(r[col])]

/**
 * Privileged nested writes. PostgreSQL used session flags (abckit.stock_update / abckit.grn_update) set by
 * SECURITY DEFINER triggers; here the hook that performs the nested write marks the write session.
 */
const postedTxns = new WeakMap<WriteCtx, Set<string>>()
const grnPosting = new WeakSet<WriteCtx>()

// ============================================================================ read scopes
// Tables without a project_id column of their own get the parent's project_id denormalised (defineInherit)
// so a non-company-wide user's list query can be split per project and verified by the security rules.

defineInherit('site_report_photos', { via: 'report_id', from: 'site_reports', fields: { project_id: 'project_id', engineer_id: 'engineer_id' } })
defineScope('site_report_photos', projectScope())

defineInherit('purchase_request_items', {
  via: 'request_id',
  from: 'purchase_requests',
  fields: { project_id: 'project_id', requested_by: 'requested_by' },
})
// requesters always see their own requests (pr_read: … or requested_by = auth.uid())
defineScope('purchase_requests', projectScope({ nullable: true, own: ['requested_by'] }))
defineScope('purchase_request_items', projectScope({ nullable: true, own: ['requested_by'] }))

defineInherit('purchase_order_items', { via: 'po_id', from: 'purchase_orders', fields: { project_id: 'project_id' } })
defineScope('purchase_order_items', projectScope({ nullable: true }))

defineInherit('goods_received_items', { via: 'grn_id', from: 'goods_received', fields: { project_id: 'project_id' } })
defineScope('goods_received_items', projectScope({ nullable: true }))

// supplier invoices were never project-restricted (sup_inv_read checks permissions only)
defineScope('supplier_invoices', () => 'all')

// ============================================================================ generated columns

defineGenerated('purchase_request_items', { amount: (r) => round2(num(r.quantity) * num(r.estimated_rate)) })
defineGenerated('purchase_order_items', { amount: (r) => round2(num(r.quantity) * num(r.rate)) })
defineGenerated('supplier_invoices', { total: (r) => round2(num(r.amount) + num(r.tax_amount)) })

// ============================================================================ CHECK constraints

defineChecks('site_reports', [
  oneOf('weather', ['sunny', 'cloudy', 'rainy', 'heavy_rain', 'windy', 'stormy'], true),
  atLeast('workers_count', 0),
  isArray('labour'),
  isArray('materials_used'),
  isArray('equipment_used'),
  between('progress_percent', 0, 100),
  atLeast('safety_incidents', 0),
  ['signature_data', (r) => r.signature_data == null || String(r.signature_data).length < 400000],
  oneOf('status', ['draft', 'submitted', 'approved', 'rejected']),
])
defineChecks('safety_incidents', [
  oneOf('severity', ['near_miss', 'minor', 'moderate', 'major', 'fatal']),
  oneOf('status', ['open', 'investigating', 'closed']),
])
defineChecks('materials', [nameLen(), atLeast('unit_price', 0), atLeast('min_stock', 0)])
defineChecks('inventory_transactions', [
  oneOf('txn_type', ['receipt', 'issue', 'return', 'adjustment_in', 'adjustment_out', 'opening']),
  positive('quantity'),
  atLeast('unit_price', 0, true),
])
defineChecks('suppliers', [
  nameLen(),
  ['email', (r) => r.email == null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(String(r.email))],
  between('rating', 1, 5),
])
defineChecks('purchase_requests', [
  oneOf('priority', ['low', 'normal', 'high', 'urgent']),
  oneOf('status', ['draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled']),
])
defineChecks('purchase_request_items', [positive('quantity'), atLeast('estimated_rate', 0)])
defineChecks('purchase_orders', [
  ['currency', (r) => /^[A-Z]{3}$/.test(String(r.currency ?? ''))],
  between('tax_rate', 0, 100, false),
  oneOf('status', ['draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'cancelled']),
])
defineChecks('purchase_order_items', [positive('quantity'), atLeast('rate', 0), atLeast('received_qty', 0)])
defineChecks('goods_received_items', [positive('quantity_received'), atLeast('quantity_rejected', 0), atLeast('unit_price', 0)])
defineChecks('supplier_invoices', [
  atLeast('amount', 0),
  atLeast('tax_amount', 0),
  oneOf('status', ['unpaid', 'partially_paid', 'paid', 'disputed', 'void']),
])
defineChecks('equipment', [
  nameLen(),
  oneOf('category', ['earthmoving', 'lifting', 'concrete', 'transport', 'compaction', 'power', 'survey', 'small_tools', 'other']),
  between('year', 1950, 2100),
  oneOf('ownership', ['owned', 'hired', 'leased']),
  atLeast('purchase_cost', 0, true),
  atLeast('hourly_rate', 0),
  oneOf('status', ['available', 'in_use', 'maintenance', 'breakdown', 'retired']),
])
defineChecks('equipment_assignments', [['end_date', (r) => r.end_date == null || String(r.end_date) >= String(r.start_date)]])
defineChecks('equipment_usage_logs', [
  between('hours_operated', 0, 24, false),
  between('idle_hours', 0, 24, false),
  atLeast('fuel_litres', 0),
  atLeast('fuel_cost', 0),
])
defineChecks('maintenance_records', [
  oneOf('maintenance_type', ['scheduled', 'repair', 'breakdown', 'inspection']),
  atLeast('cost', 0),
  atLeast('downtime_hours', 0),
  oneOf('status', ['scheduled', 'in_progress', 'completed', 'cancelled']),
])

// ============================================================================ site reports

async function siteReportAfter(row: Row, old: Row | null, ctx: WriteCtx) {
  const became = (s: string) => row.status === s && (!old || old.status !== s)
  if (!became('approved') && !became('rejected') && !became('submitted')) return
  const project = await ctx.get('projects', String(row.project_id))
  const pname = project?.name ?? ''
  const link = `/site-reports/${row.id}`
  if (became('approved')) {
    if (row.progress_percent != null) await ctx.update('projects', String(row.project_id), { progress: row.progress_percent })
    if (await ctx.notificationEnabled('approvals'))
      await ctx.notifyUser(row.engineer_id, 'Site report approved', `${row.number} for ${pname} was approved.`, 'success', link)
  } else if (became('rejected')) {
    await ctx.notifyUser(row.engineer_id, 'Site report returned', `${row.number}: ${row.review_comment ?? 'see comments'}`, 'warning', link)
  } else if (await ctx.notificationEnabled('report_submitted')) {
    await ctx.notifyUser(project?.project_manager_id, 'Site report submitted', `${row.number} for ${pname} awaits approval.`, 'approval', link)
  }
}

defineHooks('site_reports', {
  async beforeInsert(row, ctx) {
    // site_reports_insert policy
    if (!ctx.me.can('site.report') || !canAccessProject(ctx, row.project_id) || row.engineer_id !== ctx.me.uid) rls(ctx, 'site_reports')
    if (row.status === 'approved' || row.status === 'rejected') ctx.fail('New reports cannot be created as approved/rejected')
    // Offline sync idempotency: the client_uuid doubles as the document id, so a retried insert collides
    // on the primary key inside the transaction (23505) instead of relying on a racy unique-index query.
    if (row.client_uuid) row.id = String(row.client_uuid)
    if (!row.number) row.number = await ctx.nextNumber('site_report')
    if (row.status === 'submitted') row.submitted_at = ctx.now
    row.approved_by = null
    row.approved_at = null
  },
  beforeUpdate(row, old, ctx) {
    if (row.status === 'submitted' && old.status !== 'submitted') row.submitted_at = ctx.now
    if (old.status === 'approved' && !ctx.me.can('site.approve')) ctx.fail('Approved reports are locked', '42501')
    if ((row.status === 'approved' || row.status === 'rejected') && row.status !== old.status) {
      if (!ctx.me.can('site.approve')) ctx.fail('Not authorised to approve site reports', '42501')
      row.approved_by = ctx.me.uid
      row.approved_at = ctx.now
    }
  },
  afterInsert: (row, ctx) => siteReportAfter(row, null, ctx),
  afterUpdate: (row, old, ctx) => siteReportAfter(row, old, ctx),
})

defineHooks('site_report_photos', {
  beforeInsert(row, ctx) {
    // site_photos_write policy (project_id / engineer_id were copied from the report by defineInherit)
    if (!(row.engineer_id === ctx.me.uid || ctx.me.can('site.approve')) || !canAccessProject(ctx, row.project_id)) rls(ctx, 'site_report_photos')
  },
})

// ============================================================================ materials & stock ledger

defineHooks('materials', {
  async beforeInsert(row, ctx) {
    if (!row.code) row.code = await ctx.nextNumber('material')
    row.current_stock = 0 // opening stock must be entered as an inventory transaction
    row.last_txn_id = null
  },
  beforeUpdate(row, old, ctx) {
    const stockChanged = num(row.current_stock) !== num(old.current_stock) || (row.last_txn_id ?? null) !== (old.last_txn_id ?? null)
    if (!stockChanged) return
    // only the ledger (inventory_transactions afterInsert in this same transaction) may move the balance
    if (!row.last_txn_id || !postedTxns.get(ctx)?.has(String(row.last_txn_id)))
      ctx.fail('Stock balances can only change through inventory transactions', '42501')
  },
})

const INBOUND = new Set(['receipt', 'return', 'adjustment_in', 'opening'])

defineHooks('inventory_transactions', {
  async beforeInsert(row, ctx) {
    const viaGrn = grnPosting.has(ctx)
    // inv_txn_insert policy (GRN postings were inserted by a SECURITY DEFINER trigger)
    if (!viaGrn) {
      if (!(ctx.me.can('inventory.manage') || ctx.me.can('inventory.approve_negative')) || !canAccessProject(ctx, row.project_id))
        rls(ctx, 'inventory_transactions')
      row.grn_item_id = null
    }
    const m = await ctx.get('materials', String(row.material_id))
    if (!m) return ctx.fail('Material not found')
    const qty = round3(row.quantity)
    const delta = INBOUND.has(row.txn_type) ? qty : -qty
    if ((row.txn_type === 'adjustment_in' || row.txn_type === 'adjustment_out') && !ctx.me.can('inventory.adjust'))
      ctx.fail('Not authorised to post stock adjustments', '42501')
    const stock = round3(m.current_stock)
    const balance = round3(stock + delta)
    row.approved_by = null
    if (balance < 0) {
      if (!row.negative_override)
        ctx.fail(`Insufficient stock for ${m.name}: available ${stock} ${m.unit}, requested ${qty} ${m.unit}`, 'P0001')
      if (!ctx.me.can('inventory.approve_negative')) ctx.fail('Negative stock requires authorised approval', '42501')
      row.approved_by = ctx.me.uid
    }
    if (row.unit_price == null) row.unit_price = num(m.unit_price)
    row.balance_after = balance
  },
  async afterInsert(row, ctx) {
    const m = (await ctx.get('materials', String(row.material_id)))!
    let posted = postedTxns.get(ctx)
    if (!posted) postedTxns.set(ctx, (posted = new Set()))
    posted.add(String(row.id))
    const patch: Row = { current_stock: row.balance_after, last_txn_id: row.id }
    if (row.txn_type === 'receipt' && num(row.unit_price) > 0) patch.unit_price = row.unit_price
    await ctx.update('materials', String(m.id), patch)

    const min = num(m.min_stock)
    if (row.balance_after <= min && min > 0 && num(m.current_stock) > min && (await ctx.notificationEnabled('low_stock')))
      await ctx.notifyPermission(
        'inventory.manage',
        `Low stock: ${m.name}`,
        `Balance ${row.balance_after} ${m.unit} is at/below minimum ${min}.`,
        'warning',
        '/inventory?tab=materials',
      )
  },
  // ledger entries are immutable: corrections are made with adjustments
  beforeUpdate(_row, _old, ctx) {
    ctx.fail('inventory_transactions records are immutable; post a correcting entry instead', '42501')
  },
  beforeDelete(_old, ctx) {
    ctx.fail('inventory_transactions records are immutable; post a correcting entry instead', '42501')
  },
})

// ============================================================================ purchase requests

defineHooks('purchase_requests', {
  async beforeInsert(row, ctx) {
    // pr_insert policy
    if (!ctx.me.can('procurement.request') || !canAccessProject(ctx, row.project_id) || row.requested_by !== ctx.me.uid) rls(ctx, 'purchase_requests')
    if (row.status !== 'draft' && row.status !== 'submitted') ctx.fail('New requests must be draft or submitted')
    if (!row.number) row.number = await ctx.nextNumber('purchase_request')
    row.approved_by = null
    row.approved_at = null
  },
  beforeUpdate(row, old, ctx) {
    if ((row.status === 'approved' || row.status === 'rejected') && row.status !== old.status) {
      if (!ctx.me.can('procurement.approve')) ctx.fail('Not authorised to approve purchase requests', '42501')
      row.approved_by = ctx.me.uid
      row.approved_at = ctx.now
    }
  },
  async afterInsert(row, ctx) {
    if (row.status === 'submitted' && (await ctx.notificationEnabled('approvals')))
      await ctx.notifyPermission('procurement.approve', `Purchase request ${row.number}`, 'A purchase request is awaiting approval.', 'approval', '/procurement?tab=requests')
  },
  async afterUpdate(row, old, ctx) {
    if (row.status === 'submitted' && old.status !== 'submitted') {
      if (await ctx.notificationEnabled('approvals'))
        await ctx.notifyPermission('procurement.approve', `Purchase request ${row.number}`, 'A purchase request is awaiting approval.', 'approval', '/procurement?tab=requests')
    } else if ((row.status === 'approved' || row.status === 'rejected') && row.status !== old.status) {
      await ctx.notifyUser(
        row.requested_by,
        `Purchase request ${row.status}`,
        `${row.number} was ${row.status}.`,
        row.status === 'approved' ? 'success' : 'warning',
        '/procurement?tab=requests',
      )
    }
  },
})

/** pr_items_write policy: the requester while draft/rejected, or procurement.manage */
async function prItemGuard(requestId: unknown, ctx: WriteCtx) {
  if (ctx.me.can('procurement.manage')) return
  const pr = await ctx.get('purchase_requests', String(requestId))
  if (!pr || pr.requested_by !== ctx.me.uid || !['draft', 'rejected'].includes(pr.status)) rls(ctx, 'purchase_request_items')
}

defineHooks('purchase_request_items', {
  beforeInsert: (row, ctx) => prItemGuard(row.request_id, ctx),
  async beforeUpdate(row, old, ctx) {
    if (onlyChanged(row, old, ['project_id', 'requested_by'])) return // inherited-field sync
    await prItemGuard(old.request_id, ctx)
    if (row.request_id !== old.request_id) await prItemGuard(row.request_id, ctx)
  },
  beforeDelete: (old, ctx) => prItemGuard(old.request_id, ctx),
})

// ============================================================================ purchase orders

defineHooks('purchase_orders', {
  async beforeInsert(row, ctx) {
    if (row.status !== 'draft' && row.status !== 'pending_approval') ctx.fail('New purchase orders must start as draft or pending approval')
    if (!row.number) row.number = await ctx.nextNumber('purchase_order')
    row.approved_by = null
    row.approved_at = null
  },
  beforeUpdate(row, old, ctx) {
    if (row.status === old.status) return
    if (row.status === 'approved' && !ctx.me.can('procurement.approve')) ctx.fail('Not authorised to approve purchase orders', '42501')
    if (row.status === 'sent' && old.status !== 'approved') ctx.fail('Only approved purchase orders can be sent')
    if (row.status === 'approved') {
      row.approved_by = ctx.me.uid
      row.approved_at = ctx.now
    }
  },
  async afterInsert(row, ctx) {
    if (row.status === 'pending_approval' && (await ctx.notificationEnabled('approvals')))
      await ctx.notifyPermission('procurement.approve', `PO ${row.number} awaiting approval`, 'A purchase order needs approval.', 'approval', '/procurement?tab=orders')
  },
  async afterUpdate(row, old, ctx) {
    if (row.status === 'pending_approval' && old.status !== 'pending_approval' && (await ctx.notificationEnabled('approvals')))
      await ctx.notifyPermission('procurement.approve', `PO ${row.number} awaiting approval`, 'A purchase order needs approval.', 'approval', '/procurement?tab=orders')
  },
})

/** PO items can only change while the PO is draft / pending approval (GRN postings excepted) */
async function poItemGuard(poId: unknown, ctx: WriteCtx) {
  if (grnPosting.has(ctx)) return
  const po = await ctx.get('purchase_orders', String(poId))
  if (!po || !['draft', 'pending_approval'].includes(po.status))
    ctx.fail('Purchase order items are locked once the PO is approved', '42501')
}

defineHooks('purchase_order_items', {
  beforeInsert: (row, ctx) => poItemGuard(row.po_id, ctx),
  async beforeUpdate(row, old, ctx) {
    if (onlyChanged(row, old, ['project_id'])) return // inherited-field sync (e.g. project deleted → set null)
    await poItemGuard(old.po_id, ctx)
    if (row.po_id !== old.po_id) await poItemGuard(row.po_id, ctx)
  },
  beforeDelete: (old, ctx) => poItemGuard(old.po_id, ctx),
})

defineView('purchase_order_totals', async (ctx) => {
  const [orders, items] = await Promise.all([ctx.select('purchase_orders'), ctx.select('purchase_order_items')])
  const byPo = new Map<string, Row[]>()
  for (const i of items) byPo.set(String(i.po_id), [...(byPo.get(String(i.po_id)) ?? []), i])
  return orders.map((po) => {
    const its = byPo.get(String(po.id)) ?? []
    const subtotal = round2(its.reduce((s, i) => s + num(i.amount), 0))
    const rate = num(po.tax_rate)
    return {
      po_id: po.id,
      subtotal,
      tax_amount: round2((subtotal * rate) / 100),
      total: round2(subtotal * (1 + rate / 100)),
      qty_ordered: round3(its.reduce((s, i) => s + num(i.quantity), 0)),
      qty_received: round3(its.reduce((s, i) => s + num(i.received_qty), 0)),
    }
  })
})

// ============================================================================ goods received

defineHooks('goods_received', {
  async beforeInsert(row, ctx) {
    if (!row.number) row.number = await ctx.nextNumber('goods_received')
    if (row.po_id != null) {
      const po = await ctx.get('purchase_orders', String(row.po_id))
      if (!po || !['approved', 'sent', 'partially_received'].includes(po.status))
        ctx.fail('Goods can only be received against an approved purchase order')
    }
  },
})

const IMMUTABLE_GRN = 'goods_received_items records are immutable; post a correcting entry instead'

defineHooks('goods_received_items', {
  async afterInsert(row, ctx) {
    const g = await ctx.get('goods_received', String(row.grn_id))
    if (!g) return ctx.fail('Goods received note not found', '23503')
    grnPosting.add(ctx)
    try {
      if (row.po_item_id != null) {
        const poi = await ctx.get('purchase_order_items', String(row.po_item_id))
        if (!poi) return ctx.fail('Purchase order item not found', '23503')
        if (g.po_id != null && poi.po_id !== g.po_id) ctx.fail('The purchase order item does not belong to this GRN’s purchase order')
        if (num(poi.received_qty) + num(row.quantity_received) > num(poi.quantity) * 1.1 + EPS)
          ctx.fail(`Received quantity exceeds ordered quantity (+10% tolerance) for ${poi.description}`)
        await ctx.update('purchase_order_items', String(poi.id), { received_qty: round3(num(poi.received_qty) + num(row.quantity_received)) })
      }
      // stock receipt; its id = the GRN item id so the security rules can verify the posting happened
      await ctx.insert('inventory_transactions', {
        id: row.id,
        material_id: row.material_id,
        project_id: g.project_id ?? null,
        txn_type: 'receipt',
        quantity: row.quantity_received,
        unit_price: row.unit_price,
        reference: g.number,
        grn_item_id: row.id,
        transaction_date: g.received_date,
        notes: `Received via ${g.number}`,
      })
      if (g.po_id != null) {
        const listed = await ctx.select('purchase_order_items', [eq('po_id', g.po_id)])
        let ordered = 0
        let received = 0
        for (const it of listed) {
          const cur = await ctx.get('purchase_order_items', String(it.id)) // includes this transaction's update
          if (!cur) continue
          ordered += num(cur.quantity)
          received += num(cur.received_qty)
        }
        await ctx.update('purchase_orders', String(g.po_id), { status: received + EPS >= ordered ? 'received' : 'partially_received' })
      }
    } finally {
      grnPosting.delete(ctx)
    }
  },
  beforeUpdate(row, old, ctx) {
    if (!onlyChanged(row, old, ['project_id'])) ctx.fail(IMMUTABLE_GRN, '42501')
  },
  beforeDelete(_old, ctx) {
    ctx.fail(IMMUTABLE_GRN, '42501')
  },
})

// ============================================================================ equipment

defineHooks('equipment', {
  async beforeInsert(row, ctx) {
    if (!row.code) row.code = await ctx.nextNumber('equipment')
  },
})

async function assignmentApply(row: Row, old: Row | null, ctx: WriteCtx) {
  if (row.end_date == null) {
    const equipment = await ctx.get('equipment', String(row.equipment_id))
    if (!equipment) return
    // The SQL trigger ran as SECURITY DEFINER and closed open assignments on any project. Here the caller's
    // own permissions apply, so refuse rather than leave an open assignment the caller cannot close.
    const cur = equipment.current_project_id
    if (cur && cur !== row.project_id && equipment.status === 'in_use' && !canAccessProject(ctx, cur))
      ctx.fail(`${equipment.name} is assigned to a project you do not have access to; end that assignment first`, '42501')
    const open = await ctx.select('equipment_assignments', [eq('equipment_id', row.equipment_id), isNull('end_date')])
    for (const a of open) {
      if (a.id === row.id) continue
      const live = await ctx.get('equipment_assignments', String(a.id))
      if (live && live.end_date == null) await ctx.update('equipment_assignments', String(a.id), { end_date: row.start_date })
    }
    await ctx.update('equipment', String(row.equipment_id), { current_project_id: row.project_id, status: 'in_use' })
  } else if (old && old.end_date == null) {
    const equipment = await ctx.get('equipment', String(row.equipment_id))
    if (equipment && equipment.current_project_id === row.project_id && equipment.status === 'in_use')
      await ctx.update('equipment', String(equipment.id), { current_project_id: null, status: 'available' })
  }
}

defineHooks('equipment_assignments', {
  afterInsert: (row, ctx) => assignmentApply(row, null, ctx),
  afterUpdate: (row, old, ctx) => assignmentApply(row, old, ctx),
})

defineHooks('equipment_usage_logs', {
  async afterInsert(row, ctx) {
    if (row.meter_reading == null) return
    const equipment = await ctx.get('equipment', String(row.equipment_id))
    if (equipment && num(row.meter_reading) > num(equipment.meter_reading))
      await ctx.update('equipment', String(equipment.id), { meter_reading: num(row.meter_reading) })
  },
})

async function maintenanceApply(row: Row, old: Row | null, ctx: WriteCtx) {
  const id = String(row.equipment_id)
  if (row.maintenance_type === 'breakdown' && (row.status === 'scheduled' || row.status === 'in_progress')) {
    await ctx.update('equipment', id, { status: 'breakdown' })
  } else if (row.status === 'in_progress') {
    await ctx.update('equipment', id, { status: 'maintenance' })
  } else if (row.status === 'completed' && (!old || old.status !== 'completed')) {
    const equipment = await ctx.get('equipment', id)
    if (equipment && (equipment.status === 'maintenance' || equipment.status === 'breakdown'))
      await ctx.update('equipment', id, { status: equipment.current_project_id ? 'in_use' : 'available' })
  }
}

defineHooks('maintenance_records', {
  afterInsert: (row, ctx) => maintenanceApply(row, null, ctx),
  afterUpdate: (row, old, ctx) => maintenanceApply(row, old, ctx),
})
