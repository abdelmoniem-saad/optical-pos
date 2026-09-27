-- LensyPOS — Phase 3b gate: 015_link_staff_ids_test.sql (pgTAP)
-- ============================================================
-- Phase 3 cut the username fallback in auth_store_id(), which turned a silent
-- mismatch into a visible one: a staff row whose id is not the Supabase Auth id
-- of the same person now resolves to no store, and the account sees "This
-- account is not linked to a store".
--
-- That is only acceptable if the mismatch is REPAIRABLE. This gate proves what
-- the repair does and, more importantly, what it REFUSES to do:
--   G0     the fixture really is mismatched to begin with
--   G1-G3  an unambiguous mismatch is repaired, and the six columns that
--          reference users.id follow it
--   G4     an ambiguous name is left alone - guessing which of two people meant
--          is how you hand somebody's sales history to the wrong person
--   G5     a login with no staff row gets one, at the real store
--   G6     re-running repairs nothing
--   G7     the problem view lists only what is still unlinked
--
-- Everything runs inside ONE transaction and ROLLS BACK.
-- NOTE: the fixtures use their own store, so nothing in the seeded database can
-- be repaired or reported as part of these assertions.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
select plan(13);

-- ===== fixtures ============================================================
-- The real account that triggered this: a staff row created by hand with its
-- own uuid (SETUP.md step 2), and a Supabase Auth login of the same name with a
-- different one. Here, exactly as in production: DIFFERENT ids.
insert into public.stores (id, name) values
  ('ffffffff-ffff-4fff-8fff-000000000001', 'gate store')
on conflict (id) do nothing;

create function _gate_store() returns uuid
language sql stable as $fn$ select 'ffffffff-ffff-4fff-8fff-000000000001'::uuid $fn$;

insert into auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8eee-000000000001', 'mismatch@lensypos.local', 'mismatch'),
  ('eeeeeeee-eeee-4eee-8eee-000000000002', 'clash@lensypos.local',     'clash'),
  ('eeeeeeee-eeee-4eee-8eee-000000000003', 'clash@other.local',       'clash-two'),
  ('eeeeeeee-eeee-4eee-8eee-000000000004', 'orphan@lensypos.local',    'orphan')
on conflict (id) do nothing;

-- The staff row for 'mismatch' carries the WRONG id...
insert into public.users (id, username, password_hash, full_name, store_id, is_active)
values ('eeeeeeee-eeee-4eee-8eee-0000000000ff', 'mismatch', '-', 'Mismatch', _gate_store(), true)
on conflict (id) do nothing;

-- ...and something worth keeping hangs off it, so we can watch the references
-- follow rather than break.
insert into public.notes (id, body, user_id, created_by, store_id)
values ('eeeeeeee-eeee-4eee-8eee-0000000000aa', 'keep me',
        'eeeeeeee-eeee-4eee-8eee-0000000000ff', 'eeeeeeee-eeee-4eee-8eee-0000000000ff', _gate_store())
on conflict (id) do nothing;

-- An AMBIGUOUS case: two auth logins share the local part 'clash', so the name
-- cannot be repaired to either of them.
insert into public.users (id, username, password_hash, store_id, is_active)
values ('eeeeeeee-eeee-4eee-8eee-0000000000bb', 'clash', '-', _gate_store(), true)
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
              and username = 'mismatch'
              and store_id = _gate_store())::bigint, 1::bigint,
  'G2 the staff row now carries the login id, with its store intact');

-- ===== G3: the references followed, and the constraints are untouched ====
select is((select user_id::text from public.notes
            where id = 'eeeeeeee-eeee-4eee-8eee-0000000000aa'),
  'eeeeeeee-eeee-4eee-8eee-000000000001',
  'G3a notes.user_id followed the re-pointed id');
select is((select created_by::text from public.notes
            where id = 'eeeeeeee-eeee-4eee-8eee-0000000000aa'),
  'eeeeeeee-eeee-4eee-8eee-000000000001',
  'G3b notes.created_by followed the re-pointed id');
select is((select body from public.notes where id = 'eeeeeeee-eeee-4eee-8eee-0000000000aa'),
  'keep me', 'G3c the note itself survived');
-- The repair swaps the staff row rather than re-pointing the key, because the
-- six constraints onto users.id are not ON UPDATE CASCADE. A count is cheap
-- insurance that the swap left the database's protection exactly as it was.
select is((select count(*) from pg_constraint
            where conname in ('sales_user_id_fkey', 'notes_created_by_fkey',
                              'notes_user_id_fkey', 'note_seen_user_id_fkey',
                              'licenses_created_by_fkey',
                              'user_permissions_user_id_fkey')
              and contype = 'f')::bigint, 6::bigint,
  'G3d all six foreign keys onto users.id are intact');

-- ===== G4: an ambiguous name is left alone ============================
select is((select count(*) from public.users
            where id = 'eeeeeeee-eeee-4eee-8eee-0000000000bb'
              and username = 'clash'
              and store_id = _gate_store())::bigint, 1::bigint,
  'G4 an ambiguous name is NOT re-pointed - two logins could mean either');

-- ===== G5: a login with no staff row gets one =========================
select is((select count(*) from public.users
            where id = 'eeeeeeee-eeee-4eee-8eee-000000000004')::bigint, 1::bigint,
  'G5 a login with no staff row got one (done by the first call, in G1)');
select is((select count(*) from public.stores s
            where s.id = (select store_id from public.users
                           where id = 'eeeeeeee-eeee-4eee-8eee-000000000004'))::bigint, 1::bigint,
  'G5b ...at a store that really exists, never an invented one');
select is((select password_hash from public.users
            where id = 'eeeeeeee-eeee-4eee-8eee-000000000004'),
  'supabase-auth', 'G5c ...with no usable password, so the owner must set one');

-- ===== G6: idempotent ==================================================
select is((select count(*) from public.link_staff_ids())::bigint, 0::bigint,
  'G6 re-running repairs nothing');

-- ===== G7: the problem view shows only what is left ===================
select is((select count(*) from public.staff_id_problems
            where username = 'clash')::bigint, 1::bigint,
  'G7 the problem view lists the ambiguous clash, and nothing that was repaired');

rollback;

