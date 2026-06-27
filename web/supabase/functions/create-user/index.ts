// Supabase Edge Function: create-user
// =====================================
// Lets a signed-in staff member create a new login from the web app, without
// anyone needing access to the Supabase dashboard. Creating auth users requires
// the service-role key, which must NEVER ship to the browser — so it lives here,
// server-side. The platform verifies the caller's JWT before this runs
// (verify_jwt is on by default), so only authenticated users can call it.
//
// Deploy:  supabase functions deploy create-user
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from 'jsr:@supabase/supabase-js@2'

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
    const { username, password, full_name, role_id } = await req.json()
    if (!username || !password) return json({ error: 'username and password are required' }, 400)
    if (String(password).length < 6) return json({ error: 'password must be at least 6 characters' }, 400)

    const domain = Deno.env.get('AUTH_EMAIL_DOMAIN') ?? 'lensypos.local'
    const email = String(username).includes('@') ? String(username) : `${username}@${domain}`

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // 1) Create the Supabase Auth user (auto-confirmed, username in metadata).
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, full_name: full_name ?? '' },
    })
    if (error) throw error

    // 2) Mirror into public.users so the Staff screen lists them, and so a sale
    //    can reference a real cashier id (same UUID as auth.users).
    await admin.from('users').insert({
      id: data.user.id,
      username,
      full_name: full_name ?? '',
      password_hash: 'supabase-auth', // password is owned by Supabase Auth now
      role_id: role_id ?? null,
      is_active: true,
    })

    return json({ user: { id: data.user.id, username } })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Failed to create user' }, 400)
  }
})
