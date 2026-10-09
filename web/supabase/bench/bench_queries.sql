-- web/supabase/bench/bench_queries.sql
--
-- Measure the report functions at the seeded scale with EXPLAIN (ANALYZE,
-- BUFFERS). The "Execution Time" line in each plan is the number to read; no
-- psql \timing is used, so this file is pure SQL and runs under the psql-shim.
--
-- Run against a database seeded by seed_50k.sql (see bench-queries.sh).
--
-- Each report is exercised twice where it matters: a narrow "last 30 days"
-- window (a realistic slice of the 2-year history) and "all time" (the worst
-- case, full 50k scan). The window is the number a shop actually waits on; the
-- all-time figure is the ceiling.

-- --- shop admin: report_sales_window / report_payment_mix / z_report --------
-- set_config(..., false) is SESSION-level, so it survives across the separate
-- statements the shim sends on one connection (a local `true` setting would
-- vanish between autocommit statements).
select set_config('request.jwt.claim.sub',
                  '11111111-1111-4111-8111-0000000000a1', false);
select set_config('request.jwt.claims',
                  '{"sub":"11111111-1111-4111-8111-0000000000a1"}', false);

set role authenticated;

select '=== report_sales_window: last 30 days ===' as section;
explain (analyze, buffers, timing)
  select * from public.report_sales_window(now() - interval '30 days', now());

select '=== report_sales_window: all time ===' as section;
explain (analyze, buffers, timing)
  select * from public.report_sales_window(null, null);

select '=== report_payment_mix: last 30 days ===' as section;
explain (analyze, buffers, timing)
  select * from public.report_payment_mix(now() - interval '30 days', now());

select '=== z_report: last 30 days ===' as section;
explain (analyze, buffers, timing)
  select * from public.z_report(now() - interval '30 days', now());

reset role;

-- --- platform admin: platform_report_window (cross-store, definer) ---------
select set_config('request.jwt.claim.sub',
                  '11111111-1111-4111-8111-0000000000b1', false);
select set_config('request.jwt.claims',
                  '{"sub":"11111111-1111-4111-8111-0000000000b1"}', false);

set role authenticated;

select '=== platform_report_window: today ===' as section;
explain (analyze, buffers, timing)
  select * from public.platform_report_window(current_date);

reset role;
