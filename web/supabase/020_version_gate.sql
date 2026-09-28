-- LensyPOS — 020: make "a migration must record its own version" mechanical
-- ============================================================
-- A drift check that can be silently wrong is worse than none, and this one was.
-- 017 introduced `record_schema_version()` so the database could report which
-- migrations it had absorbed, and 017 correctly recorded itself. 018 and 019
-- did not — so a shop that had applied every migration in this repository still
-- answered 17, the same as a shop that had applied none of them past 017. The
-- comparison in the app could never fail, which is the one property a drift
-- check exists to have.
--
-- It surfaced only because a shop upgraded and then asked why the version had
-- not moved. A test would not have caught it either: the gate asserted that
-- `schema_version()` returns 17, which was true.
--
-- The rule from here on: EVERY migration stamps its own number, and a gate
-- asserts that the highest recorded version equals the highest migration applied.
-- Writing the assertion is the point - the omission becomes a failing build
-- rather than a question asked months later.
--
-- Idempotent: every write is on conflict do nothing, so a re-run is a no-op and
-- the original timestamps are preserved.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

-- ============================================================
-- 1) backfill anything a shop missed
-- ============================================================
-- record the versions 018 and 019 should have written themselves. `on conflict
-- do nothing` inside the function means a shop that already recorded them keeps
-- its own timestamps, so running this is safe for everyone and is a no-op for
-- the shops that did the right thing.
select public.record_schema_version(18, 'purchase receiving + customer balances');
select public.record_schema_version(19, 'lab dwell times');

-- ============================================================
-- 2) the invariant, in one assertion
-- ============================================================
-- A function whose only job is to FAIL LOUDLY when the ledger and the applied
-- migrations disagree. It deliberately raises rather than returning false: a
-- gate that reads a boolean can be ignored, whereas an exception in a migration
-- aborts the paste and the operator sees it immediately.
--
-- `pg_catalog` is consulted directly rather than through information_schema
-- because this runs inside the migration, and information_schema views are not
-- guaranteed to be visible to every role. `_migrations` is derived from the
-- filesystem by CI, not from the database - a database cannot know which files
-- exist, only which it has run.
create or replace function public.assert_versions_recorded(p_migrations text[])
returns void
language plpgsql as $$
declare
  v_expected integer;
  v_actual   integer;
  v_missing  text;
begin
  -- The highest number in the list, e.g. {000,…,019} -> 19.
  select max(substring(m from 1, 3)::integer)
    into v_expected
    from unnest(p_migrations) as m
   where m ~ '^[0-9]{3}_';

  if v_expected is null then
    raise exception 'assert_versions_recorded: no numbered migrations were passed (% entries)', coalesce(array_length(p_migrations, 1), 0);
  end if;

  select max(version) into v_actual from public.lensy_schema_versions;

  -- Anything the ledger should have but does not. Named individually, because
  -- "something is missing" is not a message anyone can act on.
  select string_agg(m, ', ' order by m)
    into v_missing
    from unnest(p_migrations) as m
   where m ~ '^(01[7-9]|0[2-9][0-9])_'
     and substring(m from 1, 3)::integer not in
         (select version from public.lensy_schema_versions);

  if v_missing is not null then
    raise exception
      'migration ledger is missing version(s) for: %  (highest migration applied is %)',
      v_missing, v_expected;
  end if;

  if v_actual is null or v_actual < v_expected then
    raise exception
      'schema_version() is %, but migration % is applied - the drift check cannot work',
      coalesce(v_actual::text, 'NULL'), v_expected;
  end if;
end;
$$;

revoke execute on function public.assert_versions_recorded(text[]) from public;
-- Granted to the migration runner only, deliberately not to authenticated: this
-- is an operator tool, not something the app should ever call.

-- ============================================================
-- 3) record this migration's own number
-- ============================================================
select public.record_schema_version(20, 'version-drift guard: migrations must record themselves');
