// Supabase Edge Function: create-user
// =====================================================================
// Lets a signed-in staff member create a new login from the web app, without
// anyone needing access to the Supabase dashboard. Creating auth users requires
// the service-role key, which must NEVER ship to the browser - so it lives here,
// server-side.
//
// SECURITY (PHASED_ROADMAP Phase 3, threat T16)
// ---------------------------------------------
// The first version checked only that a JWT existed, then took role_id and
// store_id straight from the request body. Any signed-in cashier could POST
// here and mint themselves an admin login - in another tenant if they chose -
// and then walk straight past every RLS policy through that new account.
//
// Now the two jobs are strictly separated:
//   1. AUTHORISATION is asked of the database AS THE CALLER, through a client
//      built from the anon key and the caller's own JWT. That client cannot see
//      anything the caller could not already read, so it cannot lie to us.
//   2. The service-role key is used ONLY to create the auth user and mirror the
//      row. It never decides anything.
//
// The rules live in ./authz.ts, beside this file - pure, no Deno or Supabase
// imports, so the deploy bundles them with a same-directory import that always
// resolves, and web/src/lib/createUserAuthz.test.ts still type-checks and covers
// them (TypeScript follows imports into any file). This file only gathers the
// facts and applies the verdict.
//
// Deploy:  supabase functions deploy create-user --project-ref qhbprvavoudetjbyxrsn
// (SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected.)
//
// Requires migration 029 (checked role assignment), plus the earlier RPCs. Before it
// is applied the required functions do not exist and creation fails closed.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  authorizeCreateUser,
  rpcValue,
  type CreateUserCaller,
} from './authz.ts'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json()
    const token = req.headers.get('authorization') ?? ''

    // --- 1. who is calling, asked as them -------------------------------
    const asCaller = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { authorization: token } } },
    )

    const uid = rpcValue(await asCaller.rpc('auth_uid')) as string | null
    if (!uid) return json({ error: 'not signed in' }, 401)
    const storeId = rpcValue(await asCaller.rpc('auth_store_id')) as string | null
    const isPlatformAdmin = rpcValue(await asCaller.rpc('is_platform_admin')) === true
    const canCreateStaff = rpcValue(await asCaller.rpc('resolve_can', { p_code: 'staff.create' })) === true
    const canAssignRoles = rpcValue(await asCaller.rpc('resolve_can', { p_code: 'staff.edit' })) === true
    if (!isPlatformAdmin && rpcValue(await asCaller.rpc('license_write_ok', { p_store: storeId })) !== true) {
      return json({ error: 'Store licence does not allow writes' }, 403)
    }

    const caller: CreateUserCaller = {
      uid: uid ?? null,
      isPlatformAdmin,
      canCreateStaff,
      canAssignRoles,
      storeId: storeId ?? null,
    }

    // --- 2. the plan's seat limit, counted in SQL ----------------------
    // Server-side quota check. Concurrent onboarding still needs a database
    // reservation if strict atomic seat limits become a requirement.
    let plan: { maxStaff: number | null; currentStaff: number } | undefined
    if (storeId) {
      const licences = rpcValue(await asCaller.rpc('my_store_license'))
      const row = (licences ?? [])[0] as { max_staff: number | null } | undefined
      const { count, error: countError } = await asCaller
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
      if (countError) throw countError
      plan = { maxStaff: row?.max_staff ?? null, currentStaff: count ?? 0 }
    }

    const domain = Deno.env.get('AUTH_EMAIL_DOMAIN') ?? 'lensypos.local'
    const verdict = authorizeCreateUser(caller, body, { domain, plan })
    if (!verdict.ok) {
      return json({ error: verdict.error }, verdict.status)
    }
    if (verdict.roleId && rpcValue(await asCaller.rpc('can_assign_role', {
      p_role: verdict.roleId, p_store: verdict.storeId,
    })) !== true) return json({ error: 'Cannot assign this position' }, 403)

    // --- 3. only now, with the service-role key -------------------------
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data, error } = await admin.auth.admin.createUser({
      email: verdict.email,
      password: String(body.password ?? ''),
      email_confirm: true,
      user_metadata: {
        username: String(body.username ?? ''),
        full_name: body.full_name ?? '',
      },
    })
    if (error) throw error

    // store_id is the PINNED value from the verdict, never the request body.
    const { error: mirrorErr } = await admin.from('users').insert({
      id: data.user.id,
      username: String(body.username ?? ''),
      full_name: body.full_name ?? '',
      password_hash: 'supabase-auth', // the password is owned by Supabase Auth
      role_id: verdict.roleId,
      store_id: verdict.storeId,
      is_active: true,
    })
    if (mirrorErr) {
      // Never leave a usable Auth login behind that the app cannot see.
      await admin.auth.admin.deleteUser(data.user.id)
      throw mirrorErr
    }

    return json({
      user: { id: data.user.id, username: body.username, store_id: verdict.storeId },
      role_granted: verdict.roleGranted,
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Failed to create user' }, 400)
  }
})
