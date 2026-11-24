/*
 * AI Intelligence security rules (firebase/rules/50_ai.rules), end-to-end against the Firestore emulator
 * with the real engine + AI domain hooks + FirestoreStore. Run: npm run test:rules (needs Java 21+).
 *
 * Roles (seeded grants): managing_director = ai.view + ai.email + ai.email_send; administrator = ai.view + ai.manage;
 * site_engineer / accountant = no AI permission; super_admin = everything (but still no access to secrets).
 */
import { initializeApp } from 'firebase/app'
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, query, setDoc, updateDoc, where, type Firestore } from 'firebase/firestore'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@/backend/client'
import { FirestoreStore } from '@/backend/firestoreStore'
import { seedDocuments } from '@/backend/session'
import { AI_COLLECTIONS as C } from '@/shared/ai/contract'

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

const roles: Record<string, string> = { admin: 'super_admin', md: 'managing_director', sys: 'administrator', eng: 'site_engineer', acc: 'accountant' }
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

const now = new Date().toISOString()
const draft = (id: string, status: string) => ({
  id, email_id: 'acc1__m1', account_id: 'acc1', thread_id: 't1', to: [{ name: 'Client', address: 'client@example.com' }], cc: [], subject: 'Re: Progress', body: 'Draft',
  language: 'en', status, ai_generated: true, instructions: null, created_by: 'md', created_at: now, updated_at: now, approved_by: null, approved_at: null, sent_at: null,
  provider_message_id: null, error: null, is_demo: false,
})

beforeAll(async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  for (const [t, id, row] of seedDocuments(now)) await adminPut(t, id, row)
  await adminPut('meta', 'bootstrap', { owner: 'admin', at: now })
  for (const [u, role] of Object.entries(roles)) {
    await adminPut('profiles', u, { id: u, full_name: u, email: `${u}@t.local`, role_id: role, is_active: true, created_at: now, updated_at: now })
    const app = initializeApp({ projectId: PROJECT, apiKey: 'fake' }, `ai-${u}`)
    const fs = getFirestore(app)
    connectFirestoreEmulator(fs, '127.0.0.1', 8080, { mockUserToken: { sub: u, user_id: u, auth_time: Math.floor(Date.now() / 1000) } as any })
    fsOf[u] = fs
    dbOf[u] = createDb({ store: new FirestoreStore(fs), currentUser: () => ({ uid: u, email: `${u}@t.local` }) })
  }
  // server-written documents (Admin SDK in production)
  await adminPut(C.accounts, 'acc1', { id: 'acc1', provider: 'gmail', address: 'office@example.com', display_name: null, status: 'connected', sync_enabled: true, connected_by: 'sys', connected_at: now, last_sync_at: null, last_sync_error: null, cursor: null, messages_synced: 1, is_demo: false })
  await adminPut(C.accountSecrets, 'acc1', { id: 'acc1', refresh_token: 'enc:secret' })
  await adminPut(C.oauthStates, 's1', { uid: 'sys', provider: 'gmail', return_url: 'https://x.example/', expires_at: now })
  await adminPut(C.emails, 'acc1__m1', { id: 'acc1__m1', account_id: 'acc1', folder: 'inbox', subject: 'Progress', date: now, from: { name: 'Client', address: 'client@example.com' }, to: [], cc: [], status: 'analyzed', ai: { summary: 's' }, is_demo: false, created_at: now })
  await adminPut(C.drafts, 'd1', draft('d1', 'draft'))
  await adminPut(C.drafts, 'd2', draft('d2', 'sent'))
  await adminPut(C.alerts, 'a1', { id: 'a1', dedupe_key: 'k1', type: 'risk', priority: 'high', title: 'Risk', description: 'd', source: 'monitor', record: null, project: null, recommended_action: 'Act', status: 'open', first_seen_at: now, last_seen_at: now, resolved_at: null, acknowledged_by: null, acknowledged_at: null, is_demo: false })
  await adminPut(C.reports, 'r1', { id: 'r1', title: 'Brief', kind: 'daily_brief', prompt: null, content_md: '# Brief', generated_by: 'md', generated_at: now, model: 'm', is_demo: false })
  await adminPut(C.knowledge, 'k1', { id: 'k1', title: 'Policy', body: 'x', kind: 'policy', tags: [], created_by: 'sys', created_at: now, updated_at: now, is_demo: false })
  await adminPut(C.activity, 'act-sys', { id: 'act-sys', at: now, actor_id: 'sys', action: 'chat', detail: 'q', record: null, ok: true, is_demo: false })
  await adminPut(C.usage, 'u1', { id: 'u1', at: now, user_id: 'md', purpose: 'chat', model: 'm', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0 })
  await adminPut(C.settings, 'settings', { id: 'settings', enabled: true, email_sync_enabled: true, schedule_slip_threshold_pct: 10, approval_stale_days: 2, low_stock_alerts: true, notify: { urgent_email: true }, reply_signature: '', company_style_notes: '', daily_chat_limit_per_user: 200, updated_at: now, updated_by: null })
  await adminPut(C.status, 'status', { id: 'status', ai_configured: false, alerts_open: 1, updated_at: now })
})

describe('AI rules: email intelligence', () => {
  it('emails: readable with ai.email only; never writable from the app', async () => {
    expect((await getDoc(doc(fsOf.md, C.emails, 'acc1__m1'))).exists()).toBe(true)
    expect((await getDocs(collection(fsOf.md, C.emails))).size).toBe(1)
    await denied(getDoc(doc(fsOf.sys, C.emails, 'acc1__m1')))
    await denied(getDocs(collection(fsOf.eng, C.emails)))
    await denied(updateDoc(doc(fsOf.md, C.emails, 'acc1__m1'), { subject: 'x' }))
    await denied(setDoc(doc(fsOf.admin, C.emails, 'acc1__fake'), { id: 'acc1__fake', subject: 'fake' }))
    // the app's own list query degrades to "no rows" for roles without access
    expect(ok(await dbOf.eng.from(C.emails).select('id'))).toHaveLength(0)
  })

  it('drafts: ai.email edits text/recipients while draft or discards; cannot approve, send, create or delete', async () => {
    ok(await dbOf.md.from(C.drafts).update({ body: 'Edited', subject: 'Re: Progress (2)' }).eq('id', 'd1'))
    expect((await adminGet(C.drafts, 'd1')).body).toBe('Edited')
    await denied(updateDoc(doc(fsOf.md, C.drafts, 'd1'), { status: 'sent' }))
    await denied(updateDoc(doc(fsOf.md, C.drafts, 'd1'), { status: 'approved', approved_by: 'md' }))
    await denied(updateDoc(doc(fsOf.md, C.drafts, 'd1'), { email_id: 'other' }))
    await denied(updateDoc(doc(fsOf.md, C.drafts, 'd1'), { status: 'discarded', body: 'sneaky' }))
    await denied(updateDoc(doc(fsOf.md, C.drafts, 'd2'), { body: 'rewrite a sent reply' }))
    await denied(updateDoc(doc(fsOf.sys, C.drafts, 'd1'), { body: 'admin without ai.email' }))
    await denied(getDoc(doc(fsOf.eng, C.drafts, 'd1')))
    await denied(setDoc(doc(fsOf.md, C.drafts, 'd3'), draft('d3', 'draft')))
    await denied(deleteDoc(doc(fsOf.admin, C.drafts, 'd1')))
    ok(await dbOf.md.from(C.drafts).update({ status: 'discarded' }).eq('id', 'd1'))
    expect((await adminGet(C.drafts, 'd1')).status).toBe('discarded')
    await denied(updateDoc(doc(fsOf.md, C.drafts, 'd1'), { status: 'draft' }))
  })

  it('email accounts: metadata for ai.manage / ai.email; secrets and OAuth states for nobody', async () => {
    expect((await getDoc(doc(fsOf.md, C.accounts, 'acc1'))).exists()).toBe(true)
    expect((await getDocs(collection(fsOf.sys, C.accounts))).size).toBe(1)
    await denied(getDoc(doc(fsOf.eng, C.accounts, 'acc1')))
    await denied(updateDoc(doc(fsOf.sys, C.accounts, 'acc1'), { sync_enabled: false }))
    for (const u of ['admin', 'sys', 'md']) {
      await denied(getDoc(doc(fsOf[u], C.accountSecrets, 'acc1')))
      await denied(getDocs(collection(fsOf[u], C.oauthStates)))
      await denied(setDoc(doc(fsOf[u], C.accountSecrets, 'acc2'), { id: 'acc2', refresh_token: 'x' }))
    }
  })

  it('AI provider API keys: no client can read, list or write them — not even a super administrator', async () => {
    for (const u of ['admin', 'sys', 'md', 'eng']) {
      await denied(getDoc(doc(fsOf[u], C.providerKeys, 'openai')))
      await denied(getDocs(collection(fsOf[u], C.providerKeys)))
      await denied(setDoc(doc(fsOf[u], C.providerKeys, 'openai'), { provider: 'openai', last4: 'abcd' }))
      await denied(deleteDoc(doc(fsOf[u], C.providerKeys, 'openai')))
    }
  })
})

describe('AI rules: per-user access grants (user_access, User Management → Email access)', () => {
  it('a grant gives one user email access on top of their role; only the server writes grants', async () => {
    await denied(getDoc(doc(fsOf.eng, C.emails, 'acc1__m1')))
    // written by the adminUsers function (Admin SDK) in production
    await adminPut(C.userAccess, 'eng', { id: 'eng', user_id: 'eng', perms: ['ai.view', 'ai.email'], updated_by: 'sys', updated_at: now })
    expect((await getDoc(doc(fsOf.eng, C.emails, 'acc1__m1'))).exists()).toBe(true)
    expect((await getDoc(doc(fsOf.eng, C.accounts, 'acc1'))).exists()).toBe(true)
    expect((await getDoc(doc(fsOf.eng, C.drafts, 'd2'))).exists()).toBe(true)
    // email access is not approve & send, and not mailbox management
    await denied(getDocs(collection(fsOf.eng, C.usage)))
    // the user reads their own grant; user administrators read all; others nothing
    expect((await getDoc(doc(fsOf.eng, C.userAccess, 'eng'))).exists()).toBe(true)
    expect((await getDocs(collection(fsOf.sys, C.userAccess))).size).toBe(1)
    await denied(getDoc(doc(fsOf.acc, C.userAccess, 'eng')))
    await denied(getDocs(collection(fsOf.md, C.userAccess)))
    // nobody grants access from the app — not even themselves, not even a super administrator
    for (const u of ['eng', 'acc', 'sys', 'admin']) {
      await denied(setDoc(doc(fsOf[u], C.userAccess, u), { id: u, user_id: u, perms: ['ai.manage'] }))
      await denied(updateDoc(doc(fsOf[u], C.userAccess, 'eng'), { perms: ['ai.view', 'ai.email', 'ai.manage'] }))
      await denied(deleteDoc(doc(fsOf[u], C.userAccess, 'eng')))
    }
    // a grant that lists a non-AI permission does not unlock it (rules only consult grants for AI checks)
    await adminPut(C.userAccess, 'acc', { id: 'acc', user_id: 'acc', perms: ['users.manage'], updated_by: 'sys', updated_at: now })
    await denied(getDocs(collection(fsOf.acc, C.userAccess)))
    // removing the grant takes the access away
    await fetch(`${BASE}/${C.userAccess}/eng`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })
    await fetch(`${BASE}/${C.userAccess}/acc`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })
    await denied(getDoc(doc(fsOf.eng, C.emails, 'acc1__m1')))
  })
})

describe('AI rules: alerts, reports, chats', () => {
  it('alerts: ai.view reads and acknowledges/resolves (as themselves); nothing else changes', async () => {
    await denied(getDocs(collection(fsOf.eng, C.alerts)))
    expect((await getDocs(collection(fsOf.sys, C.alerts))).size).toBe(1)
    await denied(updateDoc(doc(fsOf.md, C.alerts, 'a1'), { title: 'renamed' }))
    await denied(updateDoc(doc(fsOf.md, C.alerts, 'a1'), { status: 'acknowledged', acknowledged_by: 'sys', acknowledged_at: now }))
    await denied(updateDoc(doc(fsOf.md, C.alerts, 'a1'), { status: 'open' }))
    ok(await dbOf.md.from(C.alerts).update({ status: 'acknowledged' }).eq('id', 'a1'))
    expect(await adminGet(C.alerts, 'a1')).toMatchObject({ status: 'acknowledged', acknowledged_by: 'md' })
    ok(await dbOf.sys.from(C.alerts).update({ status: 'resolved' }).eq('id', 'a1'))
    expect(await adminGet(C.alerts, 'a1')).toMatchObject({ status: 'resolved', acknowledged_by: 'md' })
    await denied(setDoc(doc(fsOf.md, C.alerts, 'a2'), { id: 'a2', dedupe_key: 'x', status: 'open', title: 'fake' }))
    await denied(updateDoc(doc(fsOf.eng, C.alerts, 'a1'), { status: 'resolved' }))
  })

  it('reports: ai.view reads and creates its own; reports are immutable', async () => {
    const r = ok(await dbOf.md.from(C.reports).insert({ title: 'Ops', kind: 'operations', content_md: '# Ops', model: 'm' }).select().single())
    expect((await adminGet(C.reports, r.id)).generated_by).toBe('md')
    await denied(setDoc(doc(fsOf.md, C.reports, 'forged'), { id: 'forged', title: 'x', kind: 'custom', content_md: 'x', generated_by: 'sys', generated_at: now, model: 'm' }))
    await denied(updateDoc(doc(fsOf.md, C.reports, 'r1'), { content_md: 'tampered' }))
    await denied(deleteDoc(doc(fsOf.admin, C.reports, 'r1')))
    await denied(getDoc(doc(fsOf.eng, C.reports, 'r1')))
    await denied(setDoc(doc(fsOf.eng, C.reports, 'e1'), { id: 'e1', title: 'x', kind: 'custom', content_md: 'x', generated_by: 'eng', generated_at: now, model: 'm' }))
    expect((await getDocs(collection(fsOf.sys, C.reports))).size).toBe(2)
  })

  it('chats: private to their owner', async () => {
    const c = ok(await dbOf.md.from(C.chats).insert({ title: 'Mine', messages: [{ role: 'user', text: 'Hello', at: now }] }).select().single())
    expect(ok(await dbOf.md.from(C.chats).select('id'))).toHaveLength(1)
    await denied(getDoc(doc(fsOf.sys, C.chats, c.id)))
    await denied(getDocs(collection(fsOf.md, C.chats))) // unfiltered listing is never allowed
    expect((await getDocs(query(collection(fsOf.md, C.chats), where('user_id', '==', 'md')))).size).toBe(1)
    expect(ok(await dbOf.sys.from(C.chats).select('id'))).toHaveLength(0)
    await denied(updateDoc(doc(fsOf.sys, C.chats, c.id), { title: 'hijack' }))
    await denied(updateDoc(doc(fsOf.md, C.chats, c.id), { user_id: 'sys' }))
    await denied(setDoc(doc(fsOf.sys, C.chats, 'planted'), { id: 'planted', user_id: 'md', title: 'x', messages: [] }))
    await denied(setDoc(doc(fsOf.eng, C.chats, 'eng1'), { id: 'eng1', user_id: 'eng', title: 'x', messages: [] }))
    ok(await dbOf.md.from(C.chats).update({ title: 'Renamed' }).eq('id', c.id))
    ok(await dbOf.md.from(C.chats).delete().eq('id', c.id))
  })
})

describe('AI rules: knowledge, audit, usage, settings, status', () => {
  it('knowledge: ai.view reads, ai.manage writes', async () => {
    expect((await getDocs(collection(fsOf.md, C.knowledge))).size).toBe(1)
    await denied(getDocs(collection(fsOf.eng, C.knowledge)))
    await denied(setDoc(doc(fsOf.md, C.knowledge, 'k2'), { id: 'k2', title: 'x', body: '', kind: 'note', tags: [], created_by: 'md', created_at: now, updated_at: now }))
    const k = ok(await dbOf.sys.from(C.knowledge).insert({ title: 'HSE', kind: 'policy', body: 'Wear PPE' }).select().single())
    ok(await dbOf.sys.from(C.knowledge).update({ body: 'Wear PPE at all times' }).eq('id', k.id))
    await denied(updateDoc(doc(fsOf.sys, C.knowledge, k.id), { created_by: 'md' }))
    await denied(updateDoc(doc(fsOf.md, C.knowledge, 'k1'), { body: 'y' }))
    ok(await dbOf.sys.from(C.knowledge).delete().eq('id', k.id))
  })

  it('activity: own chat/report rows from the app; ai.manage reads all, ai.view only own', async () => {
    ok(await dbOf.md.from(C.activity).insert({ action: 'chat', detail: 'Which projects are late?' }))
    await denied(setDoc(doc(fsOf.md, C.activity, 'x1'), { id: 'x1', at: now, actor_id: 'md', action: 'email_sent', detail: 'forged', record: null, ok: true, is_demo: false }))
    await denied(setDoc(doc(fsOf.md, C.activity, 'x2'), { id: 'x2', at: now, actor_id: 'sys', action: 'chat', detail: 'impersonated', record: null, ok: true, is_demo: false }))
    await denied(setDoc(doc(fsOf.eng, C.activity, 'x3'), { id: 'x3', at: now, actor_id: 'eng', action: 'chat', detail: 'no ai.view', record: null, ok: true, is_demo: false }))
    await denied(getDocs(collection(fsOf.md, C.activity)))
    const mine = ok(await dbOf.md.from(C.activity).select('*'))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((a: any) => a.actor_id === 'md')).toBe(true)
    const all = ok(await dbOf.sys.from(C.activity).select('*'))
    expect(all.some((a: any) => a.actor_id === 'md') && all.some((a: any) => a.actor_id === 'sys')).toBe(true)
    await denied(updateDoc(doc(fsOf.sys, C.activity, 'act-sys'), { detail: 'rewritten' }))
    await denied(deleteDoc(doc(fsOf.admin, C.activity, 'act-sys')))
  })

  it('usage: ai.manage only; status: ai.view read only; settings: ai.view read, ai.manage write', async () => {
    expect((await getDocs(collection(fsOf.sys, C.usage))).size).toBe(1)
    await denied(getDocs(collection(fsOf.md, C.usage)))
    await denied(setDoc(doc(fsOf.sys, C.usage, 'u2'), { id: 'u2', at: now, purpose: 'chat' }))
    expect((await getDoc(doc(fsOf.md, C.status, 'status'))).exists()).toBe(true)
    await denied(getDoc(doc(fsOf.eng, C.status, 'status')))
    await denied(updateDoc(doc(fsOf.sys, C.status, 'status'), { ai_configured: true }))
    expect((await getDoc(doc(fsOf.md, C.settings, 'settings'))).exists()).toBe(true)
    await denied(getDoc(doc(fsOf.eng, C.settings, 'settings')))
    await denied(updateDoc(doc(fsOf.md, C.settings, 'settings'), { daily_chat_limit_per_user: 100000 }))
    ok(await dbOf.sys.from(C.settings).update({ schedule_slip_threshold_pct: 15 }).eq('id', 'settings'))
    expect((await adminGet(C.settings, 'settings')).schedule_slip_threshold_pct).toBe(15)
    await denied(setDoc(doc(fsOf.sys, C.settings, 'other'), { id: 'other', enabled: false }))
  })
})
