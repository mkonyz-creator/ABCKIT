/**
 * End-to-end test of demo mode: the real supabase-js client talks to the in-browser
 * backend emulation (PGlite + migrations + RLS) exactly as the UI does.
 */
import 'fake-indexeddb/auto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { demoFetch, demoViewableUrl, ready } from './server'
import { DEMO_PASSWORD, DEMO_URL } from './flag'

function client() {
  return createClient(DEMO_URL, 'demo-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: demoFetch as typeof fetch },
  })
}

async function signIn(email: string) {
  const c = client()
  const { error } = await c.auth.signInWithPassword({ email, password: DEMO_PASSWORD })
  if (error) throw error
  return c
}

let md: SupabaseClient, eng: SupabaseClient, acc: SupabaseClient, store: SupabaseClient, admin: SupabaseClient

describe('demo backend (supabase-js → PGlite)', () => {
  beforeAll(async () => {
    await ready
    ;[md, eng, acc, store, admin] = await Promise.all(['md', 'engineer', 'accountant', 'store', 'admin'].map((u) => signIn(`${u}@demo.abckit`)))
  }, 120_000)

  it('rejects a wrong password', async () => {
    const { error } = await client().auth.signInWithPassword({ email: 'md@demo.abckit', password: 'nope' })
    expect(error?.message).toMatch(/Invalid login credentials/)
  })

  it('loads the signed-in profile with embedded role and permissions RPC', async () => {
    const { data: u } = await md.auth.getUser()
    const p = await md.from('profiles').select('*, role:roles(id,key,name)').eq('id', u.user!.id).maybeSingle()
    expect(p.error).toBeNull()
    expect(p.data.role.key).toBe('managing_director')
    const perms = await md.rpc('my_permissions')
    expect(perms.data).toContain('finance.approve')
  })

  it('lists projects with many-to-one embeds, hints, filters and ordering', async () => {
    const r = await md
      .from('projects')
      .select('*, client:clients(id,name), manager:profiles!projects_project_manager_id_fkey(id,full_name)')
      .eq('is_archived', false)
      .order('created_at', { ascending: false })
    expect(r.error).toBeNull()
    expect(r.data!.length).toBe(3)
    expect(r.data![0].client.name).toMatch(/\[DEMO\]/)
    expect(r.data!.every((p: any) => p.manager?.full_name === 'Paula Shirima')).toBe(true)
  })

  it('applies RLS per role (engineer sees only assigned projects, no finance)', async () => {
    const p = await eng.from('projects').select('id,status')
    expect(p.data!.every((x: any) => x.status === 'active')).toBe(true)
    const f = await eng.from('financial_transactions').select('id')
    expect(f.data).toEqual([])
  })

  it('supports one-to-many embeds, single(), count/head and views', async () => {
    const pr = await md.from('purchase_requests').select('*, items:purchase_request_items(*), requester:profiles!purchase_requests_requested_by_fkey(full_name)').limit(5)
    expect(pr.error).toBeNull()
    expect(pr.data![0].items.length).toBe(1)
    const one = await md.from('company_settings').select('*').eq('id', 1).single()
    expect(one.data.company_name).toBe('ARICOM BUILDING CONTRACTORS')
    const { count } = await md.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false)
    expect(typeof count).toBe('number')
    const pf = await md.from('project_financials').select('*').eq('is_archived', false)
    expect(pf.data!.some((x: any) => Number(x.actual_cost) > 0)).toBe(true)
  })

  it('runs dashboard RPCs', async () => {
    const s = await md.rpc('dashboard_summary')
    expect(s.error).toBeNull()
    expect(s.data.projects.active).toBe(2)
    const m = await md.rpc('monthly_finance', { p_months: 12, p_project: null })
    expect(m.data!.length).toBe(12)
    const a = await md.rpc('recent_activity', { p_limit: 12 })
    expect(a.data!.length).toBeGreaterThan(0)
  })

  it('handles or/ilike search, in() and is-null filters', async () => {
    const s = await md.from('projects').select('id,name').or('name.ilike.%office%,code.ilike.%office%')
    expect(s.data!.length).toBe(1)
    const e = await md.from('employees').select('id').in('status', ['active', 'on_leave'])
    expect(e.data!.length).toBe(3)
    const t = await md.from('tasks').select('id').is('completed_at', null)
    expect(t.data!.length).toBeGreaterThan(0)
  })

  it('inserts, updates and upserts with representation; triggers and approvals still apply', async () => {
    const ins = await acc
      .from('financial_transactions')
      .insert({ direction: 'expense', category: 'transport', amount: 150000, description: 'Demo test transport', status: 'approved' })
      .select()
      .single()
    expect(ins.error).toBeNull()
    expect(ins.data.status).toBe('pending')
    const self = await acc.from('financial_transactions').update({ status: 'approved' }).eq('id', ins.data.id)
    expect(self.error?.message).toMatch(/Segregation of duties/)
    const ok = await md.from('financial_transactions').update({ status: 'approved' }).eq('id', ins.data.id).select().single()
    expect(ok.data.status).toBe('approved')
    const emp = (await md.from('employees').select('id').limit(1)).data![0].id
    const up = await eng.from('attendance').upsert([{ employee_id: emp, work_date: '2020-01-06', status: 'present', hours_worked: 8, overtime_hours: 0 }], { onConflict: 'employee_id,work_date' })
    expect(up.error).toBeNull()
    const up2 = await eng.from('attendance').upsert([{ employee_id: emp, work_date: '2020-01-06', status: 'late', hours_worked: 7, overtime_hours: 0 }], { onConflict: 'employee_id,work_date' })
    expect(up2.error).toBeNull()
    const row = await md.from('attendance').select('status').eq('employee_id', emp).eq('work_date', '2020-01-06').single()
    expect(row.data!.status).toBe('late')
  })

  it('maps permission errors like PostgREST', async () => {
    const r = await eng.from('projects').insert({ name: 'Not allowed' })
    expect(r.error?.message).toMatch(/row-level security/)
    const n = await md.from('projects').select('id').eq('id', '00000000-0000-0000-0000-000000000000').single()
    expect(n.error?.code).toBe('PGRST116')
  })

  it('stock movement over-issue is blocked for the storekeeper', async () => {
    const m = (await store.from('materials').select('id,current_stock').ilike('name', '%Portland%').single()).data!
    const r = await store.from('inventory_transactions').insert({ material_id: m.id, txn_type: 'issue', quantity: Number(m.current_stock) + 1000 })
    expect(r.error?.message).toMatch(/Insufficient stock/)
  })

  it('storage: upload, list, sign and read back a file; scoped by project', async () => {
    const proj = (await eng.from('projects').select('id').limit(1)).data![0].id
    const blob = new Blob(['hello'], { type: 'image/jpeg' })
    const up = await eng.storage.from('project-photos').upload(`${proj}/t.jpg`, blob, { contentType: 'image/jpeg' })
    expect(up.error).toBeNull()
    const list = await eng.storage.from('project-photos').list(proj)
    expect(list.data!.map((x) => x.name)).toContain('t.jpg')
    const s = await eng.storage.from('project-photos').createSignedUrl(`${proj}/t.jpg`, 60)
    expect(s.data!.signedUrl.startsWith(DEMO_URL)).toBe(true)
    const viewable = await demoViewableUrl(s.data!.signedUrl)
    expect(viewable.startsWith('blob:')).toBe(true)
    const bad = await eng.storage.from('project-photos').upload(`00000000-0000-0000-0000-000000000000/x.jpg`, blob, { contentType: 'image/jpeg' })
    expect(bad.error).not.toBeNull()
  })

  it('admin-users function: invite works for admins only', async () => {
    const no = await eng.functions.invoke('admin-users', { body: { action: 'invite', email: 'x@demo.abckit', full_name: 'X Person', role_key: 'employee' } })
    expect(no.error).not.toBeNull()
    const yes = await admin.functions.invoke('admin-users', { body: { action: 'invite', email: 'new.person@demo.abckit', full_name: 'New Person', role_key: 'storekeeper' } })
    expect(yes.error).toBeNull()
    expect(yes.data.ok).toBe(true)
    const c = await signIn('new.person@demo.abckit')
    const perms = await c.rpc('my_permissions')
    expect(perms.data).toContain('inventory.manage')
  })
})
