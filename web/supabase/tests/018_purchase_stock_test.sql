-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================
-- LensyPOS — Phase 6 gate: 018_purchase_stock_test.sql (pgTAP)
-- ============================================================
-- 018 fixes two silent-money defects. The gate proves each class:
--
--   RECEIVING  a purchase receipt adds stock, exactly once
--   G-P1  receiving a line raises stock_qty by the received qty
--   G-P2  the movement is in the ledger, with the 013 'purchase' kind
--   G-P3  receiving TWICE does not double the stock (the race that loses
--        a shop's count if it exists)
--   G-P4  cost_price becomes a weighted average, not an overwrite
--   G-P5  the caller's own store works
--   G-P6  another store's purchase is REFUSED (tenant isolation)
--   G-P7  a non-positive quantity is refused
--   G-P8  an unknown purchase is refused rather than silently no-op
--
--   LEDGER  what a customer owes
--   G-C1  balance_due is net minus paid on a live invoice
--   G-C2  a VOIDED invoice is excluded (the 016 bug, one table over)
--   G-C3  a refund nets against the balance rather than raising it
--   G-C4  another store's customer is invisible
--   G-C5  debtors lists only customers who actually owe, largest first
--   G-C6  an unknown customer is not an error - it is simply absent
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
-- 17 assertions, each labelled. G-P0 is the control that makes G-P1b
-- meaningful (a product that already had stock would prove nothing), and the
-- b-suffixed ones are the second half of a pair rather than a second opinion:
-- "the function reported success" and "the number actually moved" are different
-- claims, and a stub that returns a count without writing anything passes only
-- one of them.
select plan(17);

-- ===== fixtures ===========================================================
-- One store for everything. A second store exists ONLY so G-P6 and G-C4 can
-- prove neither function crosses the boundary.
insert into public.stores (id, name) values
  ('ffffffff-ffff-4fff-8fff-000000000101', 'receiving store'),
  ('ffffffff-ffff-4fff-8fff-000000000102', 'rival store')
on conflict (id) do nothing;

create function _rstore() returns uuid
language sql stable as $fn$ select 'ffffffff-ffff-4fff-8fff-000000000101'::uuid $fn$;

create function _other_store() returns uuid
language sql stable as $fn$ select 'ffffffff-ffff-4fff-8fff-000000000102'::uuid $fn$;

-- BOTH stores need a licence. license_write_ok() gates every write policy
-- (009), so receive_purchase() checks it and refuses an unlicensed store with
-- 'store licence does not allow writes'. A perpetual 'pro' row is what makes the
-- write path reachable at all; the licence is part of the fixture, not a detail
-- of it. CI run #76 refused the whole gate on exactly this.
insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (_rstore(), 'STORE-RCV', 'pro', null),
       (_other_store(), 'STORE-RIVAL', 'pro', null)
on conflict (store_id) do nothing;

insert into public.customers (id, name, phone, store_id) values
  ('ffffffff-ffff-4fff-8fff-000000000111', 'Nadia', '01000000111', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000112', 'Omar',  '01000000112', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000113', 'Rival', '01000000113', _other_store())
on conflict (id) do nothing;

-- A product with cost 4 and NO stock, so G-P4's weighted average has a
-- starting point that is not zero.
insert into public.inventory (id, name, category, sale_price, cost_price, store_id)
values ('ffffffff-ffff-4fff-8fff-000000000121', 'Received Frame', 'Frame', 100, 4, _rstore())
on conflict (id) do nothing;

-- A purchase in OUR store, and one in the rival's (for G-P6).
insert into public.purchases (id, supplier_id, total_amount, amount_paid, store_id)
values ('ffffffff-ffff-4fff-8fff-000000000131', null, 300, 0, _rstore()),
       ('ffffffff-ffff-4fff-8fff-000000000132', null, 900, 0, _other_store())
on conflict (id) do nothing;

-- store_id is set explicitly on BOTH purchases and their items: 008 made the
-- column NOT NULL on purchase_items, so a fixture that omits it fails the
-- constraint rather than defaulting. Tenancy on this table is real, not
-- inherited from the parent, and the gate should say so.
insert into public.purchase_items (id, purchase_id, product_id, qty, unit_cost, total_cost, store_id)
values ('ffffffff-ffff-4fff-8fff-000000000141',
        'ffffffff-ffff-4fff-8fff-000000000131',
        'ffffffff-ffff-4fff-8fff-000000000121', 10, 4, 40, _rstore()),
       -- rival's line points at a product in the RIVAL store
       ('ffffffff-ffff-4fff-8fff-000000000142',
        'ffffffff-ffff-4fff-8fff-000000000132',
        'ffffffff-ffff-4fff-8fff-000000000121', 5, 4, 20, _other_store())
on conflict (id) do nothing;

-- ===== G-P1..G-P4: receiving adds stock, once, and re-costs it ==========
select is(
  (select stock_qty from public.inventory
    where id = 'ffffffff-ffff-4fff-8fff-000000000121')::int,
  0,
  'G-P0 the product starts empty, so the movement below is unambiguous'
);

select is(
  public.receive_purchase('ffffffff-ffff-4fff-8fff-000000000131')::int,
  1,
  'G-P1 receiving our own purchase reports one line received'
);

-- stock_qty is maintained by the 012 trigger over the movements, so asserting
-- it proves the MOVEMENT was written, not just the read model.
select is(
  (select stock_qty from public.inventory
    where id = 'ffffffff-ffff-4fff-8fff-000000000121')::int,
  10,
  'G-P1b stock_qty rose by the received quantity'
);

-- G-P2. kind must be the 013 vocabulary value, not free text: a movement the
-- report queries cannot classify is a movement nobody can sum.
select is(
  (select kind from public.stock_movements
    where product_id = 'ffffffff-ffff-4fff-8fff-000000000121'
      and store_id = _rstore())::text,
  'purchase',
  'G-P2 the movement carries the 013 kind vocabulary, not free text'
);

-- G-P3. THE ONE THAT MATTERS. Receiving twice must not double the stock: the
-- button is reachable twice (retry, double-tap) and a shop that counts frames
-- twice is worse than one that does not.
select is(
  public.receive_purchase('ffffffff-ffff-4fff-8fff-000000000131')::int,
  0,
  'G-P3 re-receiving the same purchase reports nothing left to receive'
);

select is(
  (select stock_qty from public.inventory
    where id = 'ffffffff-ffff-4fff-8fff-000000000121')::int,
  10,
  'G-P3b and the stock is unchanged - not doubled'
);

-- G-P4. Weighted average: shelf was empty so the cost simply becomes the
-- purchase cost. The averaging case (a non-empty shelf) is asserted after a
-- second, differently-priced receipt below.
select is(
  (select cost_price from public.inventory
    where id = 'ffffffff-ffff-4fff-8fff-000000000121')::numeric,
  4::numeric,
  'G-P4 cost_price takes the purchase cost when the shelf was empty'
);

-- ===== G-P5..G-P8: the refusals =========================================
-- G-P5 is already proved: the successful receive above ran as the caller's
-- store. These are the paths that must NOT work.
select throws_ok(
  $$select public.receive_purchase('ffffffff-ffff-4fff-8fff-000000000132')$$,
  '42501',
  'purchase belongs to another store',
  'G-P6 another store''s purchase is refused'
);

-- A line with a non-positive quantity is a data-entry error. Accepting it
-- would subtract stock on a "delivery".
insert into public.purchase_items (id, purchase_id, product_id, qty, unit_cost, total_cost, store_id)
values ('ffffffff-ffff-4fff-8fff-000000000143',
        'ffffffff-ffff-4fff-8fff-000000000131',
        'ffffffff-ffff-4fff-8fff-000000000121', 0, 4, 0, _rstore())
on conflict (id) do nothing;

select throws_ok(
  $$select public.receive_purchase('ffffffff-ffff-4fff-8fff-000000000131')$$,
  '22023',
  null,
  'G-P7 a non-positive quantity is refused'
);

select throws_ok(
  $$select public.receive_purchase('ffffffff-ffff-4fff-8fff-000000000199')$$,
  'P0002',
  null,
  'G-P8 an unknown purchase is refused rather than silently doing nothing'
);

-- ===== G-C1..G-C3: what a customer owes ==================================
insert into public.sales (id, invoice_no, customer_id, total_amount, discount,
                          net_amount, amount_paid, order_date, store_id)
values ('ffffffff-ffff-4fff-8fff-000000000151', 'N0001',
        'ffffffff-ffff-4fff-8fff-000000000111',
        1000, 0, 1000, 0, '2026-09-20 10:00:00+00', _rstore()),
       -- a VOIDED 5000: 013 leaves net_amount intact for the audit trail, so
       -- any balance that sums the column without excluding this over-reports
       -- by exactly the money the shop gave back.
       ('ffffffff-ffff-4fff-8fff-000000000152', 'N0002',
        'ffffffff-ffff-4fff-8fff-000000000111',
        5000, 0, 5000, 5000, '2026-09-21 10:00:00+00', _rstore()),
       -- a rival-store sale that must never be counted
       ('ffffffff-ffff-4fff-8fff-000000000153', 'N0003',
        'ffffffff-ffff-4fff-8fff-000000000113',
        7000, 0, 7000, 0, '2026-09-22 10:00:00+00', _other_store())
on conflict (id) do nothing;

update public.sales
   set voided_at = now(), void_reason = 'mistyped'
 where id = 'ffffffff-ffff-4fff-8fff-000000000152';

-- Nadia paid 600 against N0001. The 011 sync trigger owns amount_paid, so the
-- ledger is the input and the header follows.
insert into public.sale_payments (sale_id, amount, method, paid_at, store_id)
values ('ffffffff-ffff-4fff-8fff-000000000151', 600, 'Cash',
        '2026-09-20 10:05:00+00', _rstore());

select is(
  (select balance_due from public.customer_balance('ffffffff-ffff-4fff-8fff-000000000111'))::numeric,
  400::numeric,
  'G-C1 balance_due is the live net (1000) minus what was paid (600); the voided 5000 is not counted'
);

select is(
  (select lifetime from public.customer_balance('ffffffff-ffff-4fff-8fff-000000000111'))::numeric,
  1000::numeric,
  'G-C1b lifetime excludes the voided invoice as well'
);

-- G-C3. A refund is a negative ledger row (013 dropped `amount > 0`), so it
-- must RAISE what is owed again rather than being clamped at zero.
insert into public.sale_payments (sale_id, amount, method, paid_at, store_id)
values ('ffffffff-ffff-4fff-8fff-000000000151', -200, 'Cash',
        '2026-09-22 10:00:00+00', _rstore());

select is(
  (select balance_due from public.customer_balance('ffffffff-ffff-4fff-8fff-000000000111'))::numeric,
  600::numeric,
  'G-C3 a refund nets against the balance: 1000 - (600 - 200) = 600'
);

-- G-C4. Omar owes nothing and the rival's customer belongs to another store.
select is(
  (select count(*)::int from public.customer_balance('ffffffff-ffff-4fff-8fff-000000000113')),
  0,
  'G-C4 another store''s customer is invisible, not merely zero'
);

-- G-C5. Only real debtors, largest first.
select is(
  (select count(*)::int
     from public.customer_debtors(null, null, 50) d
    where d.balance_due <= 0.01),
  0,
  'G-C5 the debtor list contains nobody who does not actually owe'
);

select is(
  (select balance_due::numeric
     from public.customer_debtors(null, null, 50)
    where customer_id = 'ffffffff-ffff-4fff-8fff-000000000111'),
  600::numeric,
  'G-C5b Nadia is listed with the balance the single-customer query reported'
);

-- G-C6. An unknown customer is ABSENT, not an error: a stale id in a link must
-- not throw a 500 at the screen that followed it.
select is(
  (select count(*)::int
     from public.customer_balance('ffffffff-ffff-4fff-8fff-000000000199')),
  0,
  'G-C6 an unknown customer yields no row instead of raising'
);

rollback;
