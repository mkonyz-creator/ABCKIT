/**
 * [DEMO] sample data — TypeScript port of legacy-supabase/seed.sql.
 * Runs through the real engine and business rules (numbering, stock ledger, totals, notifications),
 * so the demo behaves like production. Used ONLY by Demo Mode; production starts empty.
 */
import type { createDb } from './client'
import { DEMO_FILES } from './demoFiles'

type Db = ReturnType<typeof createDb>

function day(offset: number) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function monthDay(monthsBack: number, dayOfMonth: number) {
  const d = new Date()
  const x = new Date(d.getFullYear(), d.getMonth() - monthsBack, dayOfMonth)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

async function one<T = any>(p: PromiseLike<{ data: any; error: { message: string; code?: string } | null }>, what: string): Promise<T> {
  const r = await p
  if (r.error) throw new Error(`[demo seed] ${what}: ${r.error.message}`)
  return r.data as T
}

export async function seedDemoData(db: Db, asUser: (uid: string) => Db) {
  const ins = (table: string, row: Record<string, unknown>) => one(db.from(table).insert(row).select().single(), table)
  const insMany = (table: string, rows: Record<string, unknown>[]) => one(db.from(table).insert(rows).select(), table)

  // Clients & projects
  const c1 = await ins('clients', { name: '[DEMO] Kilimani Developers Ltd', client_type: 'company', contact_person: 'Grace Mushi', phone: '+255 700 000 001', email: 'demo.client@example.com', is_demo: true })
  const c2 = await ins('clients', { name: '[DEMO] Municipal Council (sample)', client_type: 'government', contact_person: 'Procurement Unit', phone: '+255 700 000 002', is_demo: true })
  const p1 = await ins('projects', {
    name: '[DEMO] 4-Storey Office Block', client_id: c1.id, location: 'Plot 12, Mikocheni', region: 'Dar es Salaam', start_date: day(-150), end_date: day(210),
    contract_value: 2450000000, budget: 2050000000, status: 'active', progress: 38, project_manager_id: 'demo-project_manager',
    description: 'Sample project: reinforced concrete frame office building, 4 floors + roof.', is_demo: true,
  })
  const p2 = await ins('projects', {
    name: '[DEMO] Health Centre Renovation', client_id: c2.id, location: 'Kibaha', region: 'Pwani', start_date: day(-60), end_date: day(60),
    contract_value: 680000000, budget: 590000000, status: 'active', progress: 55, project_manager_id: 'demo-project_manager', is_demo: true,
  })
  await ins('projects', {
    name: '[DEMO] Warehouse Extension', client_id: c1.id, location: 'Mbezi', region: 'Dar es Salaam', start_date: day(30), end_date: day(240),
    contract_value: 1200000000, budget: 1010000000, status: 'planning', progress: 0, is_demo: true,
  })
  // site staff only see the projects they are members of
  for (const [uid, role] of [
    ['demo-site_engineer', 'site_engineer'],
    ['demo-site_supervisor', 'supervisor'],
    ['demo-employee', 'member'],
  ] as const)
    await ins('project_members', { project_id: p1.id, user_id: uid, member_role: role })
  await ins('project_members', { project_id: p2.id, user_id: 'demo-site_engineer', member_role: 'site_engineer' })

  // BOQ for project 1
  const b1 = await ins('boqs', { project_id: p1.id, title: '[DEMO] Main building – Contract BOQ', is_demo: true })
  const secA = await ins('boq_sections', { boq_id: b1.id, code: 'A', title: 'Preliminaries', sort_order: 1 })
  const secB = await ins('boq_sections', { boq_id: b1.id, code: 'B', title: 'Substructure', sort_order: 2 })
  const secC = await ins('boq_sections', { boq_id: b1.id, code: 'C', title: 'Frame & slabs', sort_order: 3 })
  const items: Array<[any, string, string, string, number, number, number]> = [
    [secA, 'A1', 'Site establishment, hoarding and temporary works', 'sum', 1, 45000000, 1],
    [secA, 'A2', 'Insurances and performance bond', 'sum', 1, 18500000, 2],
    [secB, 'B1', 'Excavate foundation trenches not exceeding 1.5 m deep', 'm³', 420, 9500, 1],
    [secB, 'B2', 'Blinding concrete C10, 50 mm thick', 'm²', 610, 14500, 2],
    [secB, 'B3', 'Reinforced concrete C25 in pad footings', 'm³', 96, 395000, 3],
    [secB, 'B4', 'High-yield steel bars Y12–Y16 in footings', 'kg', 7800, 3600, 4],
    [secC, 'C1', 'Reinforced concrete C25 in columns', 'm³', 88, 425000, 1],
    [secC, 'C2', 'Reinforced concrete C25 in suspended slabs 200 mm', 'm³', 540, 410000, 2],
    [secC, 'C3', 'Formwork to soffits of slabs', 'm²', 2700, 28500, 3],
  ]
  await insMany(
    'boq_items',
    items.map(([sec, item_code, description, unit, quantity, rate, sort_order]) => ({ boq_id: b1.id, section_id: sec.id, item_code, description, unit, quantity, rate, sort_order })),
  )

  // Materials & stock (categories are seeded at bootstrap)
  const cats = await one<any[]>(db.from('material_categories').select('id,name'), 'material_categories')
  const cat = (name: string) => cats.find((c) => c.name === name)?.id ?? null
  const mat = (name: string, category: string, unit: string, unit_price: number, min_stock: number) =>
    ins('materials', { name, category_id: cat(category), unit, unit_price, min_stock, is_demo: true })
  const mCement = await mat('[DEMO] Portland cement 42.5N (50 kg)', 'Cement & Binders', 'bag', 17500, 200)
  const mSand = await mat('[DEMO] River sand', 'Aggregates', 'tonne', 38000, 40)
  const mY12 = await mat('[DEMO] Y12 deformed bar (12 m)', 'Steel & Reinforcement', 'pc', 26500, 150)
  const mBlock = await mat('[DEMO] Concrete block 150 mm', 'Blocks & Bricks', 'No.', 1450, 2000)
  const mDiesel = await mat('[DEMO] Diesel', 'Fuel & Lubricants', 'litre', 3150, 500)
  for (const [m, q] of [[mCement, 650], [mSand, 120], [mY12, 900], [mBlock, 9000], [mDiesel, 1800]] as const)
    await ins('inventory_transactions', { material_id: m.id, txn_type: 'opening', quantity: q, reference: 'DEMO opening', transaction_date: day(-40) })
  for (const [m, p, q, d] of [[mCement, p1, 420, -20], [mSand, p1, 95, -18], [mY12, p1, 610, -15], [mBlock, p2, 3500, -10], [mDiesel, p1, 1450, -5]] as const)
    await ins('inventory_transactions', { material_id: m.id, project_id: p.id, txn_type: 'issue', quantity: q, reference: 'DEMO issue', transaction_date: day(d) })

  // Suppliers
  await ins('suppliers', { name: '[DEMO] Sample Cement Distributors', category: 'Cement & aggregates', contact_person: 'J. Mollel', phone: '+255 700 000 010', rating: 4, payment_terms: '30 days', is_demo: true })
  await ins('suppliers', { name: '[DEMO] Sample Steel Traders', category: 'Steel', contact_person: 'R. Patel', phone: '+255 700 000 011', rating: 3, payment_terms: '14 days', is_demo: true })

  // Employees (Joseph Lema = the demo "Employee" account, for self-service screens)
  const e1 = await ins('employees', { full_name: '[DEMO] Juma Hamisi', gender: 'male', position: 'Foreman', department: 'Site Operations', employment_type: 'permanent', hire_date: day(-900), phone: '+255 700 000 101', is_demo: true })
  const e2 = await ins('employees', { full_name: '[DEMO] Neema Joseph', gender: 'female', position: 'Site Engineer', department: 'Engineering', employment_type: 'permanent', hire_date: day(-500), is_demo: true })
  const e3 = await ins('employees', { full_name: '[DEMO] Baraka Said', gender: 'male', position: 'Mason', department: 'Site Operations', employment_type: 'casual', hire_date: day(-120), is_demo: true })
  await ins('employees', { full_name: '[DEMO] Joseph Lema', gender: 'male', position: 'Store assistant', department: 'Stores', employment_type: 'permanent', hire_date: day(-300), profile_id: 'demo-employee', is_demo: true })
  await ins('employee_compensation', { employee_id: e1.id, pay_basis: 'monthly', basic_salary: 1200000, overtime_rate: 7500 })
  await ins('employee_compensation', { employee_id: e2.id, pay_basis: 'monthly', basic_salary: 2400000, overtime_rate: 0 })
  await ins('employee_compensation', { employee_id: e3.id, pay_basis: 'daily', daily_rate: 25000, overtime_rate: 4000 })
  await ins('employee_assignments', { employee_id: e1.id, project_id: p1.id, role: 'Foreman', start_date: day(-150) })
  await ins('employee_assignments', { employee_id: e3.id, project_id: p1.id, role: 'Mason', start_date: day(-120) })
  await ins('employee_assignments', { employee_id: e2.id, project_id: p2.id, role: 'Site engineer', start_date: day(-60) })
  const att: Record<string, unknown>[] = []
  for (let i = 1; i <= 12; i++) {
    att.push({ employee_id: e1.id, project_id: p1.id, work_date: day(-i), status: i % 7 === 0 ? 'off' : 'present', hours_worked: i % 7 === 0 ? 0 : 8, overtime_hours: i % 3 === 0 ? 2 : 0 })
    att.push({ employee_id: e3.id, project_id: p1.id, work_date: day(-i), status: i % 5 === 0 ? 'absent' : 'present', hours_worked: i % 5 === 0 ? 0 : 8, overtime_hours: 0 })
  }
  await insMany('attendance', att)

  // Equipment
  const eq1 = await ins('equipment', { name: '[DEMO] Excavator 20t', category: 'earthmoving', make: 'Sample', model: 'EX200', registration_no: 'T 000 AAA', ownership: 'owned', hourly_rate: 95000, status: 'available', is_demo: true })
  const eq2 = await ins('equipment', { name: '[DEMO] Concrete mixer 350L', category: 'concrete', make: 'Sample', model: 'CM350', ownership: 'owned', hourly_rate: 12000, status: 'available', is_demo: true })
  await ins('equipment_assignments', { equipment_id: eq1.id, project_id: p1.id, start_date: day(-30) })
  await ins('equipment_assignments', { equipment_id: eq2.id, project_id: p1.id, start_date: day(-30) })
  for (let i = 1; i <= 10; i++)
    await ins('equipment_usage_logs', { equipment_id: eq1.id, project_id: p1.id, usage_date: day(-i), operator_name: 'DEMO operator', hours_operated: 6 + (i % 3), idle_hours: 1, fuel_litres: 85, fuel_cost: 85 * 3150 })
  await ins('maintenance_records', { equipment_id: eq1.id, maintenance_type: 'scheduled', scheduled_date: day(-25), completed_date: day(-25), description: '[DEMO] 500-hour service', cost: 1450000, downtime_hours: 6, status: 'completed', is_demo: true })

  // Finance: recorded by the accountant, approved by the managing director (segregation of duties)
  const accountant = asUser('demo-accountant')
  const md = asUser('demo-managing_director')
  const inv1 = await one<any>(
    accountant.from('client_invoices').insert({ project_id: p1.id, client_id: c1.id, invoice_type: 'interim_certificate', invoice_date: day(-35), amount: 480000000, tax_amount: 86400000, retention: 24000000, description: '[DEMO] Interim Payment Certificate No. 1', is_demo: true }).select().single(),
    'client_invoices',
  )
  const txns: Record<string, unknown>[] = [
    { project_id: p1.id, direction: 'income', category: 'advance_payment', amount: 245000000, transaction_date: day(-140), payment_method: 'bank_transfer', payee_payer: '[DEMO] Kilimani Developers', description: '[DEMO] 10% advance payment' },
    { project_id: p1.id, direction: 'income', category: 'client_payment', amount: 420000000, transaction_date: day(-20), payment_method: 'bank_transfer', payee_payer: '[DEMO] Kilimani Developers', description: '[DEMO] Part payment IPC 1', client_invoice_id: inv1.id },
    { project_id: p2.id, direction: 'income', category: 'client_payment', amount: 150000000, transaction_date: day(-15), payment_method: 'bank_transfer', payee_payer: '[DEMO] Municipal Council', description: '[DEMO] IPC 1' },
  ]
  for (let i = 0; i <= 5; i++)
    txns.push(
      { project_id: p1.id, direction: 'expense', category: 'material', amount: 38000000 + i * 4100000, transaction_date: monthDay(i, 6), payment_method: 'bank_transfer', payee_payer: '[DEMO] Supplier', description: '[DEMO] Materials purchase' },
      { project_id: p1.id, direction: 'expense', category: 'labour', amount: 21000000 + i * 1500000, transaction_date: monthDay(i, 28), payment_method: 'mobile_money', payee_payer: '[DEMO] Casual labour', description: '[DEMO] Labour payroll' },
      { project_id: p1.id, direction: 'expense', category: 'equipment', amount: 6500000, transaction_date: monthDay(i, 13), payment_method: 'cash', payee_payer: '[DEMO] Fuel station', description: '[DEMO] Plant fuel' },
      { project_id: p2.id, direction: 'expense', category: 'material', amount: 12000000 + i * 900000, transaction_date: monthDay(i, 10), payment_method: 'bank_transfer', payee_payer: '[DEMO] Supplier', description: '[DEMO] Materials' },
    )
  const today = day(0)
  for (const t of txns) {
    // future-dated rows (early in the month) are moved to today
    if (String(t.transaction_date) > today) t.transaction_date = today
    const row = await one<any>(accountant.from('financial_transactions').insert({ ...t, is_demo: true }).select().single(), 'financial_transactions')
    await one(md.from('financial_transactions').update({ status: 'approved' }).eq('id', row.id).select().single(), 'approve transaction')
  }
  await one(
    accountant.from('financial_transactions').insert({ project_id: p1.id, direction: 'expense', category: 'petty_cash', amount: 350000, payment_method: 'cash', payee_payer: '[DEMO] Site office', description: '[DEMO] Stationery and drinking water', is_demo: true }),
    'petty cash',
  )

  // Tasks
  await insMany('tasks', [
    { project_id: p1.id, title: '[DEMO] Complete first-floor slab casting', priority: 'high', status: 'in_progress', start_date: day(-10), due_date: day(5), progress: 60, is_milestone: true, assigned_to: 'demo-site_engineer', is_demo: true },
    { project_id: p1.id, title: '[DEMO] Submit IPC No. 2 to consultant', priority: 'medium', status: 'todo', start_date: day(0), due_date: day(12), progress: 0, is_milestone: false, assigned_to: 'demo-quantity_surveyor', is_demo: true },
    { project_id: p1.id, title: '[DEMO] Renew building permit', priority: 'critical', status: 'todo', start_date: day(-5), due_date: day(-1), progress: 0, is_milestone: false, assigned_to: 'demo-project_manager', is_demo: true },
    { project_id: p2.id, title: '[DEMO] Replace roofing sheets – Ward B', priority: 'high', status: 'in_progress', start_date: day(-7), due_date: day(9), progress: 40, is_milestone: false, is_demo: true },
  ])

  await ins('safety_incidents', {
    project_id: p1.id, incident_date: day(-8), severity: 'near_miss', category: 'Struck by object',
    description: '[DEMO] Unsecured plank fell from scaffold level 2; no injury.', action_taken: 'Toe boards installed; toolbox talk held.', status: 'closed', is_demo: true,
  })

  // Documents with sample files (the files are generated on first download — demoFiles.ts)
  for (const f of DEMO_FILES) {
    const doc = await ins('documents', {
      project_id: f.project === 'office' ? p1.id : p2.id, title: f.title, category: f.category, description: f.description,
      tags: f.tags, access_level: 'project', is_demo: true,
    })
    await ins('document_versions', {
      document_id: doc.id, version: 0, storage_path: f.path, file_name: f.file_name, mime_type: f.mime, size_bytes: f.approx_bytes, change_note: '[DEMO] sample file',
    })
  }
}
