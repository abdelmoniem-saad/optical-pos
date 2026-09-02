-- LensyPOS — 005: editable notes
-- ==============================
-- Adds the timestamp that marks a note as edited after creation.
-- Idempotent: safe to run multiple times.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

alter table public.notes
    add column if not exists updated_at timestamptz;
