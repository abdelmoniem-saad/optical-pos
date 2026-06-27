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
