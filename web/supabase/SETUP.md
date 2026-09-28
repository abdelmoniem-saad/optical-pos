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
