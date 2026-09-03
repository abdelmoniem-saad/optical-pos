-- LensyPOS — 006: note seen/confirm receipts
-- ==========================================
-- Lets every staff member confirm they have read a public note; the sender
-- can then see exactly who has seen it.
-- Idempotent: safe to run multiple times.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

create table if not exists public.note_seen (
    id uuid primary key default uuid_generate_v4(),
    note_id uuid not null references public.notes(id) on delete cascade,
    user_id uuid not null references public.users(id),
    seen_at timestamptz not null default now(),
    unique (note_id, user_id)
);

create index if not exists note_seen_note_idx on public.note_seen (note_id);

-- Same security model as 001_security_rls.sql.
do $$
declare
  t text;
  tables text[] := array['note_seen'];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
    execute format('drop policy if exists lensy_authenticated_all on public.%I;', t);
    execute format($p$
      create policy lensy_authenticated_all on public.%I
        for all
        to authenticated
        using (true)
        with check (true);
    $p$, t);
    raise notice 'secured table: %', t;
  end loop;
end $$;
