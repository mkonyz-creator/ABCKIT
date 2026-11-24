/** Per-user access grants (user_access/{uid}) are merged into the caller's role permissions. */
import { describe, expect, it } from 'vitest'
import { FakeDb, seedUser } from '../test/fakeFirestore.js'
import { normalizeUserGrant } from '../shared/ai/contract.js'
import { requireCaller, usersWithPerm } from './auth.js'

describe('requireCaller with per-user grants', () => {
  it('a role without email access is refused, then allowed once the user is granted ai.email', async () => {
    const db = new FakeDb()
    seedUser(db, 'eng', ['projects.view'])
    await expect(requireCaller(db.asDb(), 'eng', ['ai.email'])).rejects.toMatchObject({ code: 'permission-denied' })
    db.seed('user_access', [{ id: 'eng', user_id: 'eng', perms: ['ai.view', 'ai.email'] }])
    const c = await requireCaller(db.asDb(), 'eng', ['ai.email'])
    expect(c.can('ai.email')).toBe(true)
    expect(c.can('projects.view')).toBe(true)
    expect(c.can('ai.email_send')).toBe(false)
  })

  it('only grantable AI keys count — anything else on the document is ignored', async () => {
    const db = new FakeDb()
    seedUser(db, 'eng', [])
    db.seed('user_access', [{ id: 'eng', user_id: 'eng', perms: ['users.manage', 'finance.approve', 'ai.email_send'] }])
    const c = await requireCaller(db.asDb(), 'eng', [])
    expect(c.can('users.manage')).toBe(false)
    expect(c.can('finance.approve')).toBe(false)
    // send implies email + view
    expect(c.can('ai.email_send') && c.can('ai.email') && c.can('ai.view')).toBe(true)
  })

  it('a grant does not help an inactive user', async () => {
    const db = new FakeDb()
    seedUser(db, 'old', [], { active: false })
    db.seed('user_access', [{ id: 'old', user_id: 'old', perms: ['ai.view', 'ai.email'] }])
    await expect(requireCaller(db.asDb(), 'old', ['ai.email'])).rejects.toMatchObject({ code: 'permission-denied' })
  })
})

describe('usersWithPerm with per-user grants', () => {
  it('includes active users granted the permission individually', async () => {
    const db = new FakeDb()
    seedUser(db, 'md', ['ai.view'])
    seedUser(db, 'qs', [])
    seedUser(db, 'gone', [], { active: false })
    db.seed('user_access', [
      { id: 'qs', user_id: 'qs', perms: ['ai.view', 'ai.email'] },
      { id: 'gone', user_id: 'gone', perms: ['ai.view'] },
    ])
    expect((await usersWithPerm(db.asDb(), 'ai.view')).sort()).toEqual(['md', 'qs'])
    expect(await usersWithPerm(db.asDb(), 'ai.email')).toEqual(['qs'])
  })
})

describe('normalizeUserGrant', () => {
  it('drops unknown keys, adds the implied ones, sorts', () => {
    expect(normalizeUserGrant(['ai.email_send', 'hr.manage'])).toEqual(['ai.email', 'ai.email_send', 'ai.view'])
    expect(normalizeUserGrant(['ai.manage'])).toEqual(['ai.manage', 'ai.view'])
    expect(normalizeUserGrant([])).toEqual([])
  })
})
