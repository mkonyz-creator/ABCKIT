/**
 * Database integration tests — applies every migration to an in-process PostgreSQL
 * (PGlite / WASM) with Supabase auth/storage stubs, then exercises RLS policies,
 * triggers and RPCs as each role.  Run:  npm run test:db
 */
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new PGlite({ extensions: { pg_trgm, pgcrypto } })

let passed = 0
const failures = []
const results = []
async function test(name, fn) {
  try {
    await fn()
    passed++
    results.push(['PASS', name])
  } catch (e) {
    failures.push([name, e.message])
    results.push(['FAIL', name, e.message])
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function eq(actual, expected, msg) {
  if (String(actual) !== String(expected)) throw new Error(`${msg}: expected ${expected}, got ${actual}`)
}

/** Run statements as a signed-in user (role authenticated + JWT sub), inside a transaction */
async function as(userId, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ''])
    await tx.exec(`set local role authenticated`)
    const q = async (sql, params) => (await tx.query(sql, params)).rows
    const one = async (sql, params) => (await q(sql, params))[0]
    return fn({ q, one })
  })
}
async function expectError(userId, fn, pattern) {
  try {
    await as(userId, fn)
  } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`wrong error: ${e.message}`)
    return e.message
  }
  throw new Error(`expected an error${pattern ? ` matching ${pattern}` : ''}`)
}
const sys = async (sql, params) => (await db.query(sql, params)).rows

// -----------------------------------------------------------------------------
console.log('Applying Supabase stubs and migrations…')
await db.exec(readFileSync(join(root, 'tests/db/supabase-stubs.sql'), 'utf8'))
const migDir = join(root, 'supabase/migrations')
for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
  try {
    await db.exec(readFileSync(join(migDir, f), 'utf8'))
    console.log(`  ✓ ${f}`)
  } catch (e) {
    console.error(`  ✗ ${f}: ${e.message}`)
    process.exit(1)
  }
}

// ----------------------------------------------------------------------------- users
const U = {}
async function createUser(key, email, name) {
  const r = await sys(`insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`, [email, name])
  U[key] = r[0].id
}
await createUser('admin', 'admin@aricom.test', 'Asha Admin')
for (const [k, n] of [
  ['md', 'Musa Director'], ['pm', 'Paula Manager'], ['eng', 'Eli Engineer'], ['eng2', 'Ena Engineer'], ['qs', 'Quinn Surveyor'],
  ['acc', 'Ada Accountant'], ['acc2', 'Abel Accountant'], ['proc', 'Peter Procurement'], ['store', 'Sam Store'], ['hr', 'Hana HR'], ['emp', 'Eddy Employee'],
]) await createUser(k, `${k}@aricom.test`, n)

const roleOf = { md: 'managing_director', pm: 'project_manager', eng: 'site_engineer', eng2: 'site_engineer', qs: 'quantity_surveyor', acc: 'accountant', acc2: 'accountant', proc: 'procurement_officer', store: 'storekeeper', hr: 'hr_officer', emp: 'employee' }

await test('first user becomes an active Super Administrator; later users are inactive employees', async () => {
  const a = await sys(`select p.is_active, r.key from profiles p join roles r on r.id = p.role_id where p.id = $1`, [U.admin])
  eq(a[0].key, 'super_admin', 'admin role')
  eq(a[0].is_active, true, 'admin active')
  const e = await sys(`select p.is_active, r.key from profiles p join roles r on r.id = p.role_id where p.id = $1`, [U.pm])
  eq(e[0].key, 'employee', 'new user role')
  eq(e[0].is_active, false, 'new user inactive')
})

await test('inactive users see nothing and have no permissions', async () => {
  await as(U.pm, async ({ q, one }) => {
    eq((await one(`select public.has_permission('projects.view') as v`)).v, false, 'has_permission')
    eq((await q(`select * from roles`)).length, 0, 'roles visible')
  })
})

await test('a non-admin cannot change their own role', async () => {
  await expectError(U.pm, ({ q }) => q(`update profiles set role_id = (select id from roles where key='super_admin') where id = $1`, [U.pm]), /Not authorised|permission/i)
})

await test('admin activates users and assigns roles', async () => {
  await as(U.admin, async ({ q }) => {
    for (const [k, role] of Object.entries(roleOf)) {
      await q(`update profiles set is_active = true, role_id = (select id from roles where key = $2) where id = $1`, [U[k], role])
    }
  })
  const r = await sys(`select count(*)::int c from profiles where is_active`)
  eq(r[0].c, 12, 'active users')
})

await test('admin cannot deactivate themself (last super admin protected)', async () => {
  await expectError(U.admin, ({ q }) => q(`update profiles set is_active = false where id = $1`, [U.admin]), /own account|Super Administrator/)
})

// ----------------------------------------------------------------------------- projects
let P1, P2, CLIENT
await test('PM creates client & project; code auto-numbered', async () => {
  await as(U.pm, async ({ one }) => {
    CLIENT = (await one(`insert into clients (name) values ('Ministry of Works') returning id`)).id
    const p = await one(`insert into projects (name, client_id, contract_value, budget, status, project_manager_id, start_date, end_date) values ('Office Block A', $1, 1000000000, 800000000, 'active', $2, current_date - 60, current_date + 120) returning id, code`, [CLIENT, U.pm])
    P1 = p.id
    assert(/^PRJ-\d{4}-0001$/.test(p.code), `code ${p.code}`)
  })
  await as(U.admin, async ({ one }) => {
    P2 = (await one(`insert into projects (name, contract_value, budget, status) values ('Warehouse B', 500000000, 400000000, 'active') returning id`)).id
  })
})

await test('site engineer only sees projects they are a member of', async () => {
  await as(U.pm, ({ q }) => q(`insert into project_members (project_id, user_id, member_role) values ($1, $2, 'site_engineer')`, [P1, U.eng]))
  await as(U.eng, async ({ q }) => {
    const rows = await q(`select id from projects`)
    eq(rows.length, 1, 'visible projects')
    eq(rows[0].id, P1, 'visible project')
  })
  await as(U.eng2, async ({ q }) => eq((await q(`select id from projects`)).length, 0, 'eng2 projects'))
  await as(U.md, async ({ q }) => eq((await q(`select id from projects`)).length, 2, 'MD projects'))
})

await test('employee role cannot create projects', async () => {
  await expectError(U.emp, ({ q }) => q(`insert into projects (name) values ('Nope')`), /row-level security/)
})

// ----------------------------------------------------------------------------- BOQ
let BOQ, SEC, ITEM
await test('BOQ: amounts, section totals, taxes and grand total are computed by the database', async () => {
  await as(U.pm, async ({ one }) => {
    BOQ = (await one(`insert into boqs (project_id, title, taxes) values ($1, 'Tender BOQ', '[{"name":"VAT","rate":18}]') returning id`, [P1])).id
    SEC = (await one(`insert into boq_sections (boq_id, code, title) values ($1, 'A', 'Substructure') returning id`, [BOQ])).id
    ITEM = (await one(`insert into boq_items (section_id, description, unit, quantity, rate) values ($1, 'Excavation', 'm³', 120.5, 8500) returning id, amount, boq_id`, [SEC])).id
    await one(`insert into boq_items (section_id, description, unit, quantity, rate) values ($1, 'Concrete C25', 'm³', 45, 320000) returning id`, [SEC])
    const t = await one(`select subtotal, tax_amount, grand_total from boq_totals where boq_id = $1`, [BOQ])
    eq(Number(t.subtotal), 120.5 * 8500 + 45 * 320000, 'subtotal')
    eq(Number(t.tax_amount), Math.round((120.5 * 8500 + 45 * 320000) * 0.18 * 100) / 100, 'tax')
    eq(Number(t.grand_total), Math.round((120.5 * 8500 + 45 * 320000) * 1.18 * 100) / 100, 'grand total')
  })
})

await test('BOQ: PM cannot approve; MD approves; approved BOQ is locked; revision copy works', async () => {
  await expectError(U.pm, ({ q }) => q(`update boqs set status = 'approved' where id = $1`, [BOQ]), /Not authorised to approve BOQs/)
  await as(U.md, ({ q }) => q(`update boqs set status = 'approved' where id = $1`, [BOQ]))
  await expectError(U.pm, ({ q }) => q(`update boq_items set quantity = 1 where id = $1`, [ITEM]), /locked/)
  await as(U.pm, async ({ one }) => {
    const id = (await one(`select duplicate_boq($1) as id`, [BOQ])).id
    const t = await one(`select item_count from boq_totals where boq_id = $1`, [id])
    eq(t.item_count, 2, 'copied items')
  })
})

await test('BOQ: an engineer (view only) cannot add items', async () => {
  await expectError(U.eng, ({ q }) => q(`insert into boq_items (section_id, description) values ($1, 'x')`, [SEC]), /row-level security|locked/)
})

// ----------------------------------------------------------------------------- site reports
let REPORT
await test('site report: engineer submits; PM notified; engineer cannot self-approve', async () => {
  await as(U.eng, async ({ one }) => {
    const r = await one(`insert into site_reports (project_id, engineer_id, work_performed, workers_count, progress_percent, status, client_uuid) values ($1, $2, 'Blockwork level 2', 24, 35, 'submitted', gen_random_uuid()) returning id, number`, [P1, U.eng])
    REPORT = r.id
    assert(/^DSR-/.test(r.number), 'report number')
  })
  const n = await sys(`select count(*)::int c from notifications where user_id = $1 and type = 'approval'`, [U.pm])
  eq(n[0].c, 1, 'PM notification')
  await expectError(U.eng, ({ q }) => q(`update site_reports set status = 'approved' where id = $1`, [REPORT]), /Not authorised to approve/)
})

await test('site report: engineer cannot report on a project they are not assigned to', async () => {
  await expectError(U.eng, ({ q }) => q(`insert into site_reports (project_id, engineer_id, work_performed) values ($1, $2, 'x')`, [P2, U.eng]), /row-level security/)
})

await test('site report: offline retry with same client_uuid is rejected as duplicate (idempotent sync)', async () => {
  const cu = (await sys(`select client_uuid from site_reports where id = $1`, [REPORT]))[0].client_uuid
  await expectError(U.eng, ({ q }) => q(`insert into site_reports (project_id, engineer_id, work_performed, client_uuid) values ($1, $2, 'dup', $3)`, [P1, U.eng, cu]), /duplicate key/)
})

await test('site report: PM approval locks report and rolls progress onto the project', async () => {
  await as(U.pm, ({ q }) => q(`update site_reports set status = 'approved' where id = $1`, [REPORT]))
  const p = await sys(`select progress from projects where id = $1`, [P1])
  eq(Number(p[0].progress), 35, 'project progress')
  await expectError(U.eng, ({ q }) => q(`update site_reports set work_performed = 'edited' where id = $1 returning id`, [REPORT]).then((r) => { if (!r.length) throw new Error('no rows updated (locked)') }), /locked|no rows/)
})

// ----------------------------------------------------------------------------- inventory
let MAT
await test('inventory: receipts and issues maintain the balance', async () => {
  await as(U.store, async ({ one }) => {
    MAT = (await one(`insert into materials (name, unit, unit_price, min_stock) values ('Cement 50kg', 'bag', 17500, 50) returning id, code, current_stock`)).id
    await one(`insert into inventory_transactions (material_id, txn_type, quantity) values ($1, 'receipt', 100) returning balance_after`, [MAT])
    const r = await one(`insert into inventory_transactions (material_id, project_id, txn_type, quantity) values ($1, $2, 'issue', 30) returning balance_after`, [MAT, P1])
    eq(Number(r.balance_after), 70, 'balance after issue')
  })
})

await test('inventory: stock cannot go negative without authorised approval', async () => {
  await expectError(U.store, ({ q }) => q(`insert into inventory_transactions (material_id, project_id, txn_type, quantity) values ($1, $2, 'issue', 100)`, [MAT, P1]), /Insufficient stock/)
  await expectError(U.store, ({ q }) => q(`insert into inventory_transactions (material_id, project_id, txn_type, quantity, negative_override) values ($1, $2, 'issue', 100, true)`, [MAT, P1]), /requires authorised approval/)
  await as(U.pm, async ({ one }) => {
    const r = await one(`insert into inventory_transactions (material_id, project_id, txn_type, quantity, negative_override) values ($1, $2, 'issue', 100, true) returning balance_after, approved_by`, [MAT, P1])
    eq(Number(r.balance_after), -30, 'authorised negative balance')
    eq(r.approved_by, U.pm, 'approver recorded')
  })
})

await test('inventory: balances cannot be edited directly and ledger rows are immutable', async () => {
  await expectError(U.store, ({ q }) => q(`update materials set current_stock = 999 where id = $1`, [MAT]), /only change through inventory transactions/)
  // no DELETE policy exists, so through the API nothing is deleted...
  await as(U.admin, async ({ q }) => eq((await q(`delete from inventory_transactions where material_id = $1 returning id`, [MAT])).length, 0, 'rows deleted via API'))
  // ...and even with RLS bypassed (service role / SQL editor) the trigger blocks it
  let blocked = false
  try {
    await sys(`delete from inventory_transactions where material_id = $1`, [MAT])
  } catch (e) {
    blocked = /immutable/.test(e.message)
  }
  assert(blocked, 'trigger blocks ledger deletes')
})

await test('inventory: low-stock alert notifies inventory managers when crossing the minimum', async () => {
  const n = await sys(`select count(*)::int c from notifications where user_id = $1 and title like 'Low stock%'`, [U.store])
  assert(n[0].c >= 1, 'storekeeper low-stock notification')
})

// ----------------------------------------------------------------------------- procurement
let SUP, PR, PO, POI
await test('procurement: request → approval → PO → approval → GRN posts stock and updates PO', async () => {
  await as(U.proc, async ({ one }) => {
    SUP = (await one(`insert into suppliers (name) values ('Twiga Cement Ltd') returning id`)).id
  })
  await as(U.eng, async ({ one, q }) => {
    PR = (await one(`insert into purchase_requests (project_id, requested_by, status) values ($1, $2, 'draft') returning id`, [P1, U.eng])).id
    await q(`insert into purchase_request_items (request_id, material_id, description, quantity, unit, estimated_rate) values ($1, $2, 'Cement', 200, 'bag', 17000)`, [PR, MAT])
    await q(`update purchase_requests set status = 'submitted' where id = $1`, [PR])
  })
  await expectError(U.proc, ({ q }) => q(`update purchase_requests set status = 'approved' where id = $1`, [PR]), /Not authorised/)
  await as(U.md, ({ q }) => q(`update purchase_requests set status = 'approved' where id = $1`, [PR]))
  await as(U.proc, async ({ one, q }) => {
    PO = (await one(`insert into purchase_orders (supplier_id, project_id, request_id, expected_date) values ($1, $2, $3, current_date + 7) returning id`, [SUP, P1, PR])).id
    POI = (await one(`insert into purchase_order_items (po_id, material_id, description, quantity, unit, rate) values ($1, $2, 'Cement', 200, 'bag', 17000) returning id`, [PO, MAT])).id
    await q(`update purchase_orders set status = 'pending_approval' where id = $1`, [PO])
  })
  await expectError(U.proc, ({ q }) => q(`update purchase_orders set status = 'approved' where id = $1`, [PO]), /Not authorised/)
  await as(U.md, ({ q }) => q(`update purchase_orders set status = 'approved' where id = $1`, [PO]))
  await expectError(U.proc, ({ q }) => q(`update purchase_order_items set quantity = 500 where id = $1`, [POI]), /locked/)
  await as(U.store, async ({ one, q }) => {
    const g = (await one(`insert into goods_received (po_id, supplier_id, project_id) values ($1, $2, $3) returning id`, [PO, SUP, P1])).id
    await q(`insert into goods_received_items (grn_id, po_item_id, material_id, quantity_received, unit_price) values ($1, $2, $3, 120, 17000)`, [g, POI, MAT])
  })
  eq((await sys(`select status from purchase_orders where id = $1`, [PO]))[0].status, 'partially_received', 'PO status after partial GRN')
  eq(Number((await sys(`select current_stock from materials where id = $1`, [MAT]))[0].current_stock), 90, 'stock after GRN (-30 + 120)')
  await as(U.store, async ({ one, q }) => {
    const g = (await one(`insert into goods_received (po_id, supplier_id, project_id) values ($1, $2, $3) returning id`, [PO, SUP, P1])).id
    await q(`insert into goods_received_items (grn_id, po_item_id, material_id, quantity_received, unit_price) values ($1, $2, $3, 80, 17000)`, [g, POI, MAT])
  })
  eq((await sys(`select status from purchase_orders where id = $1`, [PO]))[0].status, 'received', 'PO status after full GRN')
})

await test('procurement: over-receiving beyond +10% is rejected', async () => {
  await expectError(U.store, async ({ one, q }) => {
    const g = (await one(`insert into goods_received (po_id, supplier_id) values ($1, $2) returning id`, [PO, SUP])).id
    await q(`insert into goods_received_items (grn_id, po_item_id, material_id, quantity_received) values ($1, $2, $3, 50)`, [g, POI, MAT])
  }, /Goods can only be received|exceeds ordered/)
})

// ----------------------------------------------------------------------------- finance
let TXN, INV
await test('finance: accountants cannot self-approve (segregation of duties); another accountant can', async () => {
  await as(U.acc, async ({ one }) => {
    INV = (await one(`insert into supplier_invoices (supplier_id, po_id, invoice_no, amount, tax_amount) values ($1, $2, 'TW-881', 3400000, 0) returning id`, [SUP, PO])).id
    const t = await one(`insert into financial_transactions (project_id, direction, category, amount, description, supplier_id, supplier_invoice_id, status) values ($1, 'expense', 'supplier_payment', 3400000, 'Cement payment', $2, $3, 'approved') returning id, status, number`, [P1, SUP, INV])
    TXN = t.id
    eq(t.status, 'pending', 'forced to pending')
    assert(/^PV-/.test(t.number), 'voucher number')
  })
  await expectError(U.acc, ({ q }) => q(`update financial_transactions set status = 'approved' where id = $1`, [TXN]), /Segregation of duties/)
  await as(U.acc2, ({ q }) => q(`update financial_transactions set status = 'approved' where id = $1`, [TXN]))
  eq((await sys(`select status from supplier_invoices where id = $1`, [INV]))[0].status, 'paid', 'supplier invoice paid')
})

await test('finance: approved transactions cannot be edited or deleted; void requires a reason', async () => {
  await expectError(U.acc2, ({ q }) => q(`update financial_transactions set amount = 1 where id = $1`, [TXN]), /cannot be edited/)
  await as(U.admin, async ({ q }) => eq((await q(`delete from financial_transactions where id = $1 returning id`, [TXN])).length, 0, 'rows deleted via API'))
  let blocked = false
  try {
    await sys(`delete from financial_transactions where id = $1`, [TXN])
  } catch (e) {
    blocked = /cannot be deleted/.test(e.message)
  }
  assert(blocked, 'trigger blocks finance deletes')
  await expectError(U.acc2, ({ q }) => q(`update financial_transactions set status = 'void' where id = $1`, [TXN]), /reason is required/)
  await as(U.acc2, ({ q }) => q(`update financial_transactions set status = 'void', void_reason = 'Duplicate entry' where id = $1`, [TXN]))
  eq((await sys(`select status from supplier_invoices where id = $1`, [INV]))[0].status, 'unpaid', 'invoice back to unpaid after void')
})

await test('finance: every transaction change is in the audit log; non-auditors cannot read it', async () => {
  const n = await sys(`select count(*)::int c from audit_logs where table_name = 'financial_transactions' and record_id = $1`, [TXN])
  assert(n[0].c >= 3, `audit rows ${n[0].c}`)
  await as(U.eng, async ({ q }) => eq((await q(`select * from audit_logs`)).length, 0, 'engineer audit rows'))
  await as(U.md, async ({ q }) => assert((await q(`select * from audit_logs`)).length > 0, 'MD sees audit'))
})

await test('finance: site engineers cannot see financial records', async () => {
  await as(U.acc, ({ q }) => q(`insert into financial_transactions (project_id, direction, category, amount, description) values ($1, 'income', 'client_payment', 250000000, 'IPC 1')`, [P1]))
  await as(U.eng, async ({ q }) => eq((await q(`select * from financial_transactions`)).length, 0, 'engineer finance rows'))
})

// ----------------------------------------------------------------------------- HR
let EMP
await test('HR: pay data is confidential to payroll roles', async () => {
  await as(U.hr, async ({ one, q }) => {
    EMP = (await one(`insert into employees (full_name, position) values ('Juma Mason', 'Mason') returning id, employee_no`)).id
    await q(`insert into employee_compensation (employee_id, pay_basis, daily_rate, overtime_rate) values ($1, 'daily', 25000, 4000)`, [EMP])
  })
  await as(U.eng, async ({ q }) => {
    eq((await q(`select * from employees`)).length, 1, 'engineer sees directory')
    eq((await q(`select * from employee_compensation`)).length, 0, 'engineer sees pay data')
  })
  await as(U.pm, async ({ q }) => eq((await q(`select * from employee_compensation`)).length, 0, 'PM sees pay data'))
})

await test('HR: attendance recorded on site feeds payroll generation', async () => {
  await as(U.eng, async ({ q }) => {
    for (let d = 1; d <= 5; d++) await q(`insert into attendance (employee_id, project_id, work_date, status, hours_worked, overtime_hours) values ($1, $2, current_date - $3::int, 'present', 8, 2)`, [EMP, P1, d])
  })
  await expectError(U.eng, ({ q }) => q(`select generate_payroll(current_date - 30, current_date)`), /Not authorised/)
  await as(U.hr, async ({ one }) => {
    eq((await one(`select generate_payroll(current_date - 30, current_date) as n`)).n, 1, 'payroll rows')
    const p = await one(`select basic_pay, overtime_pay, net_pay from payroll_records where employee_id = $1`, [EMP])
    eq(Number(p.basic_pay), 125000, 'basic pay = 5 days × 25,000')
    eq(Number(p.overtime_pay), 40000, 'overtime = 10h × 4,000')
    eq(Number(p.net_pay), 165000, 'net pay')
  })
})

// ----------------------------------------------------------------------------- documents & storage
await test('documents: version history increments; restricted documents are hidden', async () => {
  await as(U.eng, async ({ one, q }) => {
    const d = (await one(`insert into documents (project_id, title, category) values ($1, 'Structural drawings', 'drawing') returning id`, [P1])).id
    await q(`insert into document_versions (document_id, version, storage_path, file_name) values ($1, 0, $2, 'a.pdf')`, [d, `${P1}/${d}/a.pdf`])
    await q(`insert into document_versions (document_id, version, storage_path, file_name) values ($1, 0, $2, 'b.pdf')`, [d, `${P1}/${d}/b.pdf`])
    eq((await one(`select current_version from documents where id = $1`, [d])).current_version, 2, 'current version')
  })
  await as(U.md, ({ q }) => q(`insert into documents (project_id, title, category, access_level) values ($1, 'Contract (signed)', 'contract', 'restricted')`, [P1]))
  await as(U.eng, async ({ q }) => eq((await q(`select * from documents where access_level = 'restricted'`)).length, 0, 'restricted visible to engineer'))
})

await test('storage: uploads are limited to projects the user can access', async () => {
  await as(U.eng, ({ q }) => q(`insert into storage.objects (bucket_id, name) values ('site-photos', $1)`, [`${P1}/r1/photo.jpg`]))
  await expectError(U.eng, ({ q }) => q(`insert into storage.objects (bucket_id, name) values ('site-photos', $1)`, [`${P2}/r1/photo.jpg`]), /row-level security/)
  await expectError(U.eng, ({ q }) => q(`insert into storage.objects (bucket_id, name) values ('site-photos', 'not-a-uuid/x.jpg')`), /row-level security/)
})

// ----------------------------------------------------------------------------- tasks & notifications
await test('tasks: assignment notifies; completing sets 100% and completed_at; overdue reminders are idempotent', async () => {
  let T
  await as(U.pm, async ({ one }) => {
    T = (await one(`insert into tasks (project_id, title, assigned_to, due_date) values ($1, 'Submit shop drawings', $2, current_date - 2) returning id`, [P1, U.eng])).id
  })
  eq((await sys(`select count(*)::int c from notifications where user_id = $1 and type = 'task'`, [U.eng]))[0].c, 1, 'task notification')
  const a = (await sys(`select notify_overdue_tasks() n`))[0].n
  const b = (await sys(`select notify_overdue_tasks() n`))[0].n
  eq(a, 1, 'first overdue run')
  eq(b, 0, 'second overdue run (idempotent)')
  await as(U.eng, async ({ one }) => {
    const r = await one(`update tasks set status = 'done' where id = $1 returning progress, completed_at`, [T])
    eq(r.progress, 100, 'progress')
    assert(r.completed_at, 'completed_at set')
  })
  await as(U.eng2, async ({ q }) => eq((await q(`select * from notifications where user_id = $1`, [U.eng])).length, 0, "reading someone else's notifications"))
})

// ----------------------------------------------------------------------------- analytics
await test('dashboard & analytics RPCs run under RLS for each role', async () => {
  await as(U.md, async ({ one, q }) => {
    const s = (await one(`select dashboard_summary() s`)).s
    eq(s.projects.active, 2, 'MD active projects')
    assert(s.finance !== null, 'MD sees finance block')
    assert((await q(`select * from monthly_finance(12)`)).length === 12, 'monthly_finance rows')
    assert((await q(`select * from workforce_productivity(14)`)).length === 14, 'workforce rows')
    assert((await q(`select * from recent_activity(20)`)).length > 0, 'activity rows')
    const pf = await q(`select * from project_financials where project_id = $1`, [P1])
    eq(Number(pf[0].income_received), 0, 'pending income not counted')
  })
  await as(U.eng, async ({ one, q }) => {
    const s = (await one(`select dashboard_summary() s`)).s
    eq(s.projects.active, 1, 'engineer active projects')
    eq(s.finance, null, 'engineer finance block hidden')
    const acts = await q(`select table_name from recent_activity(100)`)
    assert(!acts.some((a) => a.table_name === 'financial_transactions'), 'engineer sees finance activity')
  })
})

await test('deactivating a user immediately revokes access', async () => {
  await as(U.admin, ({ q }) => q(`update profiles set is_active = false where id = $1`, [U.eng]))
  await as(U.eng, async ({ q }) => {
    eq((await q(`select * from projects`)).length, 0, 'deactivated projects')
    eq((await q(`select * from site_reports`)).length, 0, 'deactivated reports')
  })
})

await test('anonymous (signed-out) requests cannot read business data', async () => {
  let blocked = false
  try {
    await db.transaction(async (tx) => {
      await tx.exec(`set local role anon`)
      await tx.query(`select * from projects`)
    })
  } catch (e) {
    blocked = /permission denied/.test(e.message)
  }
  assert(blocked, 'anon can select projects')
})

await test('demo seed loads cleanly and every seeded record is flagged as demo', async () => {
  await db.exec(readFileSync(join(root, 'supabase/seed.sql'), 'utf8'))
  for (const t of ['projects', 'clients', 'materials', 'suppliers', 'employees', 'equipment', 'boqs', 'tasks']) {
    const r = await sys(`select count(*) filter (where is_demo)::int d, count(*) filter (where name_col like '[DEMO]%')::int n from (select is_demo, ${t === 'employees' ? 'full_name' : t === 'boqs' || t === 'tasks' ? 'title' : 'name'} as name_col from ${t} where is_demo) x`)
    assert(r[0].d > 0, `${t}: no demo rows`)
    eq(r[0].n, r[0].d, `${t}: demo rows without [DEMO] prefix`)
  }
  const s = await sys(`select current_stock from materials where name like '[DEMO] Portland%'`)
  eq(Number(s[0].current_stock), 230, 'demo cement balance (650 − 420)')
})

// -----------------------------------------------------------------------------
console.log('')
for (const r of results) console.log(`${r[0] === 'PASS' ? '  ✓' : '  ✗'} ${r[1]}${r[2] ? `\n      → ${r[2]}` : ''}`)
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
