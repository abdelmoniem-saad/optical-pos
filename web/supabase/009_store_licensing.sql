-- LensyPOS — 009: seed licensing for the ORIGINAL shop
-- ====================================================
-- Gives the default store (the current owner) a perpetual 'pro' license so
-- the existing business keeps working untouched. NEW stores are licensed via
-- the platform page (or SQL) - they do NOT get automatic licenses.
--
-- Idempotent: safe to run multiple times.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 008).

insert into public.store_licenses
    (store_id, license_key, plan, expires_at, notes)
select
    s.id,
    'STORE-' || left(s.id::text, 8),
    'pro',
    null,                                  -- perpetual
    'Perpetual license for the original shop (auto-seeded by 009)'
from public.stores s
where s.id = (select id from public.stores order by created_at limit 1)
on conflict (store_id) do nothing;
