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

## Schema baseline (recommended, ~2 minutes)

The hardening roadmap (Phase 0) wants a `pg_dump` of the **live** `public`
schema committed under [`baseline/`](./baseline), so every later migration has a
"before" picture to diff against.

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
   (leave the label `schema_before_012`). It writes
   `web/supabase/baseline/schema_before_012.sql`, uploads it as an artifact, and
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
