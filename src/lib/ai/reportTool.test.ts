/**
 * ABC AI "tuma ripoti kwa admin": report_to_admin asks first, then files the report as the user (admins notified).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoTestDb } from '@/backend/testing'
import { USER_REPORTS } from '@/shared/userReports'
import { ACTION_TOOL_NAMES, createToolEnv, executeTool, TOOL_NAMES, type ActionConfirm } from './tools'

let demo: Awaited<ReturnType<typeof createDemoTestDb>>
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no network in tests'))))
  demo = await createDemoTestDb()
}, 120_000)
afterAll(() => vi.unstubAllGlobals())

const asked: ActionConfirm[] = []
const run = async (uid: string, name: string, input: unknown, answer = true) => {
  const db = demo.as(uid)
  const env = await createToolEnv(db, { fns: db.functions, confirm: async (req) => (asked.push(req), answer) })
  const r = await executeTool(name, input, env)
  return JSON.parse(typeof r.content === 'string' ? r.content : (r.content[0] as { text: string }).text)
}
const ENG = 'demo-site_engineer'

describe('report_to_admin', () => {
  it('is an action tool (confirmation first)', () => {
    expect(TOOL_NAMES).toContain('report_to_admin')
    expect(ACTION_TOOL_NAMES).toContain('report_to_admin')
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(64)
  })

  it('sends nothing on "no", files the report as the user on "yes"', async () => {
    const input = { subject: 'Saruji imepungua Mbezi', details: 'Mifuko 20 haikufika leo asubuhi.', category: 'complaint', priority: 'high' }
    const no = await run(ENG, 'report_to_admin', input, false)
    expect(no).toMatchObject({ done: false, declined: true })
    expect(asked.at(-1)).toMatchObject({ action: 'report_to_admin', title_sw: 'Nitume ripoti hii kwa admin?', lines_sw: ['Lalamiko · Juu', '“Saruji imepungua Mbezi”', 'Mifuko 20 haikufika leo asubuhi.'] })
    expect(demo.raw.all(USER_REPORTS)).toHaveLength(0)

    const yes = await run(ENG, 'report_to_admin', input)
    expect(yes).toMatchObject({ done: true, sent_to: 'administrators' })
    expect(demo.raw.all(USER_REPORTS)).toEqual([expect.objectContaining({ reporter_id: ENG, subject: 'Saruji imepungua Mbezi', category: 'complaint', priority: 'high', status: 'open' })])
    expect(demo.raw.all('notifications').filter((n) => n.title === 'New report: Saruji imepungua Mbezi').length).toBeGreaterThan(0)
  })
})
