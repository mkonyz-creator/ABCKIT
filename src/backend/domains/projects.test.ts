/**
 * Projects domain — the projects / BOQ / documents / tasks scenarios of legacy-supabase/tests/db/run.mjs plus
 * the trigger logic of …0200_projects_boq.sql and …0400 (documents, tasks), on the in-memory store with the
 * real engine + hooks. Security rules are not evaluated here (see firebase/rules/20_projects.rules).
 */
import { describe, expect, it } from 'vitest'
import { createTestDb, ok } from '../testing'
import { formatDay } from './projects'

function setup() {
  const t = createTestDb()
  const U = {
    admin: t.addUser('super_admin'),
    md: t.addUser('managing_director'),
    pm: t.addUser('project_manager'),
    eng: t.addUser('site_engineer'),
    eng2: t.addUser('site_engineer'),
    qs: t.addUser('quantity_surveyor'),
    emp: t.addUser('employee'),
  }
  return { t, U }
}

async function withProjects() {
  const s = setup()
  const { t, U } = s
  let db = t.as(U.pm)
  const client = ok(await db.from('clients').insert({ name: 'Ministry of Works' }).select().single())
  const p1 = ok(
    await db
      .from('projects')
      .insert({ name: 'Office Block A', client_id: client.id, contract_value: 1e9, budget: 8e8, status: 'active', project_manager_id: U.pm })
      .select()
      .single(),
  )
  ok(await db.from('project_members').insert({ project_id: p1.id, user_id: U.eng, member_role: 'site_engineer' }))
  db = t.as(U.admin)
  const p2 = ok(await db.from('projects').insert({ name: 'Warehouse B', status: 'active' }).select().single())
  return { ...s, client, P1: p1.id as string, P2: p2.id as string, p1 }
}

async function withBoq() {
  const s = await withProjects()
  const db = s.t.as(s.U.pm)
  const boq = ok(await db.from('boqs').insert({ project_id: s.P1, title: 'Tender BOQ', taxes: [{ name: 'VAT', rate: 18 }] }).select().single())
  const sec = ok(await db.from('boq_sections').insert({ boq_id: boq.id, code: 'A', title: 'Substructure', sort_order: 1 }).select().single())
  const item = ok(
    await db.from('boq_items').insert({ section_id: sec.id, description: 'Excavation', unit: 'm³', quantity: 120.5, rate: 8500 }).select().single(),
  )
  ok(await db.from('boq_items').insert({ section_id: sec.id, description: 'Concrete C25', unit: 'm³', quantity: 45, rate: 320000, sort_order: 2 }))
  return { ...s, BOQ: boq.id as string, boq, SEC: sec.id as string, ITEM: item.id as string, item }
}

const notes = (t: ReturnType<typeof createTestDb>, user: string) => t.raw.all('notifications').filter((n) => n.user_id === user)
const daysFromToday = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ============================================================================ clients & projects

describe('clients & projects', () => {
  it('PM creates client & project; code auto-numbered; clients audited', async () => {
    const { t, p1, client } = await withProjects()
    expect(p1.code).toMatch(new RegExp(`^PRJ-${new Date().getFullYear()}-0001$`))
    expect(client.client_type).toBe('company')
    const logs = t.raw.all('audit_logs')
    expect(logs.some((l) => l.table_name === 'clients' && l.action === 'INSERT')).toBe(true)
    expect(logs.some((l) => l.table_name === 'projects' && l.record_id === p1.id)).toBe(true)
  })

  it('the project manager is listed as a member with the denormalised role / permissions storage.rules needs', async () => {
    const { t, U, P1 } = await withProjects()
    const m = t.raw.get('project_members', `${P1}__${U.pm}`)!
    expect(m.member_role).toBe('project_manager')
    expect(m.role_id).toBe('project_manager')
    expect(m.perms).toEqual(t.raw.get('roles', 'project_manager')!.perms)
    const e = t.raw.get('project_members', `${P1}__${U.eng}`)!
    expect(e.perms).toContain('site.report')
    // re-assigning the PM adds the new PM too
    ok(await t.as(U.admin).from('projects').update({ project_manager_id: U.eng2 }).eq('id', P1))
    expect(t.raw.get('project_members', `${P1}__${U.eng2}`)?.member_role).toBe('project_manager')
  })

  it('role changes and permission-matrix edits re-sync the members’ denormalised permissions', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.admin)
    ok(await db.from('profiles').update({ role_id: 'quantity_surveyor' }).eq('id', U.eng))
    let m = t.raw.get('project_members', `${P1}__${U.eng}`)!
    expect(m.role_id).toBe('quantity_surveyor')
    expect(m.perms).toContain('boq.manage')
    ok(await db.from('role_permissions').delete().match({ role_id: 'quantity_surveyor', permission_id: 'boq.manage' }))
    m = t.raw.get('project_members', `${P1}__${U.eng}`)!
    expect(m.perms).not.toContain('boq.manage')
  })

  it('employee role cannot create projects; CHECK constraints are enforced', async () => {
    const { t, U } = setup()
    const denied = await t.as(U.emp).from('projects').insert({ name: 'Nope' })
    expect(denied.error?.message).toMatch(/row-level security/)
    const db = t.as(U.admin)
    expect((await db.from('projects').insert({ name: 'X' })).error?.code).toBe('23514')
    expect((await db.from('projects').insert({ name: 'Dates', start_date: '2026-05-01', end_date: '2026-04-01' })).error?.code).toBe('23514')
    expect((await db.from('projects').insert({ name: 'Money', budget: -1 })).error?.code).toBe('23514')
    expect((await db.from('clients').insert({ name: 'Bad mail', email: 'nope' })).error?.code).toBe('23514')
    expect((await db.from('clients').insert({ name: null })).error?.code).toBe('23502')
  })

  it('site engineer only sees projects they are a member of; MD sees all; PM sees managed projects', async () => {
    const { t, U, P1 } = await withProjects()
    const eng = ok(await t.as(U.eng).from('projects').select('id'))
    expect(eng.map((r) => r.id)).toEqual([P1])
    expect(ok(await t.as(U.eng2).from('projects').select('id'))).toHaveLength(0)
    expect(ok(await t.as(U.md).from('projects').select('id'))).toHaveLength(2)
    expect(ok(await t.as(U.pm).from('projects').select('id')).map((r) => r.id)).toEqual([P1])
    expect(ok(await t.as(U.eng).rpc('my_project_ids'))).toEqual([P1])
    expect(ok(await t.as(U.eng2).rpc('can_access_project', { pid: P1 }))).toBe(false)
  })

  it('only super admins delete projects; deletion cascades through BOQs, documents, tasks and members', async () => {
    const { t, U, P1, BOQ } = await withBoq()
    let db = t.as(U.eng)
    const doc = ok(await db.from('documents').insert({ project_id: P1, title: 'Drawings' }).select().single())
    ok(await db.from('document_versions').insert({ document_id: doc.id, version: 0, storage_path: `${P1}/${doc.id}/a.pdf`, file_name: 'a.pdf' }))
    ok(await t.as(U.pm).from('tasks').insert({ project_id: P1, title: 'Pour slab', assigned_to: U.eng }))
    ok(await t.as(U.md).from('boqs').update({ status: 'approved' }).eq('id', BOQ))
    db = t.as(U.pm)
    const denied = await db.from('projects').delete().eq('id', P1)
    expect(denied.error?.message).toMatch(/row-level security/)
    db = t.as(U.admin)
    ok(await db.from('projects').delete().eq('id', P1))
    for (const table of ['boqs', 'boq_sections', 'boq_items', 'documents', 'document_versions', 'tasks'])
      expect(t.raw.all(table).filter((r) => r.project_id === P1), table).toHaveLength(0)
    expect(t.raw.all('project_members').filter((r) => r.project_id === P1)).toHaveLength(0)
  })

  it('deleting a client clears the project link (ON DELETE SET NULL)', async () => {
    const { t, U, P1, client } = await withProjects()
    ok(await t.as(U.pm).from('clients').delete().eq('id', client.id))
    expect(t.raw.get('projects', P1)!.client_id).toBeNull()
  })

  it('site-report approvers may roll progress onto a project, but not edit it otherwise', async () => {
    const { t, U, P1 } = await withProjects()
    t.raw.put('roles', 'site_approver', { id: 'site_approver', key: 'site_approver', name: 'Site approver', is_system: false, perms: ['projects.view', 'site.approve'] })
    const approver = t.addUser('site_approver')
    ok(await t.as(U.pm).from('project_members').insert({ project_id: P1, user_id: approver, member_role: 'supervisor' }))
    const db = t.as(approver)
    ok(await db.from('projects').update({ progress: 40 }).eq('id', P1))
    expect(t.raw.get('projects', P1)!.progress).toBe(40)
    expect((await db.from('projects').update({ name: 'Renamed' }).eq('id', P1)).error?.message).toMatch(/row-level security/)
  })
})

// ============================================================================ BOQ

describe('BOQ', () => {
  it('amounts, section totals, taxes and grand total are computed', async () => {
    const { t, U, BOQ, P1, item, boq } = await withBoq()
    expect(boq.number).toMatch(/^BOQ-/)
    expect(item.amount).toBe(1024250)
    expect(item.boq_id).toBe(BOQ)
    expect(item.project_id).toBe(P1)
    const sub = 120.5 * 8500 + 45 * 320000
    const [tot] = ok(await t.as(U.pm).from('boq_totals').select('*').eq('boq_id', BOQ))
    expect(tot).toMatchObject({ boq_id: BOQ, project_id: P1, subtotal: sub, tax_rate_total: 18, item_count: 2 })
    expect(tot.tax_amount).toBe(Math.round(sub * 0.18 * 100) / 100)
    expect(tot.grand_total).toBe(Math.round(sub * 1.18 * 100) / 100)
    // amount follows quantity × rate on update; generated column cannot be written
    const upd = ok(await t.as(U.pm).from('boq_items').update({ quantity: 2, rate: 10.005, amount: 999 }).eq('id', item.id).select().single())
    expect(upd.amount).toBe(20.01)
  })

  it('PM cannot approve; MD approves (stamped); approved BOQ is locked; revision copy works', async () => {
    const { t, U, BOQ, SEC, ITEM } = await withBoq()
    const pm = t.as(U.pm)
    const no = await pm.from('boqs').update({ status: 'approved' }).eq('id', BOQ)
    expect(no.error?.message).toMatch(/Not authorised to approve BOQs/)
    ok(await pm.from('boqs').update({ status: 'submitted' }).eq('id', BOQ))
    ok(await t.as(U.md).from('boqs').update({ status: 'approved' }).eq('id', BOQ))
    const approved = t.raw.get('boqs', BOQ)!
    expect(approved.approved_by).toBe(U.md)
    expect(approved.approved_at).toBeTruthy()

    const db = t.as(U.pm)
    expect((await db.from('boq_items').update({ quantity: 1 }).eq('id', ITEM)).error?.message).toMatch(/locked/)
    expect((await db.from('boq_items').insert({ section_id: SEC, description: 'x' })).error?.message).toMatch(/locked/)
    expect((await db.from('boq_items').delete().eq('id', ITEM)).error?.message).toMatch(/locked/)
    expect((await db.from('boq_sections').update({ title: 'Changed' }).eq('id', SEC)).error?.message).toMatch(/locked/)
    expect((await db.from('boq_sections').insert({ boq_id: BOQ, title: 'New' })).error?.message).toMatch(/locked/)
    expect((await db.from('boqs').update({ taxes: [] }).eq('id', BOQ)).error?.message).toMatch(/locked/)
    expect((await db.from('boqs').update({ status: 'draft' }).eq('id', BOQ)).error?.message).toMatch(/locked/)
    expect(t.raw.get('boq_items', ITEM)!.quantity).toBe(120.5)

    const id = ok(await db.rpc('duplicate_boq', { p_boq: BOQ })) as string
    const copy = t.raw.get('boqs', id)!
    expect(copy).toMatchObject({ status: 'draft', title: 'Tender BOQ (Revision)', approved_by: null, project_id: approved.project_id })
    expect(copy.number).not.toBe(approved.number)
    const [tot] = ok(await db.from('boq_totals').select('item_count,subtotal').eq('boq_id', id))
    expect(tot.item_count).toBe(2)
    const items = t.raw.all('boq_items').filter((i) => i.boq_id === id)
    expect(new Set(items.map((i) => i.section_id)).size).toBe(1)
    expect(items[0].section_id).not.toBe(SEC)

    // approvers may mark an approved BOQ superseded (and nothing else)
    expect((await db.from('boqs').update({ status: 'superseded' }).eq('id', BOQ)).error?.message).toMatch(/supersede/)
    ok(await t.as(U.md).from('boqs').update({ status: 'superseded' }).eq('id', BOQ))
    expect(t.raw.get('boqs', BOQ)!.approved_by).toBe(U.md)
  })

  it('approval stamps cannot be forged and a BOQ cannot change project', async () => {
    const { t, U, BOQ, P2 } = await withBoq()
    const db = t.as(U.pm)
    const r = ok(await db.from('boqs').update({ approved_by: U.pm, approved_at: '2026-01-01T00:00:00Z', title: 'Renamed' }).eq('id', BOQ).select().single())
    expect(r).toMatchObject({ approved_by: null, approved_at: null, title: 'Renamed' })
    expect((await t.as(U.admin).from('boqs').update({ project_id: P2 }).eq('id', BOQ)).error?.code).toBe('42501')
  })

  it('an engineer (view only) cannot add items; non-members cannot see the BOQ', async () => {
    const { t, U, SEC, BOQ } = await withBoq()
    const add = await t.as(U.eng).from('boq_items').insert({ section_id: SEC, description: 'x' })
    expect(add.error?.message).toMatch(/row-level security|locked/)
    expect(ok(await t.as(U.eng).from('boq_items').select('id').eq('boq_id', BOQ))).toHaveLength(2)
    expect(ok(await t.as(U.eng2).from('boq_items').select('id').eq('boq_id', BOQ))).toHaveLength(0)
    expect(ok(await t.as(U.eng2).from('boq_totals').select('*'))).toHaveLength(0)
  })

  it('an approved BOQ can still be deleted as a whole (sections / items cascade), like PostgreSQL', async () => {
    const { t, U, BOQ, SEC } = await withBoq()
    ok(await t.as(U.md).from('boqs').update({ status: 'approved' }).eq('id', BOQ))
    expect((await t.as(U.pm).from('boq_sections').delete().eq('id', SEC)).error?.message).toMatch(/locked/)
    ok(await t.as(U.pm).from('boqs').delete().eq('id', BOQ))
    expect(t.raw.all('boq_sections')).toHaveLength(0)
    expect(t.raw.all('boq_items')).toHaveLength(0)
  })

  it('deleting a section deletes its items; moving an item re-derives its BOQ', async () => {
    const { t, U, BOQ, SEC, ITEM } = await withBoq()
    const db = t.as(U.pm)
    const sec2 = ok(await db.from('boq_sections').insert({ boq_id: BOQ, code: 'B', title: 'Superstructure', sort_order: 2 }).select().single())
    expect(sec2.project_id).toBe(t.raw.get('boqs', BOQ)!.project_id)
    ok(await db.from('boq_items').update({ section_id: sec2.id }).eq('id', ITEM))
    expect(t.raw.get('boq_items', ITEM)!.boq_id).toBe(BOQ)
    ok(await db.from('boq_sections').delete().eq('id', SEC))
    expect(t.raw.all('boq_items').map((i) => i.id)).toEqual([ITEM])
  })
})

// ============================================================================ documents

describe('documents', () => {
  it('version history increments and updates the document; restricted documents are hidden', async () => {
    const { t, U, P1 } = await withProjects()
    let db = t.as(U.eng)
    const d = ok(await db.from('documents').insert({ project_id: P1, title: 'Structural drawings', category: 'drawing', current_version: 9 }).select().single())
    expect(d.current_version).toBe(0)
    ok(await db.from('document_versions').insert({ document_id: d.id, version: 0, storage_path: `${P1}/${d.id}/a.pdf`, file_name: 'a.pdf', size_bytes: 10 }))
    const v2 = ok(
      await db.from('document_versions').insert({ document_id: d.id, version: 0, storage_path: `${P1}/${d.id}/b.pdf`, file_name: 'b.pdf', mime_type: 'application/pdf' }).select().single(),
    )
    expect(v2).toMatchObject({ version: 2, project_id: P1, access_level: 'project', uploaded_by: U.eng })
    expect(t.raw.get('documents', d.id)).toMatchObject({ current_version: 2, current_path: `${P1}/${d.id}/b.pdf`, file_name: 'b.pdf', mime_type: 'application/pdf' })
    // current_* only move with a new version
    ok(await db.from('documents').update({ current_version: 7, title: 'Structural drawings rev' }).eq('id', d.id))
    expect(t.raw.get('documents', d.id)!.current_version).toBe(2)

    ok(await t.as(U.md).from('documents').insert({ project_id: P1, title: 'Contract (signed)', category: 'contract', access_level: 'restricted' }))
    ok(await t.as(U.md).from('documents').insert({ project_id: P1, title: 'Board minutes', category: 'other', access_level: 'management' }))
    db = t.as(U.eng)
    expect(ok(await db.from('documents').select('*').eq('access_level', 'restricted'))).toHaveLength(0)
    expect(ok(await db.from('documents').select('title')).map((r) => r.title)).toEqual(['Structural drawings rev'])
    // company-wide without documents.restricted: management yes, restricted no
    const qs = ok(await t.as(U.qs).from('documents').select('title').order('title'))
    expect(qs.map((r) => r.title)).toEqual(['Board minutes', 'Structural drawings rev'])
    expect(ok(await t.as(U.md).from('documents').select('id'))).toHaveLength(3)
    expect(ok(await t.as(U.eng2).from('document_versions').select('id'))).toHaveLength(0)
    expect(ok(await t.as(U.eng).from('document_versions').select('id').eq('document_id', d.id))).toHaveLength(2)
  })

  it('versions are immutable, follow the document’s access level and go with the document', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.pm)
    const d = ok(await db.from('documents').insert({ project_id: P1, title: 'Permit' }).select().single())
    const v = ok(await db.from('document_versions').insert({ document_id: d.id, version: 0, storage_path: `${P1}/${d.id}/p.pdf`, file_name: 'p.pdf' }).select().single())
    expect((await db.from('document_versions').update({ file_name: 'x.pdf' }).eq('id', v.id)).error?.message).toMatch(/cannot be changed/)
    expect((await db.from('document_versions').delete().eq('id', v.id)).error?.message).toMatch(/cannot be deleted/)
    expect((await db.from('document_versions').insert({ document_id: d.id, version: 0, storage_path: 'x', file_name: 'big', size_bytes: 60e6 })).error?.code).toBe('23514')
    ok(await t.as(U.md).from('documents').update({ access_level: 'restricted' }).eq('id', d.id))
    expect(t.raw.get('document_versions', v.id)!.access_level).toBe('restricted')
    // only the creator or documents.restricted holders delete
    const other = t.as(U.eng)
    const d2 = ok(await other.from('documents').insert({ project_id: P1, title: 'Eng notes' }).select().single())
    expect((await t.as(U.pm).from('documents').delete().eq('id', d2.id)).error?.message).toMatch(/row-level security/)
    ok(await t.as(U.md).from('documents').delete().eq('id', d.id))
    expect(t.raw.all('document_versions')).toHaveLength(0)
  })

  it('employees without documents.manage cannot upload; non-members cannot add to a project', async () => {
    const { t, U, P1 } = await withProjects()
    expect((await t.as(U.emp).from('documents').insert({ project_id: null, title: 'x' })).error?.message).toMatch(/row-level security/)
    expect((await t.as(U.eng2).from('documents').insert({ project_id: P1, title: 'x' })).error?.message).toMatch(/row-level security/)
    ok(await t.as(U.eng2).from('documents').insert({ project_id: null, title: 'Company policy' }))
    expect(ok(await t.as(U.emp).from('documents').select('title'))).toEqual([{ title: 'Company policy' }])
  })
})

// ============================================================================ tasks

describe('tasks', () => {
  it('assignment notifies; completing sets 100% and completed_at; overdue reminders are idempotent', async () => {
    const { t, U, P1 } = await withProjects()
    const due = daysFromToday(-2)
    const task = ok(await t.as(U.pm).from('tasks').insert({ project_id: P1, title: 'Submit shop drawings', assigned_to: U.eng, due_date: due }).select().single())
    const assigned = notes(t, U.eng).filter((n) => n.type === 'task')
    expect(assigned).toHaveLength(1)
    expect(assigned[0]).toMatchObject({ title: 'New task assigned', body: `Submit shop drawings — due ${formatDay(due)}`, link: `/tasks?task=${task.id}` })

    const eng = t.as(U.eng)
    expect(ok(await eng.rpc('notify_overdue_tasks'))).toBe(1)
    expect(ok(await eng.rpc('notify_overdue_tasks'))).toBe(0)
    const overdue = notes(t, U.eng).filter((n) => n.title === 'Task overdue')
    expect(overdue).toHaveLength(1)
    expect(overdue[0]).toMatchObject({ type: 'alert', body: `Submit shop drawings was due ${formatDay(due)}` })
    // other users' calls do not remind someone else (and see nothing to remind themselves)
    expect(ok(await t.as(U.pm).rpc('notify_overdue_tasks'))).toBe(0)

    t.as(U.eng) // t.as() switches the shared client's user
    const done = ok(await eng.from('tasks').update({ status: 'done' }).eq('id', task.id).select().single())
    expect(done.progress).toBe(100)
    expect(done.completed_at).toBeTruthy()
    const again = ok(await eng.from('tasks').update({ description: 'x' }).eq('id', task.id).select().single())
    expect(again.completed_at).toBe(done.completed_at)
    const reopened = ok(await eng.from('tasks').update({ status: 'in_progress', progress: 50 }).eq('id', task.id).select().single())
    expect(reopened.completed_at).toBeNull()
    expect(ok(await eng.rpc('notify_overdue_tasks'))).toBe(0) // already reminded today

    expect(ok(await t.as(U.eng2).from('notifications').select('*').eq('user_id', U.eng))).toHaveLength(0)
  })

  it('assignees update their own tasks but cannot reassign them; re-assignment notifies the new assignee', async () => {
    const { t, U, P1 } = await withProjects()
    const task = ok(await t.as(U.pm).from('tasks').insert({ project_id: P1, title: 'Order rebar', assigned_to: U.emp }).select().single())
    const emp = t.as(U.emp)
    expect(ok(await emp.from('tasks').select('id'))).toHaveLength(1) // via assigned_to, no project access
    ok(await emp.from('tasks').update({ status: 'in_progress', progress: 20 }).eq('id', task.id))
    expect((await emp.from('tasks').update({ assigned_to: U.eng }).eq('id', task.id)).error?.message).toMatch(/row-level security/)
    expect((await emp.from('tasks').delete().eq('id', task.id)).error).toBeTruthy()
    ok(await t.as(U.pm).from('tasks').update({ assigned_to: U.eng }).eq('id', task.id))
    expect(notes(t, U.eng).filter((n) => n.type === 'task')).toHaveLength(1)
    // self-assignment does not notify; disabled setting suppresses notifications
    ok(await t.as(U.pm).from('tasks').insert({ project_id: P1, title: 'My own task', assigned_to: U.pm }))
    expect(notes(t, U.pm)).toHaveLength(0)
    const cs = t.raw.get('company_settings', '1')!
    t.raw.put('company_settings', '1', { ...cs, notification_settings: { ...(cs.notification_settings ?? {}), task_assigned: false } })
    ok(await t.as(U.pm).from('tasks').insert({ project_id: P1, title: 'Quiet task', assigned_to: U.eng }))
    expect(notes(t, U.eng).filter((n) => n.type === 'task')).toHaveLength(1)
  })

  it('validates tasks; sub-tasks cascade; non-members cannot see project tasks', async () => {
    const { t, U, P1 } = await withProjects()
    const db = t.as(U.pm)
    expect((await db.from('tasks').insert({ project_id: P1, title: 'Bad', start_date: '2026-02-02', due_date: '2026-02-01' })).error?.code).toBe('23514')
    expect((await db.from('tasks').insert({ project_id: P1, title: 'Bad', priority: 'urgent' })).error?.code).toBe('23514')
    const parent = ok(await db.from('tasks').insert({ project_id: P1, title: 'Parent', status: 'done' }).select().single())
    expect(parent).toMatchObject({ progress: 100 })
    ok(await db.from('tasks').insert({ project_id: P1, title: 'Child', parent_id: parent.id }))
    expect(ok(await t.as(U.eng2).from('tasks').select('id'))).toHaveLength(0)
    expect(ok(await t.as(U.eng).from('tasks').select('id'))).toHaveLength(2)
    ok(await db.from('tasks').delete().eq('id', parent.id))
    expect(t.raw.all('tasks')).toHaveLength(0)
  })
})
