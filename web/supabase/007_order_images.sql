-- LensyPOS — 007: order images (prescription paper + frame picture)
-- ==================================================================
-- Each order carries TWO photo slots: the prescriptions paper and the
-- glasses frame picture. Files live in the existing public 'prescriptions'
-- Storage bucket; these columns only hold the paths.
-- Idempotent: safe to run multiple times.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

alter table public.sales
    add column if not exists rx_image_path text;
alter table public.sales
    add column if not exists frame_image_path text;
