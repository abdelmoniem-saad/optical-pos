-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 034 twin gate (offline-v2 Phase 1b, docs/offline-v2/design.md 3.7 and
-- 4.4): the 030 money scenarios run twice - through the ONLINE RPCs in store
-- A (an ordinary store, signed in as its admin) and through register_ingest
-- in store B (register_only, ops at t = now() carrying the rows the PC
-- derives) - and the two stores must end identical:
--   1 first checkout with a line discount and a split tender (cash + card)
--   2 a partial refund (refund_sale / sale.refund)
--   3 a re-checkout that raises the total: new money appended (card +300)
--   4 refund first: two refunds, then a re-checkout down to one unit (no
--     ledger delta, the unit back on the shelf)
--   5 a legacy tender ('cash + instapay') kept as it is while new money
--     goes on card
--   6 a collection on a balance (collect_sale_payment / payment.collect)
--   7 a void after a partial refund (one refund per tender still held,
--     the units restocked)
--   8 the shift close of the window (close_shift / shift.close)
-- Compared: the ledger per invoice and method (sum, row counts by kind,
-- notes), the header money, the lines, the stock movements per invoice and
-- type, stock_qty, _z_report of the window and the stored close.
--   9 (stores C online / D register) the close's window END: close_shift
--     ends it at the next midnight in the STORE's zone after to_at's UTC
--     date (report_window, 016:199-210), so a sale between store midnight
--     and UTC midnight is outside it. D's close payload is computed here
--     independently, by that rule (as the PC's zreport.ts must), not copied
--     from C's close.
-- The session runs in UTC, as CI and Supabase do: a local server in
-- Africa/Cairo would otherwise hide a rounding done in the session's zone.
begin;
set local timezone = 'UTC';
create extension if not exists pgtap;
select plan(12);

-- ===== fixtures ============================================================
create function u(p text) returns uuid language sql immutable as $$
  select ('34700000-0000-4000-8000-0000000000' || p)::uuid $$;
create function s_a() returns uuid language sql immutable as $$ select u('a0') $$;
create function s_b() returns uuid language sql immutable as $$ select u('b0') $$;
create function _as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claims', case when p is null then '{}' else json_build_object('sub', p)::text end, true);
end $$;
create function _token(p_store uuid, p_open boolean) returns void language plpgsql as $$
begin
  perform public._register_bypass(p_store, 'admin', p_open);
  perform set_config('lensy.register_admin', case when p_open then p_store::text else '' end, true);
end $$;
-- A's sale by invoice number (the online RPCs mint their own ids)
create function sa(p_inv text) returns uuid language sql stable security definer set search_path = public as $$
  select id from public.sales where store_id = s_a() and invoice_no = p_inv $$;
grant execute on function sa(text) to authenticated;

insert into public.stores (id, name, time_zone) values
  (s_a(), 'Twin A34', 'Africa/Cairo'), (s_b(), 'Twin B34', 'Africa/Cairo');
insert into public.store_licenses (store_id, license_key, plan, starts_at, expires_at) values
  (s_a(), 'TWIN-A34', 'pro', '2000-01-01', null), (s_b(), 'TWIN-B34', 'pro', '2000-01-01', null);
insert into public.roles (id, name, store_id) values (u('a5'), 'Admin', s_a()), (u('b5'), 'Admin', s_b());
-- 11 A's admin (online), 21 B's owner (the ops' actor), 61 the vendor, 72 B's register
insert into auth.users (id, email) values
  (u('11'), 'a@twin34'), (u('21'), 'b@twin34'), (u('61'), 'v@twin34'), (u('72'), 'register.b.1@twin34');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  (u('11'), 'admin_twin_a34', 'supabase-auth', s_a(), u('a5'), true),
  (u('21'), 'owner_twin_b34', 'supabase-auth', s_b(), u('b5'), true);
insert into public.platform_admins (auth_uid) values (u('61'));

-- A: the products and their opening stock, as the online app has them
insert into public.inventory (id, name, sku, category, sale_price, cost_price, store_id) values
  (u('a1'), 'Frame T', 'TW-F', 'Frame', 500, 200, s_a()),
  (u('a2'), 'Lens T',  'TW-L', 'Lens',  300, 100, s_a());
insert into public.stock_movements (product_id, qty, type, note, store_id) values
  (u('a1'), 10, 'initial', 'seed', s_a()), (u('a2'), 10, 'initial', 'seed', s_a());

-- B goes on its register (033's install path)
set role authenticated; select _as(u('61'));
select public.set_store_owner(s_b(), u('21'));
reset role;
set role service_role; select _as(null);
select public._register_install(s_b(), u('72'), u('21'));
reset role;

-- B's ops: one per call at the next seq, actor 21, t = now(); every
-- outcome is kept in _st for T1.
create table _st (s bigint primary key, k text, st text, v text[], held text);
create function nx() returns bigint language sql stable security definer set search_path = public as $$
  select last_seq + 1 from public.store_registers where store_id = s_b() $$;
create function opb(p_k text, p_p jsonb) returns void language plpgsql as $$
declare
  v_s bigint := nx();
  v_r jsonb;
begin
  perform _as(u('72'));
  v_r := public.register_ingest(1, 1, 0, null, jsonb_build_array(jsonb_build_object(
           's', v_s, 'i', gen_random_uuid(), 'k', p_k, 'v', 1, 'a', u('21'), 'sid', u('5b'),
           't', to_jsonb(now()), 'p', p_p)));
  insert into _st
  select v_s, p_k, coalesce(o.status, 'held'), o.violations, v_r -> 'held' ->> 'msg'
    from (select 1) x left join public.register_ops o on o.store_id = s_b() and o.seq = v_s
  on conflict (s) do update set k = excluded.k, st = excluded.st, v = excluded.v, held = excluded.held;
end $$;
create function li(p_id uuid, p_prod uuid, p_qty integer, p_price numeric, p_disc numeric default 0, p_mv uuid default null)
returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('id', p_id, 'product_id', p_prod, 'name', 'line', 'qty', p_qty,
           'unit_price', p_price, 'total_price', p_qty * p_price, 'discount', p_disc, 'movement_id', p_mv)) $$;
create function pa(p_id uuid, p_method text, p_amount numeric) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'method', p_method, 'amount', p_amount) $$;

select opb('session.start', jsonb_build_object('sid', u('5b'), 'user_id', u('21')));
select opb('product.upsert', jsonb_build_object('id', u('b1'), 'name', 'Frame T', 'sku', 'TW-F', 'category', 'Frame',
  'sale_price', 500, 'cost_price', 200, 'initial', jsonb_build_object('movement_id', u('e1'), 'qty', 10)));
select opb('product.upsert', jsonb_build_object('id', u('b2'), 'name', 'Lens T', 'sku', 'TW-L', 'category', 'Lens',
  'sale_price', 300, 'cost_price', 100, 'initial', jsonb_build_object('movement_id', u('e2'), 'qty', 10)));

-- The legacy sale 700005 in both stores (backfilled before 030: one ledger
-- row on the collapsed method 'cash + instapay'), 1 x Frame at 500, paid.
insert into public.sales (id, store_id, invoice_no, kind, total_amount, discount, net_amount, amount_paid,
                          payment_method, order_date, lab_status, user_id)
values (u('c9'), s_a(), '700005', 'sale', 500, 0, 500, 0, 'Cash + InstaPay', now(), null, u('11'));
insert into public.sale_items (id, sale_id, store_id, product_id, qty, unit_price, total_price, name)
values (u('d9'), u('c9'), s_a(), u('a1'), 1, 500, 500, 'line');
insert into public.stock_movements (product_id, store_id, qty, type, ref_no, note, created_at)
values (u('a1'), s_a(), -1, 'sale', '700005', 'POS Sale: 700005', now());
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id, recorded_by)
values (u('c9'), 500, 'cash + instapay', 'payment', now(), s_a(), u('11'));
select _token(s_b(), true);
insert into public.sales (id, store_id, invoice_no, kind, total_amount, discount, net_amount, amount_paid,
                          payment_method, order_date, lab_status, user_id)
values (u('c5'), s_b(), '700005', 'sale', 500, 0, 500, 0, 'Cash + InstaPay', now(), null, u('21'));
insert into public.sale_items (id, sale_id, store_id, product_id, qty, unit_price, total_price, name)
values (u('d5'), u('c5'), s_b(), u('b1'), 1, 500, 500, 'line');
insert into public.stock_movements (product_id, store_id, qty, type, ref_no, note, created_at)
values (u('b1'), s_b(), -1, 'sale', '700005', 'POS Sale: 700005', now());
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id, recorded_by)
values (u('c5'), 500, 'cash + instapay', 'payment', now(), s_b(), u('21'));
select _token(s_b(), false);

-- ===== A: the online RPCs ==================================================
set role authenticated; select _as(u('11'));
-- 1 first checkout: 2 x Frame with a 100 line discount + 1 x Lens, net 1150, 600 cash + 400 card
select public.create_sale_order(
  '{"invoice_no": "700001", "net_amount": 1150, "payment_method": "Cash", "kind": "sale"}',
  jsonb_build_array(jsonb_build_object('product_id', u('a1'), 'qty', 2, 'unit_price', 500, 'total_price', 1000, 'name', 'line', 'discount', 100),
                    jsonb_build_object('product_id', u('a2'), 'qty', 1, 'unit_price', 300, 'total_price', 300, 'name', 'line')),
  '[]', '[{"method": "cash", "amount": 600}, {"method": "card", "amount": 400}]', u('f1'));
-- 2 partial refund
select public.refund_sale(sa('700001'), 100, 'cash', 'scratch');
-- 3 re-checkout up: a second Lens, net 1450, +300 on card
select public.update_sale_order(sa('700001'), '{"net_amount": 1450, "expected_amount_paid": 900}',
  jsonb_build_array(jsonb_build_object('product_id', u('a1'), 'qty', 2, 'unit_price', 500, 'total_price', 1000, 'name', 'line', 'discount', 100),
                    jsonb_build_object('product_id', u('a2'), 'qty', 2, 'unit_price', 300, 'total_price', 600, 'name', 'line')),
  '[]', '[{"method": "cash", "amount": 500}, {"method": "card", "amount": 700}]');
-- 4 refund first, then the re-checkout down to one Frame
select public.create_sale_order('{"invoice_no": "700002", "net_amount": 1000, "payment_method": "Cash", "kind": "sale"}',
  jsonb_build_array(jsonb_build_object('product_id', u('a1'), 'qty', 2, 'unit_price', 500, 'total_price', 1000, 'name', 'line')),
  '[]', '[{"method": "cash", "amount": 600}, {"method": "instapay", "amount": 400}]', u('f2'));
select public.refund_sale(sa('700002'), 100, 'cash', 'overcharge');
select public.refund_sale(sa('700002'), 400, 'instapay', 'frame returned');
select public.update_sale_order(sa('700002'), '{"net_amount": 500, "expected_amount_paid": 500}',
  jsonb_build_array(jsonb_build_object('product_id', u('a1'), 'qty', 1, 'unit_price', 500, 'total_price', 500, 'name', 'line')),
  '[]', '[{"method": "cash", "amount": 500}]');
-- 5 the legacy tender stays, new money on card
select public.update_sale_order(sa('700005'), '{"net_amount": 1000, "expected_amount_paid": 500}',
  jsonb_build_array(jsonb_build_object('product_id', u('a1'), 'qty', 2, 'unit_price', 500, 'total_price', 1000, 'name', 'line')),
  '[]', '[{"method": "cash + instapay", "amount": 500}, {"method": "card", "amount": 500}]');
-- 6 a collection on a balance
select public.create_sale_order('{"invoice_no": "700004", "net_amount": 500, "payment_method": "Cash", "kind": "sale"}',
  jsonb_build_array(jsonb_build_object('product_id', u('a2'), 'qty', 1, 'unit_price', 300, 'total_price', 300, 'name', 'line'),
                    jsonb_build_object('product_id', u('a2'), 'qty', 1, 'unit_price', 300, 'total_price', 300, 'name', 'line',
                                       'discount', 100)),
  '[]', '[{"method": "cash", "amount": 200}]', u('f4'));
select public.collect_sale_payment(sa('700004'), '[{"method": "wallet", "amount": 300}]');
-- 7 void after the partial refund
select public.void_sale(sa('700001'), 'customer left', true);
-- 8 the close of the window
select public.close_shift(now() - interval '1 hour', now() + interval '1 hour', 1000, 'twin');
reset role;

-- ===== B: the same through register_ingest ==================================
-- 1
select opb('sale.create', jsonb_build_object('id', u('c1'), 'invoice_no', '700001', 'idempotency_key', u('f1'), 'kind', 'sale',
  'total_amount', 1300, 'discount', 150, 'net_amount', 1150, 'payment_method', 'Cash', 'lab_status', null,
  'items', jsonb_build_array(li(u('d1'), u('b1'), 2, 500, 100, u('41')), li(u('d2'), u('b2'), 1, 300, 0, u('42'))),
  'exams', '[]'::jsonb, 'payments', jsonb_build_array(pa(u('81'), 'cash', 600), pa(u('82'), 'card', 400))));
-- 2
select opb('sale.refund', jsonb_build_object('sale_id', u('c1'), 'row', pa(u('83'), 'cash', 100), 'note', 'scratch',
  'expect', jsonb_build_object('paid', 1000, 'tenders', jsonb_build_object('cash', 600, 'card', 400))));
-- 3
select opb('sale.recheckout', jsonb_build_object('sale_id', u('c1'), 'total_amount', 1600, 'discount', 150, 'net_amount', 1450,
  'payment_method', 'Cash', 'lab_status', null,
  'items', jsonb_build_array(li(u('d1'), u('b1'), 2, 500, 100), li(u('d2'), u('b2'), 2, 300)), 'exams', '[]'::jsonb,
  'movements', jsonb_build_array(jsonb_build_object('id', u('43'), 'product_id', u('b2'), 'qty', -1)),
  'payments', jsonb_build_array(pa(u('84'), 'card', 300)),
  'expect', jsonb_build_object('paid', 900, 'tenders', jsonb_build_object('cash', 500, 'card', 400))));
-- 4
select opb('sale.create', jsonb_build_object('id', u('c2'), 'invoice_no', '700002', 'idempotency_key', u('f2'), 'kind', 'sale',
  'total_amount', 1000, 'discount', 0, 'net_amount', 1000, 'payment_method', 'Cash', 'lab_status', null,
  'items', jsonb_build_array(li(u('d3'), u('b1'), 2, 500, 0, u('44'))), 'exams', '[]'::jsonb,
  'payments', jsonb_build_array(pa(u('85'), 'cash', 600), pa(u('86'), 'instapay', 400))));
select opb('sale.refund', jsonb_build_object('sale_id', u('c2'), 'row', pa(u('87'), 'cash', 100), 'note', 'overcharge'));
select opb('sale.refund', jsonb_build_object('sale_id', u('c2'), 'row', pa(u('88'), 'instapay', 400), 'note', 'frame returned'));
select opb('sale.recheckout', jsonb_build_object('sale_id', u('c2'), 'total_amount', 500, 'discount', 0, 'net_amount', 500,
  'payment_method', 'Cash', 'lab_status', null,
  'items', jsonb_build_array(li(u('d3'), u('b1'), 1, 500)), 'exams', '[]'::jsonb,
  'movements', jsonb_build_array(jsonb_build_object('id', u('45'), 'product_id', u('b1'), 'qty', 1)),
  'payments', '[]'::jsonb, 'expect', jsonb_build_object('paid', 500, 'tenders', jsonb_build_object('cash', 500))));
-- 5
select opb('sale.recheckout', jsonb_build_object('sale_id', u('c5'), 'total_amount', 1000, 'discount', 0, 'net_amount', 1000,
  'payment_method', 'Cash + InstaPay', 'lab_status', null,
  'items', jsonb_build_array(li(u('d6'), u('b1'), 2, 500)), 'exams', '[]'::jsonb,
  'movements', jsonb_build_array(jsonb_build_object('id', u('46'), 'product_id', u('b1'), 'qty', -1)),
  'payments', jsonb_build_array(pa(u('89'), 'card', 500)),
  'expect', jsonb_build_object('paid', 500, 'tenders', jsonb_build_array(jsonb_build_object('method', 'cash + instapay', 'amount', 500)))));
-- 6
select opb('sale.create', jsonb_build_object('id', u('c4'), 'invoice_no', '700004', 'idempotency_key', u('f4'), 'kind', 'sale',
  'total_amount', 600, 'discount', 100, 'net_amount', 500, 'payment_method', 'Cash', 'lab_status', null,
  'items', jsonb_build_array(li(u('d7'), u('b2'), 1, 300, 0, u('49')), li(u('d8'), u('b2'), 1, 300, 100, u('4a'))),
  'exams', '[]'::jsonb, 'payments', jsonb_build_array(pa(u('8a'), 'cash', 200))));
select opb('payment.collect', jsonb_build_object('sale_id', u('c4'), 'lines', jsonb_build_array(pa(u('8b'), 'wallet', 300)),
  'expect', jsonb_build_object('paid', 200)));
-- 7
select opb('sale.void', jsonb_build_object('sale_id', u('c1'), 'reason', 'customer left',
  'refunds', jsonb_build_array(pa(u('8c'), 'card', -700), pa(u('8d'), 'cash', -500)),
  'restock', jsonb_build_array(jsonb_build_object('id', u('47'), 'product_id', u('b1'), 'qty', 2),
                               jsonb_build_object('id', u('48'), 'product_id', u('b2'), 'qty', 2)),
  'expect', jsonb_build_object('paid', 1200, 'tenders', jsonb_build_object('cash', 500, 'card', 700))));
-- 8: the PC's figures are A's close (what close_shift computed online)
select opb('shift.close', (select jsonb_build_object('id', u('5c'), 'from_at', c.from_at, 'to_at', c.to_at,
    'counted_cash', c.counted_cash, 'expected_cash', c.expected_cash, 'expected_by_tender', c.expected_by_tender,
    'expected_total', c.expected_total, 'variance', c.variance, 'order_count', c.order_count,
    'prescription_count', c.prescription_count, 'void_count', c.void_count, 'refund_total', c.refund_total,
    'lab_delivered', c.lab_delivered, 'note', c.note)
  from public.shift_closes c where c.store_id = s_a()));

-- ===== the twins ===========================================================
create function ledger(p_store uuid) returns jsonb language sql stable as $$
  select jsonb_agg(to_jsonb(x) order by x.invoice_no, x.method)
    from (select s.invoice_no, p.method, sum(p.amount) as amount,
                 count(*) filter (where p.kind = 'payment') as payments,
                 count(*) filter (where p.kind = 'refund') as refunds,
                 string_agg(p.note, ' | ' order by p.note) as notes
            from public.sale_payments p join public.sales s on s.id = p.sale_id
           where s.store_id = p_store group by 1, 2) x $$;
create function header(p_store uuid) returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object('invoice_no', s.invoice_no, 'total', s.total_amount, 'discount', s.discount,
                                      'net', s.net_amount, 'paid', s.amount_paid, 'kind', s.kind,
                                      'voided', s.voided_at is not null, 'void_reason', s.void_reason,
                                      'method', s.payment_method, 'lab', s.lab_status)
                   order by s.invoice_no)
    from public.sales s where s.store_id = p_store $$;
create function lines(p_store uuid) returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object('invoice_no', s.invoice_no, 'sku', i.sku, 'qty', si.qty, 'unit_price', si.unit_price,
                                      'total_price', si.total_price, 'discount', si.discount)
                   order by s.invoice_no, i.sku, si.qty, si.discount)
    from public.sale_items si join public.sales s on s.id = si.sale_id join public.inventory i on i.id = si.product_id
   where s.store_id = p_store $$;
create function moves(p_store uuid) returns jsonb language sql stable as $$
  select jsonb_agg(to_jsonb(x) order by x.ref_no, x.type, x.sku)
    from (select m.ref_no, m.type, m.kind, i.sku, sum(m.qty) as qty, count(*) as n
            from public.stock_movements m join public.inventory i on i.id = m.product_id
           where m.store_id = p_store and m.ref_no is not null group by 1, 2, 3, 4) x $$;
create function stock(p_store uuid) returns jsonb language sql stable as $$
  select jsonb_object_agg(sku, stock_qty) from public.inventory where store_id = p_store $$;
create function zr(p_store uuid) returns jsonb language sql stable as $$
  select to_jsonb(z) from public._z_report(p_store, now() - interval '1 hour', now() + interval '1 hour') z $$;
create function closes(p_store uuid) returns jsonb language sql stable as $$
  select jsonb_agg(to_jsonb(c) - 'id' - 'store_id' - 'closed_at' - 'closed_by') from public.shift_closes c where c.store_id = p_store $$;

select is((select coalesce(string_agg(s || ' ' || k || ' ' || st || coalesce(' ' || v::text, '') || coalesce(' ' || held, ''), '; ' order by s), '')
             from _st where st <> 'ok'), '',
  'T1 every op of store B applied ok: no flag, no hold (the PC derives exactly what the online RPCs do)');
select ok((select count(*) from _st) = 15 and (select last_seq from public.store_registers where store_id = s_b()) = 15,
  'T2 ...all 15 of them, last_seq 15');
select is(ledger(s_b()), ledger(s_a()), 'T3 the ledger per invoice and method: amounts, payment/refund rows and notes');
select ok(ledger(s_a()) @> '[{"invoice_no": "700005", "method": "cash + instapay", "amount": 500, "payments": 1, "refunds": 0},
                             {"invoice_no": "700001", "method": "cash", "amount": 0, "payments": 1, "refunds": 2}]'::jsonb
          and (header(s_a()) -> 0 ->> 'voided')::boolean and jsonb_array_length(header(s_a())) = 4
          and jsonb_array_length(lines(s_a())) = 6 and jsonb_array_length(moves(s_a())) >= 6
          and (stock(s_a()) ->> 'TW-F')::int = 7 and (zr(s_a()) ->> 'expected_total')::numeric = 2000
          and jsonb_array_length(closes(s_a())) = 1,
  'T4 (the scenarios did what they say - the legacy tender kept, the voided sale at 0 after its partial refund - and no compared set is empty)');
select is(header(s_b()), header(s_a()), 'T5 the header money: total, discount, net, amount_paid, kind, void');
select is(lines(s_b()), lines(s_a()), 'T6 the lines (prices and line discounts)');
select is(moves(s_b()), moves(s_a()), 'T7 the stock movements per invoice and type (sum and count)');
select is(stock(s_b()), stock(s_a()), 'T8 stock_qty');
select is(zr(s_b()), zr(s_a()), 'T9 _z_report of the window');
select is(closes(s_b()), closes(s_a()), 'T10 the stored close (expected figures, variance, counts, note)');

-- ===== 9: the window end is the STORE's midnight ============================
-- C (online, admin 13) and D (register, owner 23, register login 74), both
-- Africa/Cairo. dd: yesterday 00:00 UTC (030's sale_event_time keeps online
-- times within 2 days); sm: the store's midnight after dd's UTC date (21:00
-- or 22:00 UTC, by DST). X at sm - 1 hour is inside the window [dd + 8 h,
-- dd + 12 h) as close_shift rounds it; Y at sm + 30 min is after the
-- store's midnight but before UTC midnight, so it is outside.
create function z(p text) returns uuid language sql immutable as $$
  select ('34710000-0000-4000-8000-0000000000' || p)::uuid $$;
create function s_c() returns uuid language sql immutable as $$ select z('c0') $$;
create function s_d() returns uuid language sql immutable as $$ select z('d0') $$;
create function dd() returns timestamptz language sql stable as $$
  select ((now() at time zone 'UTC')::date - 1)::timestamp at time zone 'UTC' $$;
create function sm() returns timestamptz language sql stable as $$
  select ((dd() at time zone 'UTC')::date + 1)::timestamp at time zone 'Africa/Cairo' $$;
insert into public.stores (id, name, time_zone) values
  (s_c(), 'Twin C34', 'Africa/Cairo'), (s_d(), 'Twin D34', 'Africa/Cairo');
insert into public.store_licenses (store_id, license_key, plan, starts_at, expires_at) values
  (s_c(), 'TWIN-C34', 'pro', '2000-01-01', null), (s_d(), 'TWIN-D34', 'pro', '2000-01-01', null);
insert into public.roles (id, name, store_id) values (z('c5'), 'Admin', s_c()), (z('d5'), 'Admin', s_d());
insert into auth.users (id, email) values (z('13'), 'c@twin34'), (z('23'), 'd@twin34'), (z('74'), 'register.d.1@twin34');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  (z('13'), 'admin_twin_c34', 'supabase-auth', s_c(), z('c5'), true),
  (z('23'), 'owner_twin_d34', 'supabase-auth', s_d(), z('d5'), true);
insert into public.inventory (id, name, sku, category, sale_price, cost_price, store_id) values
  (z('c1'), 'Frame T', 'TW-F', 'Frame', 500, 200, s_c());
insert into public.stock_movements (product_id, qty, type, note, store_id) values (z('c1'), 10, 'initial', 'seed', s_c());
set role authenticated; select _as(u('61'));
select public.set_store_owner(s_d(), z('23'));
reset role;
set role service_role; select _as(null);
select public._register_install(s_d(), z('74'), z('23'));
reset role;
create table _sd (s bigint primary key, k text, st text, v text[], held text);
create function opd(p_k text, p_p jsonb, p_t timestamptz) returns void language plpgsql as $$
declare
  v_s bigint := (select last_seq + 1 from public.store_registers where store_id = s_d());
  v_r jsonb;
begin
  perform _as(z('74'));
  v_r := public.register_ingest(1, 1, 0, null, jsonb_build_array(jsonb_build_object(
           's', v_s, 'i', gen_random_uuid(), 'k', p_k, 'v', 1, 'a', z('23'), 'sid', z('5d'),
           't', to_jsonb(p_t), 'p', p_p)));
  insert into _sd
  select v_s, p_k, coalesce(o.status, 'held'), o.violations, v_r -> 'held' ->> 'msg'
    from (select 1) x left join public.register_ops o on o.store_id = s_d() and o.seq = v_s;
end $$;

-- C online: X (cash) and Y (card), then the close of [dd + 8 h, dd + 12 h)
set role authenticated; select _as(z('13'));
select public.create_sale_order(
  jsonb_build_object('invoice_no', '710001', 'net_amount', 500, 'payment_method', 'Cash', 'kind', 'sale',
                     'order_date', sm() - interval '1 hour'),
  jsonb_build_array(jsonb_build_object('product_id', z('c1'), 'qty', 1, 'unit_price', 500, 'total_price', 500, 'name', 'line')),
  '[]', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 500, 'paid_at', sm() - interval '1 hour')), z('f1'));
select public.create_sale_order(
  jsonb_build_object('invoice_no', '710002', 'net_amount', 500, 'payment_method', 'Card', 'kind', 'sale',
                     'order_date', sm() + interval '30 minutes'),
  jsonb_build_array(jsonb_build_object('product_id', z('c1'), 'qty', 1, 'unit_price', 500, 'total_price', 500, 'name', 'line')),
  '[]', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 500, 'paid_at', sm() + interval '30 minutes')), z('f2'));
select public.close_shift(dd() + interval '8 hours', dd() + interval '12 hours', 500, 'zone');
reset role;

-- D through register_ingest, the same sales at the same times
select opd('session.start', jsonb_build_object('sid', z('5d'), 'user_id', z('23')), sm() - interval '2 hours');
select opd('product.upsert', jsonb_build_object('id', z('d1'), 'name', 'Frame T', 'sku', 'TW-F', 'category', 'Frame',
  'sale_price', 500, 'cost_price', 200, 'initial', jsonb_build_object('movement_id', z('e1'), 'qty', 10)), sm() - interval '2 hours');
select opd('sale.create', jsonb_build_object('id', z('d2'), 'invoice_no', '710001', 'idempotency_key', z('f1'), 'kind', 'sale',
  'total_amount', 500, 'discount', 0, 'net_amount', 500, 'payment_method', 'Cash', 'lab_status', null,
  'items', jsonb_build_array(li(z('d3'), z('d1'), 1, 500, 0, z('41'))), 'exams', '[]'::jsonb,
  'payments', jsonb_build_array(pa(z('81'), 'cash', 500))), sm() - interval '1 hour');
select opd('sale.create', jsonb_build_object('id', z('d4'), 'invoice_no', '710002', 'idempotency_key', z('f2'), 'kind', 'sale',
  'total_amount', 500, 'discount', 0, 'net_amount', 500, 'payment_method', 'Card', 'lab_status', null,
  'items', jsonb_build_array(li(z('d6'), z('d1'), 1, 500, 0, z('42'))), 'exams', '[]'::jsonb,
  'payments', jsonb_build_array(pa(z('82'), 'card', 500))), sm() + interval '30 minutes');
-- the PC's close, computed by the rule (X in, Y out): written out here
select opd('shift.close', jsonb_build_object('id', z('5c'), 'from_at', dd() + interval '8 hours',
  'to_at', dd() + interval '12 hours', 'counted_cash', 500, 'expected_cash', 500,
  'expected_by_tender', jsonb_build_object('cash', 500), 'expected_total', 500, 'variance', 0,
  'order_count', 1, 'prescription_count', 0, 'void_count', 0, 'refund_total', 0, 'lab_delivered', 0,
  'note', 'zone'), now());

select ok(current_setting('TimeZone') = 'UTC'
          and sm() - interval '1 hour' >= dd() + interval '12 hours'
          and sm() + interval '30 minutes' < dd() + interval '24 hours'
          and (select coalesce(string_agg(s || ' ' || k || ' ' || st || coalesce(' ' || v::text, '') || coalesce(' ' || held, ''), '; '), '')
                 from _sd where st <> 'ok') = ''
          and (select count(*) from _sd) = 5,
  'T11 a sale between the store''s midnight and UTC midnight: D''s shift.close, figured by the store-zone rule, applies ok (no z_mismatch) under a UTC session');
select ok(closes(s_d()) = closes(s_c())
          and (select expected_total = 500 and expected_by_tender = '{"cash": 500}'::jsonb and order_count = 1
                 from public.shift_closes where store_id = s_c()),
  'T12 ...and equals the online close_shift of C, which also leaves the later sale out (500 of 1000)');

select * from finish();
rollback;
