-- LensyPOS — 010: custom ordering for the optical settings lists
-- ==============================================================
-- Adds a persistent sort_order to lens types and frame colors so the
-- Settings tab can support drag-and-drop reordering (custom view) while the
-- alphabetical view stays a display-only toggle.
-- Idempotent: safe to run multiple times.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

alter table public.lens_types
    add column if not exists sort_order integer;
alter table public.frame_colors
    add column if not exists sort_order integer;

-- Backfill: keep the current alphabetical order as the starting custom order.
update public.lens_types lt
set sort_order = x.rn
from (
    select id, row_number() over (order by name) as rn
    from public.lens_types
) x
where x.id = lt.id and lt.sort_order is null;

update public.frame_colors fc
set sort_order = x.rn
from (
    select id, row_number() over (order by name) as rn
    from public.frame_colors
) x
where x.id = fc.id and fc.sort_order is null;