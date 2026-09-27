-- LensyPOS — 015: re-point staff rows at the login they actually belong to
-- ============================================================
-- Phase 3 cut the username fallback in auth_store_id(). A staff row whose id
-- does not equal the Supabase Auth id of the same person therefore resolves to
-- NO store, and the app shows them "This account is not linked to a store".
--
-- That is exactly what happened to a real account: created by hand in the SQL
-- editor (SETUP.md step 2) with its own uuid, then signed in through Supabase
-- Auth with a different one. The old fallback papered over it by matching the
-- email's local part to the username; with that gone the mismatch is visible -
-- which is the point, but it must be REPAIRABLE, not just detectable.
--
-- This migration repairs it, in both directions:
--   1. a staff row whose id disagrees with the auth login of the same USERNAME
--      -> re-point the id, and every column that references it
--   2. a login that exists but has no staff row  -> create one
--
-- Both halves are conservative on purpose:
--   * a name is only repaired when it is UNAMBIGUOUS - exactly one staff row
--     and exactly one auth login carry that username. Anything ambiguous is
--     LEFT ALONE and reported, because guessing which of two people meant is
--     how you hand somebody's sales history to the wrong person.
--   * the password for a newly created login cannot be recovered; the row is
--     created with `password_hash = 'supabase-auth'` and a NOTICE says the
--     owner must use "Reset password" in the dashboard. Stated, not buried.
--
-- Idempotent: re-running repairs nothing and reports nothing.
-- REQUIRES 014. HOW TO RUN: SQL Editor -> paste -> Run.
-- After running, read the NOTICEs at the end - they list anything ambiguous
-- that still needs a human decision.

-- ============================================================
-- 1) the repair, as a function so it can be tested and re-run
-- ============================================================
-- Returns one row per action taken: what happened, to whom, and why.
create or replace function public.link_staff_ids()
returns table (action text, username text, detail text)
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_auth uuid;
begin
  -- ---- half 1: re-point a staff row that disagrees with its login ----
  for r in
    select u.id, u.username
      from public.users u
     where not exists (select 1 from auth.users a where a.id = u.id)
       -- and there IS an unambiguous auth login carrying this name
       and (select count(*) from public.users u2
             where u2.username = u.username) = 1
       and (select count(*) from auth.users a
             where split_part(coalesce(a.email, ''), '@', 1) = u.username) = 1
  loop
    select a.id into v_auth
      from auth.users a
     where split_part(coalesce(a.email, ''), '@', 1) = r.username
     limit 1;

    -- users.id is the primary key and six columns reference it, and NONE of
    -- those constraints is ON UPDATE CASCADE. So the references cannot be
    -- moved to the new id first - it does not exist yet - and the key cannot
    -- be moved first either, because the references would be orphaned. The
    -- constraints come off, everything moves, and they go back on: all inside
    -- this one transaction, so a failure rolls the drops back with it.
    alter table public.sales            drop constraint if exists sales_user_id_fkey;
    alter table public.notes            drop constraint if exists notes_created_by_fkey;
    alter table public.notes            drop constraint if exists notes_user_id_fkey;
    alter table public.note_seen        drop constraint if exists note_seen_user_id_fkey;
    alter table public.licenses         drop constraint if exists licenses_created_by_fkey;
    alter table public.user_permissions drop constraint if exists user_permissions_user_id_fkey;

    update public.users      set id      = v_auth where id      = r.id;
    update public.sales      set user_id  = v_auth where user_id  = r.id;
    update public.notes      set created_by = v_auth where created_by = r.id;
    update public.notes      set user_id  = v_auth where user_id  = r.id;
    update public.note_seen  set user_id  = v_auth where user_id  = r.id;
    update public.licenses   set created_by = v_auth where created_by = r.id;
    update public.user_permissions set user_id = v_auth where user_id = r.id;
    update public.audit_log  set actor    = v_auth where actor    = r.id;

    -- back on, with the exact definitions they had (two of them cascade)
    alter table public.sales add constraint sales_user_id_fkey
      foreign key (user_id) references public.users(id);
    alter table public.notes add constraint notes_created_by_fkey
      foreign key (created_by) references public.users(id);
    alter table public.notes add constraint notes_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
    alter table public.note_seen add constraint note_seen_user_id_fkey
      foreign key (user_id) references public.users(id);
    alter table public.licenses add constraint licenses_created_by_fkey
      foreign key (created_by) references public.users(id);
    alter table public.user_permissions add constraint user_permissions_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;

    action   := 're-pointed';
    username := r.username;
    detail   := 'public.users.id now matches the Supabase Auth login of the same name';
    return next;
  end loop;

  -- ---- half 2: an existing login with no staff row -------------------
  for r in
    select a.id, split_part(coalesce(a.email, ''), '@', 1) as username
      from auth.users a
     where not exists (select 1 from public.users u where u.id = a.id)
       and a.email is not null
       -- unambiguous: this login's name is unique, and nobody holds it already
       and (select count(*) from auth.users a2
             where split_part(coalesce(a2.email, ''), '@', 1)
                   = split_part(coalesce(a.email, ''), '@', 1)) = 1
       and (select count(*) from public.users u2
             where u2.username = split_part(coalesce(a.email, ''), '@', 1)) = 0
       and exists (select 1 from public.stores s)   -- never invent a store
  loop
    insert into public.users (id, username, password_hash, full_name, store_id, is_active)
    select r.id,
           r.username,
           'supabase-auth',                       -- no usable password: see NOTICE
           null,
           (select s.id from public.stores s order by s.created_at limit 1),
           true;

    action   := 'login-linked';
    username := r.username;
    detail   := 'staff row created for an existing login; the owner must use'
            || ' "Reset password" in the Supabase dashboard to set one';
    return next;
  end loop;

  return;
end $$;

-- ============================================================
-- 2) run it, and say what it did
-- ============================================================
do $$
declare
  v_link record;
  v_n integer := 0;
begin
  for v_link in select * from public.link_staff_ids() loop
    raise notice '%: % (%)', v_link.action, v_link.username, v_link.detail;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    raise notice 'link_staff_ids: nothing to repair - every staff row already matches a login';
  end if;
end $$;

-- ============================================================
-- 3) what still needs a human
-- ============================================================
-- Deliberately a SELECT, not a repair: an ambiguous name has more than one
-- possible owner, and picking one would hand somebody else's sales history to
-- the wrong person. Read it, then decide.
create or replace view public.staff_id_problems as
select u.id,
       u.username,
       u.store_id,
       (select count(*) from auth.users a
         where split_part(coalesce(a.email, ''), '@', 1) = u.username)
         as logins_with_this_name,
       (select count(*) from public.users u2
         where u2.username = u.username) as staff_rows_with_this_name
  from public.users u
 where not exists (select 1 from auth.users a where a.id = u.id);

grant select on public.staff_id_problems to authenticated;
