# Release 031 (offline-v2 Phase 0b)

Release status: NOT deployed. Migration 031, the matching web client and the
`create-user` change are on branch `offline-v2-phase0b` only. Tests ran in the
disposable local Postgres database. Pushing code does not apply SQL, deploy the
web app or deploy the Edge Function.

## What it changes

- **Names are unique per store, not across every store.** A product SKU and the
  name of a lens type, frame type or frame colour may now repeat between stores,
  never inside one. The shop sees no difference; a second store no longer
  collides with the first one's names. A blank SKU is stored as "no SKU".
- **Settings are saved per store.** The app saves a setting against
  (store, key). The old global key rule stays until offline-v2 migration 032,
  so a device still running the previous app keeps saving settings.
- **The photo sweep can no longer offer live photos for deletion.** Platform ->
  "Scan storage" used to read every sale's photo paths in one request, which
  the server cuts at 1,000 rows: past that, photos real invoices still use were
  listed as orphans. It now reads each store's list page by page to the end,
  and never lists a photo younger than 14 days (a photo is uploaded before its
  sale is saved, and a sale held offline may arrive a day later).
- **A switched-off staff member no longer takes a seat** of the plan's staff
  limit (`create-user`), and switching someone back **on** is now refused when
  the store is already at its limit (`set_staff_access`), so the limit cannot
  be stepped around by switching people off and on.

## Order: SQL, then the Edge Function, then the web app

The new web app saves settings with a rule only 031 creates; against a 030
database every settings save would fail. So:

1. Supabase SQL Editor - check the version:

   ```sql
   select * from public.lensy_schema_versions order by version;
   ```

   If 30 is the latest, run the complete contents of
   `web/supabase/031_per_store_unique.sql`. It is one transaction and safe to
   re-run; if it errors, stop and keep the error. It prints a notice for each
   global rule it removes. Repeat the query and confirm 31 is recorded.

2. Edge Function `create-user` - deploy `supabase/functions/create-user/` from
   this branch (only `index.ts` changed):

   ```sh
   supabase functions deploy create-user --project-ref qhbprvavoudetjbyxrsn
   ```

   or, in the dashboard, Edge Functions -> create-user -> edit `index.ts` to
   match the file in the repository -> Deploy. Until this is deployed, a
   switched-off staff member still counts against the staff limit; nothing
   else depends on it. (031 already refuses switching staff back on past the
   limit, so deploying it later never lets a store exceed its limit.)

3. Merge the pull request into `main`; Render deploys the web app. Reload the
   shop's devices.

Do not run any `tests/*_test.sql` file, `_shim.sql` or the local database
scripts against production.

## Check after deploying (in a test store, not with real money)

- Settings: change the shop name in Settings, reload - it stays changed.
- Inventory: add a product with an SKU, then a second product with the same
  SKU - the second is refused. Two products with no SKU are both saved.
- Optical settings: adding a lens type with an existing name is refused.
- Platform -> Scan storage: the scan completes; a photo attached today is never
  listed.

## Repository CI gate

031 changes the schema fingerprint (four constraints dropped, five indexes and a
function added). The new hash is taken from the PR's CI step summary, as for
029 and 030.

Local verification: production build, 309 frontend tests, 473 pgTAP assertions
(449 before 031 plus 24 in `031_per_store_unique_test.sql`).
