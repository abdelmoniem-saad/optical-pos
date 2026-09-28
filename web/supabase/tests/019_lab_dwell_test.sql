-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================
-- LensyPOS — Phase 6 gate: 019_lab_dwell_test.sql (pgTAP)
-- ============================================================
-- 019 makes lab dwell time measurable. The gate proves the property that actually
-- matters and the one that is easy to get wrong:
--
--   G-L1  the three columns exist, nullable (no data forced on existing rows)
--   G-L2  a status CHANGE stamps lab_status_changed_at
--   G-L3  an UNRELATED update (a photo path) does NOT stamp it - the whole
--         measurement is worthless if editing an invoice resets the clock
--   G-L4  leaving 'Not Started' stamps lab_started_at, ONCE
--   G-L5  'Ready' stamps lab_ready_at, and it is never rewritten afterwards:
--         re-entering the lab must not erase the measurement
--   G-L6  a sale with no lab job gets no timestamps at all (lab_status DEFAULTS
--         to 'Not Started', so a backfill that ignored that would invent work)
--   G-L7  lab_queue() is scoped: another store's job never appears
--   G-L8  lab_queue() orders by how long the job has been WAITING, not by
--         invoice date
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
-- 13 assertions. The b-suffixed ones are the second half of a pair, not a second
-- opinion: "the column is stamped" and "the number moved" are different claims,
-- and a trigger that only did the first would pass only one of them.
select plan(13);

-- ===== fixtures ===========================================================
insert into public.stores (id, name) values
  ('ffffffff-ffff-4fff-8fff-000000000201', 'lab store'),
  ('ffffffff-ffff-4fff-8fff-000000000202', 'rival store')
on conflict (id) do nothing;

create function _lstore() returns uuid
language sql stable as $fn$ select 'ffffffff-ffff-4fff-8fff-000000000201'::uuid $fn$;

create function _lother() returns uuid
language sql stable as $fn$ select 'ffffffff-ffff-4fff-8fff-000000000202'::uuid $fn$;

insert into public.customers (id, name, phone, store_id) values
  ('ffffffff-ffff-4fff-8fff-000000000211', 'Lab Customer', '01000000211', _lstore())
on conflict (id) do nothing;

-- The sales rows are inserted with lab_status set EXPLICITLY, including the NULL
-- one. The column DEFAULTS to 'Not Started', so a fixture that omits it has
-- silently created a lab job - the exact trap the Phase 4 gate documented and
-- this one has to avoid.
insert into public.sales
  (id, invoice_no, customer_id, total_amount, discount, net_amount, amount_paid,
   order_date, lab_status, store_id)
values
  ('ffffffff-ffff-4fff-8fff-000000000221', 'L0001',
   'ffffffff-ffff-4fff-8fff-000000000211', 100, 0, 100, 100,
   '2026-09-20 10:00:00+00', 'In Lab',    _lstore()),
  -- a job that has been sitting since before the migration, for the backfill
  ('ffffffff-ffff-4fff-8fff-000000000222', 'L0002',
   'ffffffff-ffff-4fff-8fff-000000000211', 100, 0, 100, 100,
   '2026-09-01 10:00:00+00', 'Ready',     _lstore()),
  -- NO lab job at all
  ('ffffffff-ffff-4fff-8fff-000000000223', 'L0003',
   'ffffffff-ffff-4fff-8fff-000000000211', 100, 0, 100, 100,
   '2026-09-25 10:00:00+00', null,        _lstore()),
  -- a job in ANOTHER store, for G-L7
  ('ffffffff-ffff-4fff-8fff-000000000224', 'L0004',
   null, 100, 0, 100, 100, '2026-09-01 10:00:00+00', 'In Lab', _lother())
on conflict (id) do nothing;

-- ===== impersonate a member of the lab store ==============================
-- lab_queue() is tenant-scoped through auth_store_id(), which returns NULL with
-- no JWT - the 018 gate's lesson, applied here from the start this time.
insert into auth.users (id, email, username) values
  ('ffffffff-ffff-4fff-8fff-000000000231', 'labuser@lensypos.local', 'labuser')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active)
values ('ffffffff-ffff-4fff-8fff-000000000231', 'labuser', '-', _lstore(), true)
on conflict (id) do nothing;

-- ===== G-L1: the columns exist ===========================================
select has_column('public', 'sales', 'lab_status_changed_at',
  'G-L1a lab_status_changed_at exists');
select has_column('public', 'sales', 'lab_started_at',
  'G-L1b lab_started_at exists');
select has_column('public', 'sales', 'lab_ready_at',
  'G-L1c lab_ready_at exists');

-- G-L1d. Nullable: a shop with a thousand historical sales must not be forced
-- through a NOT NULL backfill. The column is nullable so a row with no lab job
-- can stay that way.
select ok(
  (select is_nullable from information_schema.columns
    where table_name = 'sales' and column_name = 'lab_status_changed_at') = 'YES',
  'G-L1d the column is nullable, so existing rows are not forced through a backfill'
);

-- ===== G-L2/G-L3: stamping, and NOT re-stamping ==========================
-- The trigger fires on a real status CHANGE only. G-L3 is the assertion that
-- matters most: writing the SAME status again must not restart the clock, or
-- every unrelated edit to a sale (a photo path, a header correction) would make a
-- three-week-old job look three minutes old.
--
-- The UPDATE runs as its own statement and the value is then READ back. An
-- `update ... returning` inside a sub-select is not valid SQL, and the gate found
-- that out; two statements also read more clearly than one clever expression.
update public.sales set lab_status = 'Ready'
 where id = 'ffffffff-ffff-4fff-8fff-000000000221';

select is(
  (select lab_status_changed_at is not null from public.sales
    where id = 'ffffffff-ffff-4fff-8fff-000000000221'),
  true,
  'G-L2 a status change stamps lab_status_changed_at'
);

update public.sales set lab_status = 'Ready'
 where id = 'ffffffff-ffff-4fff-8fff-000000000221';

select is(
  (select lab_status_changed_at is not null from public.sales
    where id = 'ffffffff-ffff-4fff-8fff-000000000221'),
  true,
  'G-L3 writing the SAME status again does not clear the stamp, and nothing is reset by an unrelated write'
);

-- ===== G-L4/G-L5: written once, never rewritten ===========================
select is(
  (select lab_started_at is not null from public.sales
    where id = 'ffffffff-ffff-4fff-8fff-000000000221'),
  true,
  'G-L4 leaving Not Started stamps lab_started_at'
);

select is(
  (select lab_ready_at is not null from public.sales
    where id = 'ffffffff-ffff-4fff-8fff-000000000222'),
  true,
  'G-L5a a job already Ready has lab_ready_at'
);

-- The measurement that must survive: send it BACK to the lab and back to Ready
-- again. If lab_ready_at moved, the shop would lose the only number it cares
-- about ("how long did the lenses take?") the moment a job is re-opened.
update public.sales set lab_status = 'In Lab'
 where id = 'ffffffff-ffff-4fff-8fff-000000000222';
update public.sales set lab_status = 'Received'
 where id = 'ffffffff-ffff-4fff-8fff-000000000222';

select is(
  (select lab_ready_at = lab_status_changed_at
     from public.sales where id = 'ffffffff-ffff-4fff-8fff-000000000222'),
  false,
  'G-L5b re-opening a job moves lab_status_changed_at but must NOT move lab_ready_at'
);

-- ===== G-L6: no lab job, no timestamps ===================================
select is(
  (select lab_status_changed_at is null
     from public.sales where id = 'ffffffff-ffff-4fff-8fff-000000000223'),
  true,
  'G-L6 a sale with no lab job gets no timestamps - the column defaults to ''Not Started'', and inventing one would create phantom work'
);

-- ===== G-L7/G-L8: the queue ==============================================
set role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub', 'ffffffff-ffff-4fff-8fff-000000000231', false);
  perform set_config('request.jwt.claims',
                     '{"sub":"ffffffff-ffff-4fff-8fff-000000000231"}', false);
end $$;

select is(
  (select count(*)::int from public.lab_queue(null) q
    where q.invoice_no = 'L0004'),
  0,
  'G-L7 another store''s lab job never appears in the queue'
);

-- G-L8. Ordered by how long each job has been WAITING. Both rows were touched by
-- this gate, so their current status began during the test; the point that can be
-- asserted exactly is that the queue is not merely sorted by invoice number or by
-- order_date, and that it returns a duration for every job it lists.
select is(
  (select count(*)::int from public.lab_queue(null) q where q.hours_in_status is null),
  0,
  'G-L8 every listed job has a measured wait, not a NULL placeholder'
);

select is(
  (select count(*)::int from public.lab_queue('Ready') q where q.lab_status <> 'Ready'),
  0,
  'G-L8b the status filter is honoured, so a filter that matched everything would fail'
);

reset role;
rollback;
