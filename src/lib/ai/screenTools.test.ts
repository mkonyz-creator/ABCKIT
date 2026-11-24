/**
 * Opening and clicking on the user's screen without questions, and starting phone calls through the dialer.
 * Data-changing buttons are never pressed by the assistant.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoTestDb } from '@/backend/testing'
import { createToolEnv, executeTool, TOOL_NAMES, ACTION_TOOL_NAMES } from './tools'
import { DANGEROUS_CLICK, pickClickTarget, telTarget, type ClickCandidate } from './uiActions'

let demo: Awaited<ReturnType<typeof createDemoTestDb>>
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no network in tests'))))
  demo = await createDemoTestDb()
}, 120_000)
afterAll(() => vi.unstubAllGlobals())

const run = async (uid: string, name: string, input: unknown) => {
  const db = demo.as(uid)
  const r = await executeTool(name, input, await createToolEnv(db, { fns: db.functions }))
  return { ...r, data: JSON.parse(r.content as string) }
}
const ADMIN = 'demo-super_admin'
const c = (label: string, danger = DANGEROUS_CLICK.test(label)): ClickCandidate => ({ label, kind: 'button', danger })

describe('clicking what the user names', () => {
  // project rows are links: their names never count as dangerous words ("Office Block")
  const link = (label: string): ClickCandidate => ({ label, kind: 'link', danger: false })
  const screen = [c('Overview'), c('Payroll'), c('Attendance'), c('New task'), c('Delete project'), c('Approve'), c('Save'), link('Mbezi Villas — Office Block'), link('Office Block Phase 2')]

  it('exact label first, then a label containing it, then all of its words', () => {
    expect(pickClickTarget(screen, 'payroll')).toEqual({ index: 1 })
    expect(pickClickTarget(screen, 'New Task')).toEqual({ index: 3 })
    expect(pickClickTarget(screen, 'office block')).toEqual({ index: 7 })
    expect(pickClickTarget(screen, 'phase 2 office')).toEqual({ index: 8 })
  })

  it('never presses a button that changes data, and lists what can be clicked when nothing matches', () => {
    for (const t of ['Delete project', 'approve', 'save']) {
      const r = pickClickTarget(screen, t)
      expect('error' in r && r.error).toMatch(/changes data/)
    }
    const none = pickClickTarget(screen, 'Equipment')
    expect('error' in none && none.options).toEqual(['Overview', 'Payroll', 'Attendance', 'New task', 'Mbezi Villas — Office Block', 'Office Block Phase 2'])
    // a submit button is dangerous whatever it says
    expect(pickClickTarget([c('Continue', true)], 'continue')).toHaveProperty('error')
    expect(DANGEROUS_CLICK.test('Records')).toBe(false)
    expect(DANGEROUS_CLICK.test('Office Block')).toBe(false)
    expect(DANGEROUS_CLICK.test('Block')).toBe(true)
    expect(DANGEROUS_CLICK.test('Block user')).toBe(true)
    expect(DANGEROUS_CLICK.test('Futa')).toBe(true)
    expect(DANGEROUS_CLICK.test('Lipa sasa')).toBe(true)
  })

  it('the tools need no confirmation and say so when there is no screen (tests)', async () => {
    expect(TOOL_NAMES).toEqual(expect.arrayContaining(['click_on_screen', 'call_phone']))
    expect(ACTION_TOOL_NAMES).not.toContain('click_on_screen')
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(64)
    const r = await run(ADMIN, 'click_on_screen', { target: 'Payroll' })
    expect(r.data).toMatchObject({ clicked: false, note: 'There is no screen to click on.' })
  })
})

describe('opening pages by name', () => {
  it('Kiswahili and English page names work like paths', async () => {
    for (const [said, page] of [['stoo', 'Materials & Inventory'], ['fedha', 'Finance & Payments'], ['wafanyakazi', 'Workforce & HR'], ['watumiaji', 'User Management'], ['Documents', 'Documents'], ['/projects', 'Projects']]) {
      const r = await run(ADMIN, 'open_page', { path: said })
      expect(r.data.page, said).toBe(page)
    }
    expect((await run(ADMIN, 'open_page', { path: 'kitu kisichojulikana' })).data.note).toMatch(/Unknown page/)
  })
})

describe('phone calls', () => {
  it('Tanzanian numbers become international tel: targets', () => {
    expect(telTarget('0780625728')).toBe('+255780625728')
    expect(telTarget('0780 625 728')).toBe('+255780625728')
    expect(telTarget('+255 780 625 728')).toBe('+255780625728')
    expect(telTarget('255780625728')).toBe('+255780625728')
    expect(telTarget('Juma')).toBeNull()
  })

  it('finds the number of a person in ABCkit, or uses the number given', async () => {
    const byNumber = await run(ADMIN, 'call_phone', { who: '0780625728' })
    expect(byNumber.data).toMatchObject({ calling: false, number: '0780625728' })
    const db = demo.as(ADMIN)
    const emp = ((await db.from('employees').select('full_name,phone').limit(500)).data ?? []).find((e: { phone?: string }) => e.phone) as { full_name: string; phone: string }
    const byName = await run(ADMIN, 'call_phone', { who: emp.full_name })
    expect(byName.data).toMatchObject({ name: emp.full_name, number: emp.phone })
    expect((await run(ADMIN, 'call_phone', { who: 'Mtu Asiyekuwepo Kabisa' })).data.note).toMatch(/No phone number/)
  })
})
