-- LensyPOS — 019: how long a job has been in the lab
-- ============================================================
-- `lab_status` is a free-text column with no timestamp, so "this order has been
-- sitting in the lab for two weeks" cannot be answered - not by the app, and not
-- by a query. The Lab screen can colour a badge by status, which is exactly why
-- the gap went unnoticed: everything looks fine and nothing is measurable.
--
-- This adds the one column that makes dwell time real, maintained by a trigger so
-- it cannot be wrong: the client never writes it, and a status change through any
-- route stamps it. Three columns rather than one, because the question an optician
-- actually asks is "how long has it been waiting?", which needs the moment the job
-- ENTERED the current status - not the moment the row was created.
--
--   lab_status_changed_at  when the status last became its current value
--   lab_started_at         when it first left 'Not Started' (NULL until it does)
--   lab_ready_at           when it first became 'Ready' (NULL until it does)
--
-- `lab_started_at` and `lab_ready_at` are written ONCE (coalesce) and never
-- rewritten, so "how long was this job in the lab" survives the job moving on to
-- 'Received'. The third status after Ready is the customer's, not the lab's, and
-- overwriting the timestamp would erase the only measurement that mattered.
--
-- Requires 013 (lab_status on sales).
-- Idempotent: add column if not exists / create or replace.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

-- ============================================================
-- 1) the columns
-- ============================================================
-- Nullable and backfilled from order_date, so an existing job is not reported as
-- having started the day this migration ran. The backfill is deliberately
-- approximate - the true time is unknowable for work already done - and it is
-- better than a NULL that sorts as "brand new" and buries the oldest jobs at the
-- bottom of every list.
alter table public.sales
  add column if not exists lab_status_changed_at timestamptz;

alter table public.sales
  add column if not exists lab_started_at timestamptz;

alter table public.sales
  add column if not exists lab_started_by text;

alter table public.sales
  add column if not exists lab_ready_at timestamptz;

comment on column public.sales.lab_status_changed_at is
  'when lab_status last took its current value; maintained by trigger';
comment on column public.sales.lab_started_at is
  'when the job first left Not Started; written once and never rewritten';
comment on column public.sales.lab_ready_at is
  'when the job first became Ready; written once and never rewritten';

-- Backfill. Only rows that actually HAVE a lab status: lab_status defaults to
-- 'Not Started', so a sale with no lab job at all would otherwise gain three
-- timestamps and appear in dwell-time reports as brand-new work.
update public.sales
   set lab_status_changed_at = coalesce(order_date, created_at, now()),
       lab_started_at = case
         when lab_status is not null and lab_status <> 'Not Started'
           then coalesce(order_date, created_at, now())
       end,
       lab_ready_at = case
         when lab_status in ('Ready', 'Received')
           then coalesce(order_date, created_at, now())
       end
 where lab_status is not null
   and lab_status_changed_at is null;

-- ============================================================
-- 2) the trigger
-- ============================================================
-- BEFORE UPDATE so it can inspect old and new together, and so the write and the
-- stamp are one statement - a client that updates lab_status and a timestamp
-- separately could disagree, and the client never touches these columns at all.
create or replace function public.lab_status_stamp() returns trigger
language plpgsql as $$
begin
  -- Only a real status CHANGE stamps anything. Without the comparison, every
  -- unrelated UPDATE to a sale (a photo path, a header edit) would reset the
  -- clock and the shop would measure how often staff edit invoices rather than
  -- how long lenses take.
  if new.lab_status is distinct from old.lab_status then
    new.lab_status_changed_at := now();

    if new.lab_status is not null and new.lab_status <> 'Not Started' then
      -- coalesce: written once. Re-entering the lab later does not rewrite the
      -- first departure, so the headline number is still the real one.
      new.lab_started_at := coalesce(old.lab_started_at, now());
    end if;

    if new.lab_status in ('Ready', 'Received') then
      new.lab_ready_at := coalesce(old.lab_ready_at, now());
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists lab_status_stamp on public.sales;
create trigger lab_status_stamp
  before update on public.sales
  for each row execute function public.lab_status_stamp();

-- ============================================================
-- 3) the lab queue
-- ============================================================
-- How long each job has been waiting, worst first - the question the Lab screen
-- could not previously answer at all. Fixed-size, scoped to the caller's store the
-- way 016 scoped its reports.
--
-- `hours_in_status` is deliberately the CURRENT status, not the total: a job that
-- sat a week in the lab and was collected yesterday was a week of lab time, but
-- the shop's queue problem right now is whatever is sitting there TODAY. Both are
-- available - lab_started_at gives the total.
create or replace function public.lab_queue(p_status text default null)
returns table (
  sale_id        uuid,
  invoice_no     text,
  lab_status     text,
  order_date     timestamptz,
  status_since   timestamptz,
  hours_in_status numeric,
  hours_total    numeric,
  customer_name  text
)
language sql
stable
security definer
set search_path = public as $$
  select s.id,
         coalesce(s.invoice_no, ''),
         coalesce(s.lab_status, ''),
         s.order_date,
         coalesce(s.lab_status_changed_at, s.order_date, now()),
         round(extract(epoch from (now() - coalesce(s.lab_status_changed_at, s.order_date, now()))) / 3600.0, 1),
         round(extract(epoch from (now() - coalesce(s.lab_started_at, s.order_date, now())))  / 3600.0, 1),
         coalesce(c.name, '')
    from public.sales s
    left join public.customers c on c.id = s.customer_id
   where s.store_id = public.auth_store_id()
     and s.voided_at is null
     and s.lab_status is not null
     and (p_status is null or s.lab_status = p_status)
   order by coalesce(s.lab_status_changed_at, s.order_date) asc nulls last
   limit 200;
$$;

grant execute on function public.lab_queue(text) to authenticated;
