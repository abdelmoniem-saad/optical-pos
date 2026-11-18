// Supabase Edge Function: create-user
// =====================================
// Lets a signed-in staff member create a new login from the web app, without
// anyone needing access to the Supabase dashboard. Creating auth users requires
// the service-role key, which must NEVER ship to the browser — so it lives here,
// server-side. The platform verifies the caller's JWT before this runs
// (verify_jwt = true in supabase/config.toml).
//
// The service-role key bypasses Row-Level Security, so THIS FUNCTION is the
// security boundary. It enforces, server-side:
//   • store staff can only add people to THEIR OWN store (the store_id sent by
//     the browser is never trusted); only platform (vendor) admins may target
//     another store - that is how the Platform page creates a store's first admin;
//   • the caller must be allowed to manage staff: an Admin/Owner position, the
//     reserved 'superadmin' account, an account with no position (the app's
//     break-glass rule), or an explicit staff.create / staff.edit grant;
//   • the chosen position must belong to that store, and only an admin may
//     create another admin (or a position-less, i.e. fully trusted, account);
//   • the store's license must allow writes and its max_staff limit is honoured;
//   • if the staff row can't be written, the new login is deleted again, so no
//     orphan accounts are left behind.
//
// Deploy:  supabase functions deploy create-user --project-ref qhbprvavoudetjbyxrsn
// (or paste this file into Dashboard -> Edge Functions -> create-user -> Deploy).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  })
}

const ADMIN_ROLE_NAMES = ['admin', 'owner']
const isAdminRoleName = (name: unknown) => ADMIN_ROLE_NAMES.includes(String(name ?? '').trim().toLowerCase())

type StaffRow = {
  id: string
  username: string | null
  role_id: string | null
  store_id: string | null
  is_active: boolean | null
}

/**
 * The caller's staff row - same resolution as public.auth_staff_id()
 * (migration 011): own id, explicit auth_uid link, or the exact staff email.
 */
async function callerStaffRow(
  admin: SupabaseClient,
  authUid: string,
  email: string,
  domain: string,
): Promise<StaffRow | null> {
  const cols = 'id, username, role_id, store_id, is_active'
  const { data: byId } = await admin.from('users').select(cols).eq('id', authUid).maybeSingle<StaffRow>()
  if (byId) return byId
  const { data: linked, error: linkErr } = await admin.from('users').select(cols).eq('auth_uid', authUid).limit(1)
  if (!linkErr && linked?.length) return linked[0] as StaffRow
  // Staff logins are <username>@<staff domain>; a username may also be a full email.
  const lower = email.toLowerCase()
  const name = lower.endsWith(`@${domain}`) ? lower.slice(0, -(domain.length + 1)) : lower
  if (!name) return null
  const pattern = name.replace(/[\\%_]/g, (c) => `\\${c}`) // exact, case-insensitive
  const { data: byName } = await admin.from('users').select(cols).ilike('username', pattern).limit(1)
  return (byName?.[0] as StaffRow | undefined) ?? null
}

/** Mirrors the app's permission rule: a per-person override wins, else the position's grant. */
async function hasStaffGrant(admin: SupabaseClient, me: StaffRow): Promise<boolean> {
  const { data: perms } = await admin.from('permissions').select('id, code').in('code', ['staff.create', 'staff.edit'])
  const ids = (perms ?? []).map((p: { id: string }) => p.id)
  if (!ids.length) return false
  const { data: overrides } = await admin
    .from('user_permissions')
    .select('permission_id, allow')
    .eq('user_id', me.id)
    .in('permission_id', ids)
  const decided = new Map<string, boolean>()
  for (const o of overrides ?? []) decided.set(o.permission_id, o.allow !== false)
  if ([...decided.values()].some(Boolean)) return true
  if (!me.role_id) return false
  const undecided = ids.filter((id) => !decided.has(id))
  if (!undecided.length) return false
  const { data: grants } = await admin
    .from('role_permissions')
    .select('permission_id')
    .eq('role_id', me.role_id)
    .in('permission_id', undecided)
  return (grants ?? []).length > 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ---- 1) who is calling --------------------------------------------------
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return json({ error: 'Not signed in' }, 401)
  const { data: who, error: whoErr } = await admin.auth.getUser(jwt)
  if (whoErr || !who?.user) return json({ error: 'Not signed in' }, 401)
  const callerUid = who.user.id
  const callerEmail = who.user.email ?? ''

  // ---- 2) the request -----------------------------------------------------
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request body' }, 400)
  }
  const username = String(body.username ?? '').trim()
  const password = String(body.password ?? '')
  const fullName = String(body.full_name ?? '').trim()
  const requestedStore = body.store_id ? String(body.store_id) : null
  const roleId = body.role_id ? String(body.role_id) : null
  if (!username || !password) return json({ error: 'username and password are required' }, 400)
  if (password.length < 6) return json({ error: 'password must be at least 6 characters' }, 400)
  if (username.length > 64 || /\s/.test(username)) return json({ error: 'Username must be one word (no spaces).' }, 400)

  // ---- 3) authorise ---------------------------------------------------------
  const domain = (Deno.env.get('AUTH_EMAIL_DOMAIN') ?? 'lensypos.local').toLowerCase()
  const { data: platformRow } = await admin
    .from('platform_admins')
    .select('auth_uid')
    .eq('auth_uid', callerUid)
    .maybeSingle()
  const isPlatform = !!platformRow

  let storeId: string
  let callerIsAdmin = isPlatform
  if (isPlatform) {
    if (!requestedStore) return json({ error: 'store_id is required' }, 400)
    const { data: store } = await admin.from('stores').select('id').eq('id', requestedStore).maybeSingle()
    if (!store) return json({ error: 'Unknown store' }, 400)
    storeId = requestedStore
  } else {
    const me = await callerStaffRow(admin, callerUid, callerEmail, domain)
    if (!me || !me.store_id || me.is_active === false) {
      return json({ error: 'Your account is not linked to an active staff record.' }, 403)
    }
    if (requestedStore && requestedStore !== me.store_id) {
      return json({ error: 'You can only add staff to your own store.' }, 403)
    }
    storeId = me.store_id
    let myRoleName: string | null = null
    if (me.role_id) {
      const { data: myRole } = await admin.from('roles').select('name').eq('id', me.role_id).maybeSingle<{ name: string }>()
      myRoleName = myRole?.name ?? null
    }
    callerIsAdmin = isAdminRoleName(myRoleName) || String(me.username ?? '').toLowerCase() === 'superadmin'
    // Break-glass rule from the app (data/permissions.tsx): no position = fully trusted.
    const allowed = callerIsAdmin || !me.role_id || (await hasStaffGrant(admin, me))
    if (!allowed) return json({ error: 'You do not have permission to add staff.' }, 403)
    if (!me.role_id) callerIsAdmin = true
  }

  // ---- 4) the position must belong to this store; no privilege escalation ----
  if (roleId) {
    const { data: role } = await admin
      .from('roles')
      .select('id, name, store_id')
      .eq('id', roleId)
      .maybeSingle<{ id: string; name: string; store_id: string | null }>()
    if (!role || role.store_id !== storeId) return json({ error: 'That position does not belong to this store.' }, 400)
    if (isAdminRoleName(role.name) && !callerIsAdmin) {
      return json({ error: 'Only an admin can create another admin.' }, 403)
    }
  } else if (!callerIsAdmin) {
    // A person with no position is fully trusted by the app - admins only.
    return json({ error: 'Choose a position for the new person.' }, 400)
  }

  // ---- 5) license + staff limit ---------------------------------------------
  const { data: writable, error: licErr } = await admin.rpc('license_write_ok', { p_store: storeId })
  if (licErr) return json({ error: 'Could not check the store license.' }, 500)
  if (!writable) return json({ error: 'The store license does not allow changes right now.' }, 403)
  const { data: lic } = await admin
    .from('store_licenses')
    .select('max_staff')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ max_staff: number | null }>()
  if (lic?.max_staff != null) {
    const { count } = await admin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .neq('is_active', false)
    if ((count ?? 0) >= lic.max_staff) {
      return json({ error: `This plan allows ${lic.max_staff} staff accounts.` }, 403)
    }
  }

  // ---- 6) create the login + its staff row (all or nothing) -----------------
  const email = username.includes('@') ? username : `${username}@${domain}`
  const staffUsername = username // stored exactly as typed (unchanged behaviour)

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username: staffUsername, full_name: fullName },
  })
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? 'Failed to create the login' }, 400)
  }

  const { error: rowErr } = await admin.from('users').insert({
    id: created.user.id,
    username: staffUsername,
    full_name: fullName,
    password_hash: 'supabase-auth', // the password is owned by Supabase Auth
    role_id: roleId,
    store_id: storeId,
    is_active: true,
  })
  if (rowErr) {
    await admin.auth.admin.deleteUser(created.user.id)
    const taken = rowErr.code === '23505'
    return json({ error: taken ? 'That username is already taken.' : rowErr.message }, 400)
  }

  return json({ user: { id: created.user.id, username: staffUsername } })
})
