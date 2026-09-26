-- LensyPOS — test harness shims (PLAIN PostgreSQL only)
-- ============================================================
-- The numbered migrations (000…012) are written for a Supabase project. This
-- file provides the handful of Supabase-provided objects they rely on, so the
-- SAME migration files run unmodified on:
--   • the throwaway postgres:16 container CI starts (scripts/test-db.sh)
--   • a local dev database
--
-- On a REAL Supabase project you never run this file — auth/, storage/ and the
-- anon / authenticated / service_role roles already exist there.
--
-- Apply BEFORE 000_base_schema.sql. Idempotent.
-- (scripts/test-db.sh applies this automatically.)

-- ---------- 1) Supabase API roles ----------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants these too: the migrations (auth_store_id → auth.uid(),
-- sale_payments.recorded_by default) and 008's storage policies resolve
-- objects in these schemas AS the calling role, so `authenticated` needs
-- USAGE on both or every checkout dies with "permission denied for schema auth".
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant select on all tables in schema auth to authenticated;

-- Everything the migrations create is owned by the connecting superuser; hand
-- `authenticated` its privileges up-front (Supabase grants the same defaults).
alter default privileges in schema public
  grant all privileges on tables to authenticated;
alter default privileges in schema public
  grant all privileges on sequences to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;

-- ---------- 2) auth schema (used by 008's auth_store_id(), 011's FKs) ----------
create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  username           text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Supabase's auth.uid(): the `sub` claim of the request JWT. Tests impersonate
-- a signed-in user with:
--   select set_config('request.jwt.claim.sub', '<auth uuid>', false);
create or replace function auth.uid() returns uuid
language sql stable parallel safe as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(
      coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'sub',
      ''
    )
  )::uuid
$$;

-- ---------- 3) storage schema (008 rewrites paths + creates a policy on it) ----------
create schema if not exists storage;

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text,
  name       text,
  owner      uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;
alter table storage.objects force row level security;
-- Deliberately NO policies here: with forced RLS and no matching policy the
-- table is default-deny for clients; 008 later adds the app's own policy.

-- Folder path of an object ('store/<id>/file.jpg' → {store,<id>}), mirroring
-- the function008's backfill and policies call.
create or replace function storage.foldername(name text) returns text[]
language sql immutable strict as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

-- ---------- 4) pgTAP (the gate suite's assertion library) ----------
create extension if not exists pgtap;
