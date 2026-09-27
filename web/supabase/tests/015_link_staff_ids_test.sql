-- LensyPOS — Phase 3b gate: 015_link_staff_ids_test.sql (pgTAP)
-- ============================================================
-- Phase 3 cut the username fallback in auth_store_id(), which turned a silent
-- mismatch into a visible one: a staff row whose id is not the Supabase Auth id
-- of the same person now resolves to no store, and the account sees "This
-- account is not linked to a store".
--
-- That is only acceptable if the mismatch is REPAIRABLE. This gate proves what
-- the repair does and, more importantly, what it refuses to do:
--   G1-G3  a mismatched staff row is re-pointed, and the six foreign keys
--           that point at users.id follow it
--   G4     an AMBIGUOUS name is left alone - guessing which of two people meant
--           is how you hand somebody's sales history to the wrong person
--   G5     a login with no staff row gets one
--   G6     re-running repairs nothing
--   G7     the problem view lists only what is still unlinked
--
-- Everything runs inside ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
select plan(17);

-- ===== fixtures ============================================================
-- The real account that triggered this: a staff row created by hand with its
-- own uuid (SETUP.md step 2), and a Supabase Auth login of the same name with a
-- different one. Here, exactly as in production: DIFFERENT ids.
create function _store() returns uuid
language sql stable as $$
  select id from public.stores order by created_at limit 1
$$;

insert into auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8eee-000000000001', 'mismatch@lensypos.local', 'mismatch'),
  ('eeeeeeee-eeee-4eee-8eee-000000000002', 'clash@lensypos.local',     'clash'),
  ('eeeeeeee-eeee-4eee-8eee-000000000003', 'clash2@lensypos.local',    'clash2'),
  ('eeeeeeee-eeee-4eee-8eee-000000000004', 'orphan@lensypos.local',    'orphan')
on conflict (id) do nothing;

-- The staff row for 'mismatch' carries the WRONG id...
insert into public.users (id, username, password_hash, full_name, store_id, is_active)
values ('eeeeeeee-eeee-4eee-8eee-0000000000ff', 'mismatch', '-', 'Mismatch', _store(), true)
on conflict (id) do nothing;

-- ...and something worth keeping hangs off it, so we can watch the references
-- follow rather than break.
insert into public.notes (id, body, user_id, created_by, store_id)
values ('eeeeeeee-eeee-4eee-8eee-0000000000aa', 'keep me',
        'eeeeeeee-eeee-4eee-8eee-0000000000ff', 'eeeeeeee-eeee-4eee-8eee-0000000000ff', _store())
on conflict (id) do nothing;

-- An AMBIGUOUS case: two auth logins share the local part 'clash'.
insert into public.users (id, username, password_hash, store_id, is_active)
values ('eeeeeeee-eeee-4eee-8eee-0000000000bb', 'clash', '-', _store(), true)
on conflict (id) do nothing;

-- 'orphan' deliberately has a login and no staff row.

-- ===== G0-G2: the unambiguous mismatch is repaired =====================
select is((select count(*) from public.users u
            where not exists (select 1 from auth.users a where a.id = u.id)
              and u.username = 'mismatch')::bigint, 1::bigint,
  'G0 the fixture really is mismatched before the repair runs');

select is((select count(*) from public.link_staff_ids()
             where action = 're-pointed' and username = 'mismatch')::bigint, 1::bigint,
  'G1 the unambiguous mismatch is re-pointed');

select is((select count(*) from public.users
            where id = 'eeeeeeee-eeee-4eee-8eee-000000000001'
              and username = 'mismatch')::bigint, 1::bigint,
  'G2 the staff row now carries the login id');

-- ===== G3: the references followed ======================================
select is((select user_id::text from public.notes
            where id = 'eeeeeeee-eeee-4eee-8eee-0000000000aa'),
  'eeeeeeee-eeee-4eee-8eee-000000000001',
  'G3a notes.user_id followed the re-pointed id');
select is((select created_by::text from public.notes
            where id = 'eeeeeeee-eeee-4eee-8eee-0000000000aa'),
  'eeeeeeee-eeee-4eee-8eee-000000000001',
  'G3b notes.created_by followed the re-pointed id');
select is((select body from public.notes where id = 'eeeeeeee-eeee-4eee-8eee-0000000000aa'),
select is((select body from public.notes where id = 'eeeeeeee-eeee-4eee-8eee-0000000000aa'),
  'keep me', 'G3c the note itself survived');

-- ===== G3d: the constraints came back ================================
-- The repair drops six foreign keys to re-point the id, because none of them
-- is ON UPDATE CASCADE. If it forgot to put one back, the database would be
-- quietly less protected than before - so the count is asserted, not assumed.
select is((select count(*) from pg_constraint
            where conname in ('sales_user_id_fkey', 'notes_created_by_fkey',
                              'notes_user_id_fkey', 'note_seen_user_id_fkey',
                              'licenses_created_by_fkey',
                              'user_permissions_user_id_fkey')
              and contype = 'f')::bigint, 6::bigint,
  'G3d all six foreign keys onto users.id are back in place');
select is((select count(*) from pg_constraint
            where conname = 'notes_user_id_fkey'
              and confdeltype = 'c')::bigint, 1::bigint,
  'G3e the two that cascade still cascade afterwards');
-- ===== G4: an ambiguous name is left alone ============================
select is((select count(*) from public.users
            where id = 'eeeeeeee-eeee-4eee-8eee-0000000000bb'
              and username = 'clash')::bigint, 1::bigint,
  'G4a an ambiguous name is NOT re-pointed - two logins could mean either');
select is((select count(*) from public.users
            where id = 'eeeeeeee-eeee-4eee-8eee-0000000000bb')::bigint, 1::bigint,
  'G4b ...and the staff row still points at its own id');

-- ===== G5: a login with no staff row gets one =========================
select is((select count(*) from public.link_staff_ids()
             where action = 'login-linked' and username = 'orphan')::bigint, 1::bigint,
  'G5 a login with no staff row gets one');
select is((select store_id from public.users
            where id = 'eeeeeeee-eeee-4eee-8eee-000000000004'),
  _store(), 'G5b ...pointed at the real store, never at an invented one');
select is((select password_hash from public.users
            where id = 'eeeeeeee-eeee-4eee-8eee-000000000004'),
  'supabase-auth', 'G5c ...with no usable password, so the owner must set one');

-- ===== G6: idempotent ==================================================
select is((select count(*) from public.link_staff_ids())::bigint, 0::bigint,
  'G6 re-running repairs nothing');

-- ===== G7: the problem view shows only what is left ===================
select is((select count(*) from public.staff_id_problems)::bigint, 1::bigint,
  'G7 the problem view lists only the ambiguous clash, not the repaired ones');
select is((select username from public.staff_id_problems), 'clash',
  'G7b ...and it is the ambiguous one');

rollback;
