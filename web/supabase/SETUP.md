# Phase 2 — Supabase setup (one-time, ~5 minutes)

The web app's auth code is complete, but two things must be done **in your
Supabase dashboard** before login works. Neither can be automated from here
(both need project-admin rights, not the anon key).

## Step 1 — Lock down the database (RLS)

Until this is done, your anon key (shipped in the browser bundle) can read and
write your whole database. This step closes that hole.

1. Open **Supabase Dashboard → SQL Editor → New query**.
2. Paste the contents of [`001_security_rls.sql`](./001_security_rls.sql) and click **Run**.
3. Confirm it worked — run:
   ```sql
   select tablename, rowsecurity from pg_tables
   where schemaname = 'public' order by 1;
   ```
   Every table should show `rowsecurity = true`.

After this, the Phase 1 "Backend connectivity" probe on the dashboard will return
`0`/errors when **not** logged in (correct — anon is blocked) and real counts once
you **are** logged in (queries run as the `authenticated` role).

## Step 2 — Create the admin login

Staff log in by **username**. The app maps `admin` → `admin@lensypos.local`
(the domain is `VITE_AUTH_EMAIL_DOMAIN` in `web/.env.local`). So:

1. Open **Dashboard → Authentication → Users → Add user → Create new user**.
2. **Email:** `admin@lensypos.local`  **Password:** choose one.
3. Tick **Auto Confirm User** (skip the email verification step).
4. *(Optional)* Under **User Metadata**, add JSON so the UI shows a friendly name:
   ```json
   { "username": "admin", "full_name": "Administrator" }
   ```

Now sign in at the app with username `admin` and that password.

> **Tip — email confirmations:** for username-style internal accounts, turn off
> email confirmation at **Authentication → Providers → Email → "Confirm email" =
> off**, so you don't need real inboxes for staff accounts.

## Step 3 — (recommended) atomic checkout

Run [`002_create_sale_rpc.sql`](./002_create_sale_rpc.sql) in the SQL Editor. It
creates `create_sale_order(...)`, which writes the sale + items + stock movements
+ examinations in **one transaction**. The app calls it automatically; until it's
installed the app falls back to separate inserts (which work, but aren't atomic —
a mid-checkout failure could leave a partial order). Running this closes that gap.

## Step 4 — Prescription image uploads (for the exam "attach" button)

1. Dashboard → **Storage → New bucket** → name **`prescriptions`**, mark it **Public**.
2. Re-run [`002_create_sale_rpc.sql`](./002_create_sale_rpc.sql) (it was updated to
   also save the exam `image_path`).

The 📎 button on each exam row uploads to this bucket and stores the path on the
examination.

## Step 5 — In-app user creation (the "Add Staff" button)

Creating Supabase Auth users needs the service-role key, which can't live in the
browser, so it runs in an Edge Function. Deploy it once (needs the
[Supabase CLI](https://supabase.com/docs/guides/cli) + `supabase login`):

```bash
# from the repo root (the function lives in supabase/functions/create-user/)
supabase functions deploy create-user --project-ref qhbprvavoudetjbyxrsn
```

The function source is at `supabase/functions/create-user/index.ts` (repo root).
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically; nothing
else to configure. After deploy, **Staff → + Add Staff** creates real logins
(it also mirrors them into `public.users` so they show in the list).

> Until this function is deployed, the "Add Staff" form will return a "function not
> found" error — everything else works without it.

## Step 6 — Payment ledger (cash / wallet / instapay splits)

Run [`011_sale_payments.sql`](./011_sale_payments.sql). It creates
`sale_payments` (one row per money received — split tenders at checkout AND
payments collected later for the remaining balance), backfills every legacy
`amount_paid` as a single dated row, keeps `sales.amount_paid` in sync via a
trigger, and extends `create_sale_order` to write the payment lines inside the
checkout transaction. Until it's installed the app still works with the old
single-method flow (and shows a "run 011" notice on the payment-history UI).
Tip: snapshot the schema first — see "Schema baseline" below; it only reads the
database and gives you an exact "before" picture.

## Step 7 — Money & stock integrity (server-side checkout)

Run [`012_integrity.sql`](./012_integrity.sql). It rewrites `create_sale_order`
so the **database** re-prices every line from `inventory.sale_price` and
recomputes the header — your negotiated, round-up and free totals survive
exactly (any gap below the catalog sum is stored as an explicit discount),
while a stale cart is refused with `price changed: <name>` instead of silently
re-priced. It also:

- guards stock inside the transaction via a new
  **`stores.allow_negative_stock` column — default `true` keeps today's
  intentional overselling**; set it to `false` on a store (SQL for now) to make
  checkout refuse shortages with `insufficient stock: <name>`;
- moves invoice numbering into an atomic counter (`next_invoice_no()`), so two
  registers can never draw the same number and the client's `Date.now()`
  fallback can never fire;
- adds `sales.idempotency_key` — replaying a checkout (double-tap, retry after
  a dropped response) returns the **same** sale instead of a second one;
- adds `inventory.stock_qty`, a trigger-maintained read model over
  `stock_movements`, so the Inventory screen stops downloading every movement
  row;
- adds the money constraints (`net = total - discount`, `qty > 0`, …) as
  `not valid` → `validate`, warning (not failing) if legacy rows disagree —
  the remediation queries are in the file's header.

Until it is installed the app keeps working on the old paths (client-side
numbering, browser-summed stock) with a console warning. Tip: snapshot the
schema first — see "Schema baseline" below.

The pgTAP gate for this migration lives in
[`tests/012_integrity_test.sql`](./tests/012_integrity_test.sql) and runs in CI
on every push (`bash web/scripts/test-db.sh` against a throwaway Postgres).
`test-db.sh` runs **every** `tests/*_test.sql`, so each phase ships its own gate
without touching the runner.

## Step 8 — `013_void_refunds.sql` (reversible sales)

Reversibility, and the removal of the destructive verb. Paste it **after** 012
and **deploy the app at the same time** — the app now calls `update_sale_order`,
`void_sale`, `delete_purchase` and `delete_purchase_payment`, and the direct
`DELETE`s it used to send no longer work.

- **Void** from History: stamps `voided_at` / `voided_by` / `void_reason`,
  returns the stock (or not, your choice), and mirrors every tender as a
  negative `kind = 'refund'` ledger row. Nothing is deleted.
- **`update_sale_order()`** replaces the old five-round-trip re-checkout with one
  server-priced transaction (a mid-way failure used to leave a half-written
  order).
- **The money columns on `sales` are ledger-owned** — a direct
  `update sales set amount_paid = …` is refused.
- `sale_payments.paid_at` becomes a `timestamptz` and gains `kind`; the
  positivity check becomes `amount <> 0` so a refund is expressible.
- `direct DELETE` is dropped from `sales`, `sale_items`, `sale_payments`,
  `stock_movements`, `purchases`, `purchase_items`, `purchase_payments`. Reads
  and ordinary writes are untouched.
- `sale_items` gains `discount` + `discount_reason`; `stock_movements` gains a
  normalised `kind`.

Its gate is [`tests/013_void_refunds_test.sql`](./tests/013_void_refunds_test.sql)
(54 assertions), also run by `npm run test:db` and CI.

## Step 9 - `014_server_rbac.sql` (server-side authority)

**Paste this and deploy the app in the same sitting.** 014 cuts the username
fallback in `auth_store_id()`, so an account with no staff row now gets the
"This account is not linked to a store" screen - which ships in the same
commit. It also makes `create-user` fail CLOSED until this migration is applied.

- **`resolve_can(code, user)`** is the SQL mirror of the app's `resolveCan()`:
  an explicit per-person override always wins, otherwise the position grant
  decides, and admin/owner positions, the `superadmin` username and vendor
  accounts bypass. It deliberately does NOT copy the UI's `openAccess`
  leniency - the Phase 3 gate asserts that divergence.
- **`require_perm(code)`** raises with the code in the message, and now guards
  `void_sale`, `delete_purchase` and `delete_purchase_payment`.
- **The three RBAC tables** stop being world-writable. `permissions` stays
  READABLE by any signed-in user (the Access Control matrix needs the code
  list) but writes are platform admins only; `role_permissions` and
  `user_permissions` are tenant-scoped through a join on `roles.store_id` /
  `users.store_id` and writes need `staff.edit`.
- **`auth_store_id()` loses its username fallback.** Matching a caller to a
  tenant by their email's local part is impersonation: an auth identity with
  no staff row whose local part happened to match a real username inherited
  that person's store, role and licence. `users.username` is already globally
  unique, so the roadmap's "two stores with a user called admin" scenario
  cannot occur - but this one could, and it was worse.
- **`audit_log`** records who changed the money and authority tables.
- **`auth_uid()`** and **`my_store_license()`** are added for the
  `create-user` Edge Function, which now authorises itself *as the caller*.

After pasting, redeploy the function so it stops trusting the request body:

```bash
supabase functions deploy create-user --project-ref qhbprvavoudetjbyxrsn
```

Two things must be true afterwards:
1. **Every existing account has a `public.users` row whose `id` equals its
   Supabase Auth id.** `create-user` writes it that way; the only accounts at
   risk are hand-made ones. Check with:
   ```sql
   select u.username, u.id from public.users u
    where not exists (select 1 from auth.users a where a.id = u.id);
   ```
2. **Anyone signing in who fails that** now sees the "not linked" screen, so
   link them from the Staff screen (or with `create-user`).

Its gate is [`tests/014_server_rbac_test.sql`](./tests/014_server_rbac_test.sql)
(33 assertions), also run by `npm run test:db` and CI.

## Step 10 - `015_link_staff_ids.sql` (repair a staff row that is not linked)

**Paste this immediately after step 9.** 014 cuts a fallback that was quietly
papering over a real problem: a staff row whose `id` is not the Supabase Auth
`id` of the same person. That is exactly the state left behind by **step 2**,
which creates the admin row by hand with its own uuid - and it now resolves to
no store, so the account sees "This account is not linked to a store".

015 repairs that, in both directions:

- a staff row whose `id` disagrees with the auth login of the same **name** is
  swapped onto the id the login actually has (six columns reference
  `users.id`, so they are moved with it, and the old row is dropped);
- a login that exists but has no staff row gets one, at the real store, with
  `password_hash = 'supabase-auth'` - the password cannot be recovered, so the
  owner must use **Reset password** in the dashboard.

**A name is only repaired when it is unambiguous.** If two auth logins could
own it, nothing is guessed: guessing which of two people meant is how you hand
somebody's sales history to the wrong person. Those rows are listed by the view
it creates, for a human to decide:

```sql
select * from public.staff_id_problems;
```

**What you should see when you run it:** a `NOTICE` per account it repaired
(`re-pointed: admin (...)` for the step-2 admin), and then either
`link_staff_ids: nothing to repair` or a few more notices. An empty result is
the healthy outcome.

Re-running it repairs nothing, so it is safe to paste twice.

Its gate is [`tests/015_link_staff_ids_test.sql`](./tests/015_link_staff_ids_test.sql)
(13 assertions), also run by `npm run test:db` and CI.

## Step 11 - `016_reporting.sql` (reports in the database, and one "today")

**The last one for now.** It fixes a live money bug, then moves the reporting
arithmetic out of the browser.

- **Voided sales were being counted as revenue.** Voiding stamps `voided_at` and
  deliberately leaves `net_amount` alone so the audit trail reads true, and the
  Reports screen summed that column without ever looking at the flag. Voiding a
  5,000 EGP invoice made the shop look 5,000 *richer*. Every function below
  excludes voided rows, and the partial index `sales_live_idx` makes it free.
- **`report_sales_window` / `report_top_customers` / `report_payment_mix` /
  `report_voided_count`** replace a download of every sale header in the store
  and a sum in JavaScript. The payload is now a fixed size no matter how much
  history exists. None of them takes a store argument - the store comes from
  `auth_store_id()`, so a caller cannot ask for another shop's report.
- **`stores.time_zone` (default `Africa/Cairo`)** and `store_day_range()`. Three
  screens disagreed about which day a sale belonged to: Reports used UTC,
  History used the browser's clock, and the cash-up panel filtered a
  `timestamptz` with a bare date - which means midnight at the *start* of that
  day, so every payment after midnight was dropped. All of them now use the
  store's own day. Change it per store with:
  ```sql
  update public.stores set time_zone = 'Africa/Cairo' where id = '...';
  ```
- **`search_text(term)`** plus trigram indexes. The search box used to strip
  `,()` from your term to make a PostgREST `or()` string safe, so a customer
  called `Ahmed (Cairo)` could not be found and no error was shown. The term is
  now an argument, so there is nothing to escape.

The app works without this migration - it falls back to the client path, which
now also excludes voids. Apply it anyway, and the numbers stop depending on how
long the shop has been trading.

Its gate is [`tests/016_reporting_test.sql`](./tests/016_reporting_test.sql)
(30 assertions), also run by `npm run test:db` and CI.

**Check it worked:** open Reports. If a voided invoice exists, a line appears
under the totals saying how many were excluded. Switch the period between
Today and Month and compare against History for the same day — they now agree.

## Step 12 - `017_schema_version.sql` (the app can tell when you are behind)

Every migration so far is applied by hand, and until this one the app had no
way to know it was running against an older database. It could only discover a
missing function by catching the error, and its three recovery paths were
quiet - worst of all, a failed invoice-number query used to return
`Date.now() % 1000000`. That is a real, plausible-looking invoice number
unrelated to your sequence, written against a real sale. If you ever find a
number like that in the ledger, this is where it came from.

017 records which migrations the database has absorbed:

```sql
select public.schema_version();   -- 17 once this migration has been applied
```

The app compares that against the version it was built for and shows a red
strip across the top of every screen when the database is behind, naming the
version it found. Apply this migration and the strip disappears.

**The app is safe if you skip it.** A database with no `schema_version()` at
all is every shop that updates the app before the SQL, so the app treats
"cannot read the version" as silence rather than an alarm. Nothing breaks;
you just lose the warning that tells you a *later* migration is missing.

Re-running is safe: the ledger keeps the timestamp of when the version was
first recorded, so a second paste changes nothing.

**Check it worked:** run the query above in the SQL editor. It should return
`17`, and the app should show no banner. Re-apply the file and run it again -
still `17`, and the same `applied_at`.

Its gate is [`tests/017_schema_version_test.sql`](./tests/017_schema_version_test.sql)
(14 assertions), also run by `npm run test:db` and CI.

### Manual probe for `create-user` (no live project in CI)

The SQL half is covered by pgTAP. The Edge Function needs a deployed project,
so after deploying, confirm with a real token - from the browser console, as a
**cashier**:

```js
// must FAIL: a cashier may not create staff
await supabase.functions.invoke('create-user', {
  body: { username: 'evil', password: 'secret123', role_id: '<an admin role id>' },
})

// must FAIL: cross-store
// (as a manager, with store_id set to another store's uuid)

// must SUCCEED: a manager creating a login in their own store
```

Expect `insufficient permission: staff.create` (403) and
`no store for the signed-in user` where applicable.
## Step 13 - `018_purchase_stock.sql` (receiving stock, and customer balances)

Two things the app was doing wrong without saying so.

**Receiving a shipment does not add stock.** The Suppliers screen recorded a
purchase as a total, with no products attached to it, so there was nothing for
the database to receive and the inventory number never moved. The money left,
the invoice is in the ledger, and the stock count at closing disagrees with the
delivery note. 018 adds a *Receive* action that writes the stock movements in the
same transaction as the receipt:

```sql
select public.receive_purchase('<purchase-id>');   -- returns lines received
```

Run it once per shipment. Running it twice is safe — lines already received are
skipped, so a retry or a double-tap cannot count your stock twice. A purchase
with lines still unreceived is stock you have paid for and not counted, and the
Suppliers screen now shows that.

Prices come along too: an item's cost becomes a **weighted average** when it
arrives, so re-ordering at a new price does not change the margin on stock you
already hold.

**Customer balances.** "What does this customer owe?" had no answer — the
payment ledger existed but nothing totalled it per customer. Now:

```sql
select * from public.customer_balance('<customer-id>');   -- balance_due, lifetime
select * from public.customer_debtors(null, null, 50);     -- who owes, largest first
```

`balance_due` is the live debt. Voided invoices are **excluded** — cancelling
an invoice clears what is owed rather than leaving the customer in debt forever.
Refunds are counted, so returning 200 EGP reduces what they owe by 200.

**The app is safe if you skip this.** Nothing in the app requires these
functions; the Suppliers screen simply keeps the old behaviour of recording a
total without touching stock, and the customer screen shows no balance.

Its gate is [`tests/018_purchase_stock_test.sql`](./tests/018_purchase_stock_test.sql)
(19 assertions), also run by `npm run test:db` and CI.

## Step 14 - Offline checkout queue (no SQL)

There is no migration for this one. Before it, the app told staff *"Changes will
sync when you reconnect"* and nothing implemented it: a sale rung up while
offline was **lost**, while the banner said it was safe. That promise is now
removed — the banner says a new sale cannot be saved while offline, which is
what actually happens.

Checkout is now genuinely queued: complete a sale offline and it is held on the
device, then sent when the connection returns. It cannot be lost or duplicated,
because every checkout already carries an idempotency key (migration 012), so a
resend returns the original sale instead of creating a second one. Until the
replay lands, the screen says *"Saved on this device. It will sync to the shop
when you reconnect."*

Only **checkout** is queued. Voiding a sale, deleting a shipment or adding staff
still fail loudly while offline, on purpose: those are decisions made against
what you could see, and replaying them minutes later would apply them to a shop
that has moved on.

**Check it worked:** open the app, put the tablet in airplane mode, complete a
checkout, and reload. The sale should still be listed as pending, and appear
normally once you go back online.

## Step 15 - `019_lab_dwell.sql` (how long a job has been in the lab)

The Lab screen could colour every job by status, and could not tell you which
one was stuck — because a status has no timestamp. This adds the measurement.

```sql
select public.lab_queue();            -- every open job, longest-waiting first
select public.lab_queue('In Lab');    -- just one status
```

The Lab screen now shows a **Waiting** badge next to each job: amber after a day,
red after a week. Those are starting points, not rules — change them in
`WaitBadge` once you know your shop's rhythm.

A database without 019 simply shows no badge, so nothing breaks if you skip it.

**How the timestamps are filled in.** A trigger does it, and it fires only when
the status genuinely *changes* — editing a photo or fixing a typo on an order does
not restart the clock, so "waiting 12 days" means 12 days.

Two of the timestamps are written **once** and never rewritten:

- `lab_started_at` — when the job first left *Not Started*
- `lab_ready_at` — when it first became *Ready*

That matters because a re-opened job (a lens remake, a wrong measurement) must
not erase "how long did the lenses take?" — the one number worth keeping.

**Your existing jobs are back-dated.** A job already in the lab gets its order
date as the starting point, because the real time is unknowable now. Those jobs
will show as very old, which is the safe direction: an old job is one you look
at, and a job wrongly dated to today is one you forget.

**Check it worked:** move a job to *Ready* on the Lab screen and back to *In
Lab*, then:

```sql
select lab_status, lab_status_changed_at, lab_started_at, lab_ready_at
  from public.sales where invoice_no = 'YOUR-INVOICE';
```

`lab_ready_at` should be unchanged from before the re-open, while
`lab_status_changed_at` shows the new time. If both moved, tell me.

Its gate is [`tests/019_lab_dwell_test.sql`](./tests/019_lab_dwell_test.sql)
(14 assertions), also run by `npm run test:db` and CI. The backfill of existing
jobs is not covered by the gate — a gate builds a fresh database, so there is no
history to back-date. The query above is how to check that part.

## Step 16 - `020_version_gate.sql` (keeps the drift check honest)

**Your database is already correct** — you recorded 18 and 19 by hand, and
`select public.schema_version();` returns 19.

This migration exists because the version ledger had a hole in it. 017 introduced
the ledger and recorded itself; **018 and 019 did not.** So a shop that had applied
every migration answered the same version as a shop that had stopped at 017 — and
the "your database is behind" banner could never appear, which is the one thing it
was built to do.

Paste this and it repairs the ledger and adds a guard:

```sql
select public.assert_versions_recorded(array['017_a.sql','018_b.sql','019_c.sql','020_d.sql']);
```

It **fails loudly** if a migration in that list has not recorded its version. You
can run it with the real file names any time; it only raises when something is
actually missing.

You do not need to paste this for anything else to work. It exists so the
mismatch warning keeps working later.

Its gate is [`tests/020_version_gate_test.sql`](./tests/020_version_gate_test.sql)
(10 assertions), also run by `npm run test:db` and CI.

## Step 17 — `021_bootstrap_platform_admin.sql` (only if you are locked out)

`platform_admins` is the one table whose contents bypass every other policy, so
it is locked by design — the SQL Editor, the Table Editor and `CREATE POLICY`
all refuse it. If the only platform-admin login is gone, this is the one
sanctioned way back in, and it works exactly **once**.

1. Create the Supabase Auth login first (**Authentication → Users → Add user**),
   with the email you will pass below. Auto-confirm it.
2. Paste [`021_bootstrap_platform_admin.sql`](./021_bootstrap_platform_admin.sql).
3. Run this **in the same editor session**, before pasting anything else:

   ```sql
   select * from public.bootstrap_platform_admin('admin@lensypos.local');
   ```

It returns the `auth_uid` and `username` it promoted.

**It refuses while any platform admin already exists.** That is deliberate — a
handle that leaks after setup is worth nothing. So if it raises
`a platform admin already exists`, you are *not* locked out; you are already in,
and the fix is to reset that account's password from the Auth dashboard. Do not
keep re-running it.

`execute` is revoked from `anon` and `authenticated`, so nobody can call this
over the API — only someone holding the SQL Editor can, which is the point.

Gate: [`tests/021_bootstrap_platform_admin_test.sql`](./tests/021_bootstrap_platform_admin_test.sql)
(10 assertions).

## Step 18 — `022_sales_kind.sql` (a prescription is not a billable order)

Adds `sales.kind` (`'sale'` | `'prescription'`, default `'sale'`, constrained)
and re-derives it inside `create_sale_order`. "Orders today" now counts orders
rather than every row, so standalone prescriptions stop inflating it.

The kind is **re-derived in SQL, not trusted from the browser**, and claiming
`'prescription'` on a real order is refused unless the cart is worth nothing —
so it cannot be used to hide a sale from the count.

Paste [`022_sales_kind.sql`](./022_sales_kind.sql), then confirm:

```sql
select conname, convalidated from pg_constraint where conname = 'sales_kind_check';
```

`t` under `convalidated` means the constraint is live *and* already checked
your existing rows — the migration validates rather than assumes.

Gate: [`tests/022_sales_kind_test.sql`](./tests/022_sales_kind_test.sql)
(18 assertions).

## Step 19 — `023_z_report.sql` (how much should be in the drawer?)

Adds the `shift_closes` table, a live `z_report(from, to)`, and
`close_shift(from, to, counted_cash, note)`. The close is **stored, not
recomputed**, so "was the drawer right last Tuesday?" stays answerable after a
later re-price moves today's numbers.

A void is **not** filtered out of the cash figures. `void_sale` writes a
compensating negative payment on the same tender, so the money cancels itself
inside the sum — a voided invoice leaves the drawer exactly as empty as the sale
left it full. Do not "fix" this by excluding voided rows; that is a different,
and wrong, answer to the same number.

Paste [`023_z_report.sql`](./023_z_report.sql).

> **Do not verify this with a bare `select * from public.z_report(...)` in the SQL
> Editor.** It returns zeros — and not because the shop has sold nothing.
> `z_report` takes the caller's store from `auth_store_id()`, the SQL Editor has
> no signed-in user, `store_id` is NULL, and the query therefore matches nothing.
> This has already misled us once. Check the numbers in the app (Close Shift
> shows the live Z report) and keep the SQL Editor for the structural checks:
>
> ```sql
> select public.schema_version();                -- expect 23
> select to_regclass('public.shift_closes');    -- expect shift_closes
> ```

Gate: [`tests/023_z_report_test.sql`](./tests/023_z_report_test.sql)
(21 assertions).

## Step 20 — `024_closing_permission.sql` (reading numbers ≠ counting the drawer)

Step 19 gated `close_shift` on `reports.edit`. That couples two decisions a shop
makes separately: a manager who reviews the numbers, and a cashier who counts
the drawer at closing time. Granting the second would hand them Reports as a
side effect. So this adds `closing.view` and `closing.edit`, and `close_shift`
now requires the latter.

Paste [`024_closing_permission.sql`](./024_closing_permission.sql), then run its
seed **in the same session**:

```sql
select public.seed_closing_permissions();
```

It is a **function, not bare `INSERT`s**, and that is the point: a gate builds a
fresh database *after* migrations have run, so migration-time seeding is
invisible to any test of it. Being callable again means a "shift supervisor"
role added next year gets the same grants by running one line.

Who receives the permissions is inherited — the seed copies `reports.edit` to
both new codes — so roles that could already see the numbers can now also close
the drawer, and roles that could not get nothing. Confirm what it did:

```sql
select p.code, count(*) as roles
  from role_permissions rp join permissions p on p.id = rp.permission_id
 where p.code like 'closing.%' group by 1 order by 1;
```

Gate: [`tests/024_closing_permission_test.sql`](./tests/024_closing_permission_test.sql)
(14 assertions).

## Step 21 — the one decision this roadmap has been deferring

`012_integrity.sql` shipped the oversell guard **inert**. `stores.allow_negative_stock`
defaults to `true`, so every store still sells below zero stock exactly as it
did before Phase 1. Nothing is wrong — the protection has simply never been
switched on.

```sql
-- per store:
-- update public.stores set allow_negative_stock = false where id = '…';
```

Turn it on when you are willing for checkout to **refuse** with
`insufficient stock: <name>` rather than sell. There is no UI toggle yet; adding
one needs the stores write policy loosened, which is Phase 3 territory.

## Where you are

`select public.schema_version();` should return **25** — the app expects 25 and
shows a version banner when the two disagree. Steps 1–16 are history; if your
number is below 20, work down from here.

## Step 22 — `025_platform_reports.sql` (revenue across every store)

Adds one report a **platform admin** can read: every store's revenue for a
calendar day, in one table. It is the first screen in the app that shows one
store's money to somebody who does not belong to that store — everything else
here is tenant-scoped on purpose.

Paste [`025_platform_reports.sql`](./025_platform_reports.sql).

**Each row is that store's own local day.** A store in Cairo and a store in UTC
get different windows for the same calendar date, and the screen shows the zone
so the numbers can be read correctly. There is no shared-UTC alternative here to
accidentally fall back on.

Two things it deliberately does **not** do:

- It does not filter out voided sales — it excludes them, because this is
  *revenue*, not a drawer. `z_report` (Step 19) keeps them, because
  `void_sale` writes a compensating negative payment that cancels inside the
  sum. Both are right, for different questions. Don't "harmonise" them.
- It does not work for a shop admin. It raises `platform admin only`, and
  `execute` is revoked from `anon` entirely, so the refusal is in SQL and not
  only in the screen.

A shop with no sales that day appears as a row of zeros rather than a missing
row — "sold nothing" and "we have no such shop" are different answers.

Gate: [`tests/025_platform_reports_test.sql`](./tests/025_platform_reports_test.sql)
(14 assertions).

## Schema baseline (recommended, ~2 minutes)

The hardening roadmap (Phase 0) wants a `pg_dump` of the **live** `public`
schema committed under [`baseline/`](./baseline), so every later migration has a
reference snapshot to diff against.

**Name the label after the state you are actually capturing.** The workflow's
default is `schema_after_012`, because `012_integrity.sql` is already applied to
the live project — the first capture (committed as
`baseline/schema_after_012.sql`) is therefore the *after-012* schema, not a
pre-012 "before" picture. A "before" name on an after-012 capture is the kind
of quiet lie that makes the next diff wrong. A pre-012 snapshot can no longer be
produced from the live project; that shape is reconstructible from
`web/supabase/000..011` plus `012` itself.

The dump runs in CI (`.github/workflows/schema-baseline.yml`) instead of on a
workstation, for two reasons: `supabase db dump` runs `pg_dump` inside a Docker
container, and the direct host `db.<project-ref>.supabase.co` is IPv6-only while
GitHub-hosted runners have no IPv6 — so the runner reaches the database through
the Supavisor **session pooler** instead.

1. **Get the database password.** If you don't have it, reset it:
   **Settings → Database → Reset password**. This is safe for the app: it talks
   to PostgREST over HTTPS with the API key, not with the database password, and
   Supabase's docs say managed services are updated automatically, with no
   downtime. Prefer **letters and digits only** — a password containing `@`,
   `:`, `/`, `#`, `?` or `%` must be percent-encoded inside the URI, which is the
   most common way this step fails.
2. **Get the Session pooler URI.** Click **Connect** in the project header — the
   **Settings → Database** page no longer shows connection strings — then choose
   **Session pooler**, put the password in place of `[YOUR-PASSWORD]`, and copy
   the whole string. It must look like
   `postgresql://postgres.qhbprvavoudetjbyxrsn:<password>@<cluster>.pooler.supabase.com:5432/postgres`:
   the username carries the project ref (`postgres.<ref>`, not plain `postgres`),
   the host ends in `pooler.supabase.com` (copy it from the dialog — e.g.
   `aws-1-us-east-2`; the leading `aws-N` is a pooler cluster index, not the
   region, so it cannot be typed from memory), and the port is `5432`. If the
   host is `db.qhbprvavoudetjbyxrsn.supabase.co`, that is the *direct*
   connection — fine on a laptop, unusable from a GitHub runner, which has no
   IPv6.
   > Session mode (port `5432`) is required — `pg_dump` cannot run through the
   > transaction pooler (port `6543`).
3. **Add it to GitHub.** Repo → **Settings → Secrets and variables → Actions →
   New repository secret** → name `SUPABASE_DB_URL` → paste the URI.
4. **Run it.** GitHub → **Actions → "Schema baseline (manual)" → Run workflow**
   (keep the default label `schema_after_012`). It writes
   `web/supabase/baseline/schema_after_012.sql`, uploads it as an artifact, and
   commits it to `main`. Re-running with an unchanged schema is a no-op, so a
   new commit from this workflow is itself the drift signal.
5. **If it fails** the error names the cause: `password authentication failed`
   → the secret holds an old or unencoded password; `tenant or user not found`
   → the URI is not the session-pooler one (username `postgres.<project-ref>`,
   host ending `pooler.supabase.com` copied from the Connect dialog, port
   `5432`); `no CREATE TABLE statements` → the dump connected somewhere
   unexpected.

Without a runner, the equivalent is
`pg_dump "<session-pooler-uri>" --schema-only --schema=public --no-owner`
(a host with `pg_dump` ≥ the server's major version; the runner uses the
`postgres:18` image for exactly that reason).

## Migrating existing staff (later)

Your old `public.users` table (bcrypt `password_hash`) is now **legacy** — Supabase
Auth owns passwords. For each existing staff member, create an auth user as in
Step 2. Once everyone is migrated, the `password_hash` column can be dropped.
We'll build an in-app "Staff" screen that creates auth users via an Edge Function
(service-role) in Phase 5, so you won't need the dashboard for this long-term.

## What the app does with all this

- `web/src/lib/auth.tsx` — `signInWithPassword`, session persistence + refresh,
  `useAuth()` for components.
- `web/src/components/AppLayout.tsx` — redirects to `/login` without a session.
- Username → email mapping lives in `usernameToEmail()`; a full email also works.
