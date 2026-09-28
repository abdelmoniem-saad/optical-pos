-- LensyPOS — 021: a supported way to create the FIRST platform admin
-- ============================================================
-- A locked table with no key is a locked door. That is what platform_admins
-- became, and it is a good table to be locked — it is the one table whose
-- contents bypass every other policy.
--
-- How it got that way
-- -------------------
-- 008 auto-promotes a `superadmin` staff row into platform_admins. It does so at
-- MIGRATION time, a few lines above the statement that enables RLS on the table,
-- so the insert lands while the table is still wide open. That window closes the
-- moment the migration finishes, and the table's only policy is
--
--     using (is_platform_admin())
--
-- which is the correct policy and leaves nobody able to satisfy it:
--
--     the SQL Editor, as a normal role  -> 42501 new row violates RLS
--     the Table Editor                 -> the same policy, applied to the owner
--     CREATE POLICY, to open a door    -> 42501 must be owner of table
--
-- So the first vendor account could only ever be created by a role that happens
-- to be the table owner AND able to bypass RLS, and the only practical route
-- found was holding the service-role key — the master key, in a browser-shaped
-- problem.
--
-- What this does
-- --------------
-- bootstrap_platform_admin(email) creates that first account, and refuses to
-- create ANY account once one exists. That refusal is the whole point: it makes
-- the function worthless as a backdoor after setup, so leaking the name (or
-- granting execute on it by mistake) buys an attacker nothing. After bootstrap
-- the only way to add a vendor is deliberately, as a superuser, by hand.
--
-- It also creates the public.users staff row, because the browser cannot. The
-- INSERT policy on public.users requires a store or platform admin, so a
-- first-time login's own attempt is always refused — which is why a brand-new
-- account can end up with no staff record at all and be told it is "not linked
-- to a store". Here the definer can write it, so the account is whole from the
-- first sign-in.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.
--   Then, with the editor's "Run as" set to postgres, call it ONCE:
--     select * from public.bootstrap_platform_admin('vendor@lensypos.local');
--   It raises if any platform admin already exists, which is the intended
--   behaviour after bootstrap, not a failure.
--
-- Deliberately NOT called by this file: calling it here would make the
-- migration refuse to re-paste, and a hand-pasted migration that cannot be
-- re-run is the one failure mode this repository treats as unforgivable.
-- Idempotent: re-pasting redefines the function and changes nothing else.

create or replace function public.bootstrap_platform_admin(p_email text)
returns table (auth_uid uuid, username text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid;
  v_uname text;
  v_n     integer;
begin
  -- ===== the guard ====================================================
  -- Counted before anything is written, so a refused call leaves no trace.
  select count(*)::integer into v_n from public.platform_admins;
  if v_n > 0 then
    raise exception
      'bootstrap_platform_admin: % platform admin(s) already exist, so this refuses. It only ever creates the FIRST one. To add another, insert into public.platform_admins directly as a superuser.', v_n;
  end if;

  if p_email is null or btrim(p_email) = '' then
    raise exception 'bootstrap_platform_admin: pass the email of an existing Supabase Auth login';
  end if;

  -- The login must already exist: this grants a role, it does not create a
  -- credential, and a password cannot be created or recovered from SQL.
  select a.id, nullif(btrim(split_part(a.email, '@', 1)), '')
    into v_uid, v_uname
    from auth.users a
   where lower(a.email) = lower(btrim(p_email))
   limit 1;

  if v_uid is null then
    raise exception
      'bootstrap_platform_admin: no Supabase Auth login with the email % - create the user in the dashboard first, then run this', btrim(p_email);
  end if;

  v_uname := coalesce(v_uname, 'platform');

  -- ===== the grant ====================================================
  insert into public.platform_admins (auth_uid, name)
  values (v_uid, v_uname);

  -- ===== the staff row the browser cannot write =======================
  -- Same key, same conventions as ensureStaffRecord() in auth.tsx. Left
  -- store-less on purpose: a vendor belongs to no shop, and that is what lets
  -- is_platform_admin() (and not a store) decide what they can see.
  insert into public.users (id, username, password_hash, full_name, is_active)
  values (v_uid, v_uname, 'supabase-auth', v_uname, true)
    on conflict do nothing;

  if not found then
    -- A staff row of this name already exists under a DIFFERENT id — almost
    -- always the orphan left by a deleted login. Said out loud rather than
    -- swallowed, because silently keeping the mismatch is what produces the
    -- "not linked to a store" screen in the first place.
    raise notice
      'bootstrap_platform_admin: platform grant is in place, but a staff row named % already exists under another id and was left alone - run 015_link_staff_ids() to reconcile it', v_uname;
  end if;

  return query select v_uid, v_uname;
end $$;

-- Executable by the migration runner ONLY. This creates the account that
-- bypasses every policy in the schema; leaving it callable by a client would be
-- the exact hole it exists to close.
revoke execute on function public.bootstrap_platform_admin(text) from public, anon, authenticated;

-- ============================================================
-- record this migration's own number
-- ============================================================
select public.record_schema_version(21, 'first-platform-admin bootstrap (refuses once one exists)');
