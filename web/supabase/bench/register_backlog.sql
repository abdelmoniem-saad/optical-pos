-- web/supabase/bench/register_backlog.sql
--
-- The 2,000-op backlog timing bench of design 4.4 (034, register ingest): a
-- register that was offline for a while sends 2,000 ops (a session, then
-- note.upsert and one-line sale.create ops with a payment and a stock
-- movement, so the money path, the guard, the audit and the undo log all
-- run) in batches of 100, the PC's starting batch size (design 3.9), with
-- the real 3-second budget. It prints calls, total and per-op times and the
-- slowest call.
--
-- This is a BENCHMARK, NOT a migration and NOT a pgTAP gate: it lives under
-- bench/ so neither glob picks it up. Run it against a freshly-migrated
-- LOCAL database that has 034 applied (never production):
--   psql "$DATABASE_URL" -X -q -f web/supabase/bench/register_backlog.sql
-- It runs as postgres inside one transaction and rolls back, so it leaves
-- nothing behind. Pure SQL (no psql meta-commands), so it runs under the
-- psql-shim.
begin;

-- A store on its register: owner 'b1' (cloud login), register login 'b9'.
insert into public.stores (id, name) values ('35000000-0000-4000-8000-0000000000a0', 'Bench register store');
insert into public.store_licenses (store_id, license_key, plan, starts_at)
values ('35000000-0000-4000-8000-0000000000a0', 'BENCH-REGISTER', 'pro', '2000-01-01');
insert into public.roles (id, name, store_id)
values ('35000000-0000-4000-8000-0000000000a1', 'Admin', '35000000-0000-4000-8000-0000000000a0');
insert into auth.users (id, email) values
  ('35000000-0000-4000-8000-0000000000b1', 'owner@bench.register'),
  ('35000000-0000-4000-8000-0000000000b9', 'register@bench.register');
insert into public.users (id, username, password_hash, store_id, role_id, is_active)
values ('35000000-0000-4000-8000-0000000000b1', 'bench_owner', 'supabase-auth',
        '35000000-0000-4000-8000-0000000000a0', '35000000-0000-4000-8000-0000000000a1', true);
insert into public.inventory (id, name, sale_price, cost_price, store_id)
values ('35000000-0000-4000-8000-0000000000c1', 'Bench frame', 100, 40, '35000000-0000-4000-8000-0000000000a0');
-- naming an owner needs 033's admin token (postgres owns the functions)
select public._register_bypass('35000000-0000-4000-8000-0000000000a0', 'admin', true);
select set_config('lensy.register_admin', '35000000-0000-4000-8000-0000000000a0', true);
update public.stores set owner_uid = '35000000-0000-4000-8000-0000000000b1'
 where id = '35000000-0000-4000-8000-0000000000a0';
select set_config('lensy.register_admin', '', true);
select public._register_bypass('35000000-0000-4000-8000-0000000000a0', 'admin', false);
select public._register_install('35000000-0000-4000-8000-0000000000a0', '35000000-0000-4000-8000-0000000000b9',
                                '35000000-0000-4000-8000-0000000000b1');

-- The backlog: seq 1 a session, then alternately a note and a sale.
create temporary table _ops (s integer primary key, op jsonb) on commit drop;
insert into _ops
select g, jsonb_build_object(
         's', g, 'i', gen_random_uuid(), 'v', 1, 'a', '35000000-0000-4000-8000-0000000000b1',
         'sid', '35000000-0000-4000-8000-0000000000d1',
         't', to_jsonb(now() - interval '3 days' + g * interval '1 minute'), 'e', 1)
       || case
            when g = 1 then jsonb_build_object('k', 'session.start', 'p',
                 jsonb_build_object('sid', '35000000-0000-4000-8000-0000000000d1',
                                    'user_id', '35000000-0000-4000-8000-0000000000b1'))
            when g % 2 = 0 then jsonb_build_object('k', 'note.upsert', 'p',
                 jsonb_build_object('id', gen_random_uuid(), 'body', 'backlog note ' || g))
            else jsonb_build_object('k', 'sale.create', 'p', jsonb_build_object(
                 'id', gen_random_uuid(), 'invoice_no', (100000 + g)::text, 'kind', 'sale',
                 'payment_method', 'Cash', 'lab_status', null,
                 'total_amount', 100, 'discount', 0, 'net_amount', 100,
                 'items', jsonb_build_array(jsonb_build_object(
                    'id', gen_random_uuid(), 'product_id', '35000000-0000-4000-8000-0000000000c1', 'name', 'Bench frame',
                    'qty', 1, 'unit_price', 100, 'total_price', 100, 'discount', 0, 'movement_id', gen_random_uuid())),
                 'exams', '[]'::jsonb,
                 'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'method', 'cash', 'amount', 100))))
          end
  from generate_series(1, 2000) g;

-- The register's JWT, then drain.
select set_config('request.jwt.claim.sub', '35000000-0000-4000-8000-0000000000b9', true);
select set_config('request.jwt.claims', '{"sub":"35000000-0000-4000-8000-0000000000b9"}', true);
create temporary table _bench (calls integer, acked bigint, total_ms numeric, max_call_ms numeric,
                               held jsonb, flagged bigint) on commit drop;
do $$
declare
  v_acked bigint := 0;
  v_calls integer := 0;
  v_t0    timestamptz := clock_timestamp();
  v_t     timestamptz;
  v_max   numeric := 0;
  v       jsonb;
begin
  while v_acked < 2000 and v_calls < 500 loop
    v_t := clock_timestamp();
    v := public.register_ingest(1, 1, (2000 - v_acked)::integer, null,
           (select jsonb_agg(o.op order by o.s) from _ops o where o.s > v_acked and o.s <= v_acked + 100));
    v_max := greatest(v_max, extract(epoch from clock_timestamp() - v_t) * 1000);
    v_calls := v_calls + 1;
    exit when v -> 'held' <> 'null'::jsonb or (v ->> 'acked_seq')::bigint = v_acked;
    v_acked := (v ->> 'acked_seq')::bigint;
  end loop;
  insert into _bench values (v_calls, v_acked, round(extract(epoch from clock_timestamp() - v_t0) * 1000, 1),
                             round(v_max, 1), v -> 'held',
                             (select count(*) from public.register_ops
                               where store_id = '35000000-0000-4000-8000-0000000000a0' and status = 'flagged'));
end $$;

select calls, acked, total_ms, round(total_ms / greatest(acked, 1), 2) as ms_per_op, max_call_ms,
       held::text as held, flagged,
       (select count(*) from public.register_undo where store_id = '35000000-0000-4000-8000-0000000000a0') as undo_rows
  from _bench;

rollback;
