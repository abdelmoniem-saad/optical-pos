-- LensyPOS — 017: a schema version the app can read
-- ============================================================
-- Migrations are applied by hand (web/supabase/SETUP.md), so the browser and
-- the database drift apart silently. Until now the app had no way to tell: it
-- guessed. When an RPC came back missing it read the PostgREST error code, and
-- in three places quietly carried on with a fallback — the worst of them
-- handing a cashier an invoice number built from the current timestamp. A
-- wrong number reaches the books, and silence about drift is how it got
-- there.
--
-- This migration gives both sides a fact to compare:
--
--   the DATABASE records which migrations it has absorbed
--   the APP     ships the version it was written against
--   anything less is a drift the UI can say out loud
--
-- The number is the migration number itself (017 -> 17), not a deployment
-- counter, so a shop that never needed 015's repair still lands on the newest
-- migration it actually has. "0" therefore means one specific, useful thing:
-- 017 was never applied, which is the case the banner most needs to catch.
--
-- Idempotent: `if not exists` + `on conflict do nothing`.
-- REQUIRES NOTHING ELSE. Safe to re-run after a half-applied paste.

-- ============================================================
-- 1) the ledger
-- ============================================================
-- One row per migration that was actually applied. Append-only history, so
-- "which migrations did this shop run, and when" is answerable later without
-- keeping the paste log.
--
-- RLS is enabled with no policies on purpose: no client may read the table
-- directly. A signed-in user should not be able to enumerate the schema of a
-- shop they are only tentatively linked to. The single number the app needs
-- comes through the RPC below instead, which is security definer.
create table if not exists public.lensy_schema_versions (
  version    integer     primary key,
  applied_at timestamptz not null default now(),
  note       text
);

alter table public.lensy_schema_versions enable row level security;
revoke all on public.lensy_schema_versions from anon, authenticated;

-- ============================================================
-- 2) the counter
-- ============================================================
-- max(version) is the current release. max(), not count(), so a shop that
-- applied 012 and then 017 reads 17 and not 2.
--
-- coalesce to 0 rather than null: "no row yet" is a state the banner has to
-- compare against, and 0 compares cleanly where null would not.
create or replace function public.schema_version()
returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(max(lensy_schema_versions.version), 0)::integer
    from public.lensy_schema_versions
$$;

-- ============================================================
-- 3) the stamp
-- ============================================================
-- Called by a migration, not by the app. `on conflict do nothing` is what
-- makes a re-run safe: re-pasting 017 records nothing new and changes no
-- timestamp, so the ledger keeps saying when it was REALLY first applied.
--
-- execute is revoked from PUBLIC because this is security definer — leaving
-- it callable would let any client invent a version number and blind the
-- banner into silence.
create or replace function public.record_schema_version(p_version integer, p_note text default null)
returns void
language sql security definer set search_path = public as $$
  insert into public.lensy_schema_versions (version, note)
  values (p_version, p_note)
  on conflict (version) do nothing
$$;

revoke execute on function public.record_schema_version(integer, text) from public, anon, authenticated;

grant execute on function public.schema_version() to anon, authenticated, service_role;

-- ============================================================
-- 4) stamp THIS migration
-- ============================================================
select public.record_schema_version(17, 'schema version ledger + drift banner');
