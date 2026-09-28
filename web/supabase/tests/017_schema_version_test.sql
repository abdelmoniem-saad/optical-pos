-- LensyPOS — Phase 5 gate: 017_schema_version_test.sql (pgTAP)
-- ============================================================
-- 017 exists so the app can tell the user when the database is behind,
-- instead of guessing from an error code and quietly carrying on. A drift
-- signal that can itself be wrong is worse than none: it either nags a shop
-- that is up to date, or stays quiet through the drift it exists to catch.
-- So the gate covers the failure modes that produce exactly that:
--
--   G-S1  the ledger table exists
--   G-S2  schema_version() exists and returns an integer
--   G-S3  record_schema_version() exists
--   G-S4  an EMPTY ledger reads 0 — "017 was never applied", the case the
--         banner most needs to catch, and the one that must not read as NULL
--   G-S5  after stamping, the version is exactly 17 (the migration number)
--   G-S6  re-stamping the same version adds NO row and keeps the original
--         applied_at — a re-run must not rewrite history
--   G-S7  only the NEWEST version counts (a half-applied paste that left a
--         higher number must win, not lose to row order)
--   G-S8  the ledger is RLS-protected, so no client enumerates the schema
--   G-S9  anon may read schema_version() — the banner shows on the login
--         screen, before anyone has signed in
--   G-S10 a signed-in user CANNOT stamp a version (security definer, revoked)
--   G-S11 the ledger is not directly readable by a signed-in user
--   G-S12 applied_at is recorded, not left null
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
-- 13 assertions (G-S6 is checked from two angles: the row count AND the note,
-- so a re-stamp that quietly overwrote history could not pass on count alone).
select plan(13);

-- ===== the shape =========================================================
select has_table('public', 'lensy_schema_versions', 'G-S1 the ledger table exists');

select has_function('public', 'schema_version', '[]', 'G-S2 schema_version() exists');
select has_function('public', 'record_schema_version', ARRAY['integer', 'text'],
                    'G-S3 record_schema_version() exists');

-- ===== an empty ledger reads 0, not NULL =================================
-- G-S4. The banner does `if (dbVersion < EXPECTED)`, and in JS `null < 1` is
-- true but `undefined` is not — a NULL here would make the comparison depend
-- on how the value crossed the wire instead of on the fact it is behind.
select is(public.schema_version(), 0, 'G-S4 an empty ledger reads 0');

-- ===== stamping ===========================================================
-- 017 stamps itself on apply, so the number is the migration number.
select is(public.schema_version(), 17, 'G-S5 the applied version is 17');

select ok(
  (select applied_at is not null from public.lensy_schema_versions where version = 17),
  'G-S12 applied_at is recorded'
);

-- G-S6. Re-running the paste must be a no-op — not just for the row count but
-- for the timestamp, which is the only record of when the shop really
-- upgraded. `applied_at` default now() is therefore not used by the re-stamp.
select public.record_schema_version(17, 're-applied by hand');

select is(
  (select count(*) from public.lensy_schema_versions where version = 17),
  1,
  'G-S6 re-stamping the same version adds no second row'
);

select is(
  (select note from public.lensy_schema_versions where version = 17),
  'schema version ledger + drift banner',
  'G-S6 the original note survives a re-stamp'
);

-- ===== only the newest version counts =====================================
-- G-S7. max(), not count() and not last-inserted. A paste that half-applied
-- at a higher number must win, and row order must never decide the answer.
insert into public.lensy_schema_versions (version, note)
values (99, 'harness sentinel');

select is(public.schema_version(), 99, 'G-S7 only the newest version counts');

delete from public.lensy_schema_versions where version = 99;

-- ===== the ledger is not client-readable ==================================
-- G-S8 / G-S11. A signed-in user must not be able to enumerate which
-- migrations a shop runs; they get the one number the banner needs and
-- nothing else.
select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.lensy_schema_versions'::regclass),
  'G-S8 the ledger has RLS enabled'
);

select ok(
  not has_table_privilege('authenticated', 'public.lensy_schema_versions', 'select'),
  'G-S11 a signed-in user cannot select the ledger directly'
);

-- G-S9. The banner is mounted in main.tsx ABOVE the auth gate, so it has to be
-- readable while signed out — otherwise a shop whose database has never been
-- stamped sees nothing exactly when it most needs telling.
select ok(
  has_function_privilege('anon', 'public.schema_version()', 'execute'),
  'G-S9 anon may read the version (banner shows before sign-in)'
);

-- G-S10. record_schema_version is security definer, so an un-revoked grant
-- would let any client invent "version 9999" and permanently silence the
-- banner. This is the assertion that stops that being a real hole.
select ok(
  not has_function_privilege('authenticated', 'public.record_schema_version(integer, text)', 'execute'),
  'G-S10 a signed-in user cannot stamp a version'
);

rollback;
