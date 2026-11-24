/**
 * Reports to the admin: any user sends, admins (users.manage) are notified, reply and set the status; the reporter
 * sees only their own and is notified of the answer. Security rules mirror this in firebase/rules/10_core.rules.
 */
import { describe, expect, it } from 'vitest'
import { NAV } from '@/components/layout/nav'
import { USER_REPORTS as T } from '@/shared/userReports'
import { createTestDb, ok } from '../testing'

function setup() {
  const t = createTestDb()
  const U = {
    admin: t.addUser('administrator', { name: 'Asha Admin' }),
    sup: t.addUser('super_admin'),
    emp: t.addUser('employee', { name: 'Juma Mfanyakazi' }),
    eng: t.addUser('site_engineer'),
    off: t.addUser('employee', { active: false }),
  }
  const notes = (uid: string) => t.raw.all('notifications').filter((n) => n.user_id === uid)
  return { t, U, notes }
}

describe('report to admin', () => {
  it('is in the menu for every user', () => {
    const item = NAV.find((n) => n.to === '/report-to-admin')
    expect(item).toMatchObject({ label: 'Report to Admin', group: 'Admin' })
    expect(item?.perm).toBeUndefined()
  })

  it('any active user sends a report as themself; every admin is notified', async () => {
    const { t, U, notes } = setup()
    const r = ok(
      await t
        .as(U.emp)
        .from(T)
        .insert({ reporter_id: U.eng, subject: '  Saruji   imepungua ', body: ' Mifuko 20 haikufika Mbezi. ', category: 'complaint', priority: 'urgent', status: 'resolved', admin_reply: 'fake', handled_by: U.admin })
        .select()
        .single(),
    )
    expect(r).toMatchObject({ reporter_id: U.emp, subject: 'Saruji imepungua', body: 'Mifuko 20 haikufika Mbezi.', category: 'complaint', priority: 'urgent', status: 'open', admin_reply: null, handled_by: null })
    for (const a of [U.admin, U.sup]) expect(notes(a)).toEqual([expect.objectContaining({ type: 'alert', title: 'URGENT report: Saruji imepungua', link: `/report-to-admin?tab=inbox&id=${r.id}` })])
    expect(notes(U.admin)[0].body).toContain('Juma Mfanyakazi')
    expect(notes(U.eng)).toHaveLength(0)
    // bad input
    expect((await t.as(U.emp).from(T).insert({ subject: ' ', body: 'x' })).error?.code).toBe('23514')
    expect((await t.as(U.emp).from(T).insert({ subject: 'x', body: 'y'.repeat(5001) })).error?.code).toBe('23514')
    const odd = ok(await t.as(U.emp).from(T).insert({ subject: 'x', body: 'y', category: 'gossip', priority: 'max' }).select().single())
    expect(odd).toMatchObject({ category: 'other', priority: 'normal' })
    expect((await t.as(U.off).from(T).insert({ subject: 'x', body: 'y' })).error).toBeTruthy()
  })

  it('reporters see only their own; admins see all', async () => {
    const { t, U } = setup()
    ok(await t.as(U.emp).from(T).insert({ subject: 'Mine', body: 'a' }))
    ok(await t.as(U.eng).from(T).insert({ subject: 'Theirs', body: 'b' }))
    expect(ok(await t.as(U.emp).from(T).select('subject')).map((r) => r.subject)).toEqual(['Mine'])
    expect(ok(await t.as(U.admin).from(T).select('subject'))).toHaveLength(2)
  })

  it('admins reply and set the status (stamped); the reporter is notified; reports cannot be edited', async () => {
    const { t, U, notes } = setup()
    const r = ok(await t.as(U.emp).from(T).insert({ subject: 'Printer', body: 'Haifanyi kazi' }).select().single())
    const u = ok(await t.as(U.admin).from(T).update({ status: 'in_review', admin_reply: ' Tumeagiza fundi. ' }).eq('id', r.id).select().single())
    expect(u).toMatchObject({ status: 'in_review', admin_reply: 'Tumeagiza fundi.', handled_by: U.admin })
    expect(u.handled_at).toBeTruthy()
    expect(notes(U.emp)).toEqual([expect.objectContaining({ title: 'Admin replied: Printer', body: 'Tumeagiza fundi.' })])
    ok(await t.as(U.admin).from(T).update({ status: 'resolved' }).eq('id', r.id))
    expect(notes(U.emp).at(-1)).toMatchObject({ type: 'success', title: 'Your report is now resolved: Printer' })
    // nobody rewrites what was sent
    expect((await t.as(U.admin).from(T).update({ body: 'changed' }).eq('id', r.id)).error?.code).toBe('42501')
    expect((await t.as(U.admin).from(T).update({ status: 'deleted' }).eq('id', r.id)).error?.code).toBe('23514')
  })

  it('the reporter may only withdraw (close) their own report; only admins delete', async () => {
    const { t, U } = setup()
    const r = ok(await t.as(U.emp).from(T).insert({ subject: 'Leave', body: 'Naomba likizo' }).select().single())
    expect((await t.as(U.emp).from(T).update({ status: 'resolved' }).eq('id', r.id)).error?.code).toBe('42501')
    expect((await t.as(U.emp).from(T).update({ admin_reply: 'self-approved', status: 'closed' }).eq('id', r.id)).error?.code).toBe('42501')
    await t.as(U.eng).from(T).update({ status: 'closed' }).eq('id', r.id)
    expect(t.raw.get(T, r.id)?.status).toBe('open')
    ok(await t.as(U.emp).from(T).update({ status: 'closed' }).eq('id', r.id))
    expect(t.raw.get(T, r.id)?.status).toBe('closed')
    await t.as(U.emp).from(T).delete().eq('id', r.id)
    expect(t.raw.get(T, r.id)).toBeTruthy()
    ok(await t.as(U.admin).from(T).delete().eq('id', r.id))
    expect(t.raw.get(T, r.id)).toBeUndefined()
  })
})
