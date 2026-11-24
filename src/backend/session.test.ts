/**
 * Who-am-I cache: a refused / failed profile read (e.g. while the auth token cannot be refreshed) must not lock an
 * active user out — the AI said "Sign in with an active account" until a page reload.
 */
import { describe, expect, it } from 'vitest'
import { createMeCache, loadMe } from './session'
import { MemoryStore, PermissionDenied } from './store'

describe('me cache', () => {
  it('does not keep an inactive result: the next call reads the profile again', async () => {
    const store = new MemoryStore()
    store.data.set('profiles', new Map([['u1', { id: 'u1', is_active: true, role_id: 'super_admin' }]]))
    store.data.set('roles', new Map([['super_admin', { id: 'super_admin', key: 'super_admin', perms: [] }]]))
    const realGet = store.get.bind(store)
    let refuse = 1
    store.get = async (table: string, id: string) => {
      if (table === 'profiles' && refuse-- > 0) throw new PermissionDenied('Missing or insufficient permissions.')
      return realGet(table, id)
    }
    const cache = createMeCache(store, () => ({ uid: 'u1', email: 'a@b.c' }))
    expect((await cache.get())?.active).toBe(false)
    await Promise.resolve()
    const me = await cache.get()
    expect(me).toMatchObject({ uid: 'u1', active: true, roleKey: 'super_admin' })
    // an active result is cached
    expect(await cache.get()).toBe(me)
  })
})

describe('per-user access grants (User Management → Email access)', () => {
  const setup = (perms: unknown[] | null, active = true) => {
    const store = new MemoryStore()
    store.data.set('profiles', new Map([['u1', { id: 'u1', is_active: active, role_id: 'site_engineer' }]]))
    store.data.set('roles', new Map([['site_engineer', { id: 'site_engineer', key: 'site_engineer', perms: ['projects.view'] }]]))
    if (perms) store.data.set('user_access', new Map([['u1', { id: 'u1', user_id: 'u1', perms }]]))
    return store
  }

  it('adds the granted AI permissions to the role permissions', async () => {
    const me = await loadMe(setup(['ai.email_send']), { uid: 'u1', email: null })
    expect(me.can('projects.view')).toBe(true)
    // send implies email access and the AI page
    expect(me.can('ai.email_send') && me.can('ai.email') && me.can('ai.view')).toBe(true)
    expect(me.can('ai.manage')).toBe(false)
  })

  it('ignores keys that cannot be granted per user, and grants of inactive users', async () => {
    expect((await loadMe(setup(['users.manage', 'finance.approve']), { uid: 'u1', email: null })).can('users.manage')).toBe(false)
    expect((await loadMe(setup(['ai.email'], false), { uid: 'u1', email: null })).can('ai.email')).toBe(false)
  })
})
