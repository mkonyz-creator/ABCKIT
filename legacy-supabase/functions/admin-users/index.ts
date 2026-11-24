// Supabase Edge Function: privileged user administration.
// The service-role key is available ONLY here (server-side), never in the frontend bundle.
//
// Actions (POST JSON, caller must be signed in and hold the `users.manage` permission):
//   { action: 'invite', email, full_name, role_key, redirect_to }
//   { action: 'set_active', user_id, active }   -> also bans/unbans the auth user so sessions stop refreshing
//
// Deploy:  npx supabase functions deploy admin-users
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-application-name',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const ROLE_KEYS = new Set([
  'super_admin', 'managing_director', 'project_manager', 'site_engineer', 'quantity_surveyor',
  'accountant', 'procurement_officer', 'storekeeper', 'hr_officer', 'employee',
])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authHeader = req.headers.get('Authorization') ?? ''

  // 1. Identify the caller with THEIR token and check permission through the database
  const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const { data: userData, error: userErr } = await caller.auth.getUser()
  if (userErr || !userData.user) return json({ error: 'Not signed in' }, 401)
  const { data: allowed, error: permErr } = await caller.rpc('has_permission', { perm: 'users.manage' })
  if (permErr) return json({ error: permErr.message }, 500)
  if (!allowed) return json({ error: 'You do not have permission to manage users' }, 403)

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  try {
    if (body.action === 'invite') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const fullName = String(body.full_name ?? '').trim().slice(0, 200)
      const roleKey = String(body.role_key ?? 'employee')
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Invalid email' }, 400)
      if (fullName.length < 2) return json({ error: 'Full name is required' }, 400)
      if (!ROLE_KEYS.has(roleKey)) return json({ error: 'Unknown role' }, 400)
      // Only a super admin may create another super admin
      if (roleKey === 'super_admin') {
        const { data: me } = await admin.from('profiles').select('role:roles(key)').eq('id', userData.user.id).single()
        if ((me as any)?.role?.key !== 'super_admin') return json({ error: 'Only a Super Administrator can invite a Super Administrator' }, 403)
      }
      const redirectTo = typeof body.redirect_to === 'string' ? body.redirect_to : undefined
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName }, redirectTo })
      if (error) return json({ error: error.message }, 400)
      // profile row is created by the on_auth_user_created trigger; now set role + activate
      const { data: role } = await admin.from('roles').select('id').eq('key', roleKey).single()
      const { error: upErr } = await admin.from('profiles').update({ role_id: role!.id, is_active: true, full_name: fullName }).eq('id', data.user.id)
      if (upErr) return json({ error: upErr.message }, 500)
      return json({ ok: true, user_id: data.user.id })
    }

    if (body.action === 'set_active') {
      const userId = String(body.user_id ?? '')
      const active = Boolean(body.active)
      if (userId === userData.user.id && !active) return json({ error: 'You cannot deactivate your own account' }, 400)
      const { error: banErr } = await admin.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : '876000h' })
      if (banErr) return json({ error: banErr.message }, 400)
      const { error } = await admin.from('profiles').update({ is_active: active }).eq('id', userId)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    console.error(e)
    return json({ error: 'Unexpected server error' }, 500)
  }
})
