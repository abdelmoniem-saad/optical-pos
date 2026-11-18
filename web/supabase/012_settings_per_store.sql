-- LensyPOS — 012: settings keys per store
-- ======================================
-- Finishes 011 for the settings table: drops the old rule that a setting key
-- (e.g. shop_name) can exist only ONCE across all stores. 011 already added
-- UNIQUE(store_id, key).
--
-- RUN ONLY AFTER the new web build (with the offline-first hardening) is
-- deployed everywhere (online app, phone view, shop PC): older builds save
-- settings with ON CONFLICT (key), which needs the old rule.
--
-- Idempotent: safe to run more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

do $$
declare
  con record;
  attn smallint;
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'settings_store_key_key' and conrelid = 'public.settings'::regclass
  ) then
    raise exception 'Run 011_multistore_hardening.sql first.';
  end if;
  select attnum into attn from pg_attribute
  where attrelid = 'public.settings'::regclass and attname = 'key' and not attisdropped;
  for con in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.settings'::regclass and c.contype = 'u' and c.conkey = array[attn]
  loop
    execute format('alter table public.settings drop constraint %I', con.conname);
  end loop;
  for con in
    select i.indexrelid::regclass::text as idx from pg_index i
    where i.indrelid = 'public.settings'::regclass
      and i.indisunique and not i.indisprimary
      and i.indnatts = 1 and i.indkey[0] = attn
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
  loop
    execute format('drop index %s', con.idx);
  end loop;
end $$;
