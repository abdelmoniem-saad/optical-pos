# Offline-first LensyPOS (shop PC + cloud replica)

The shop PC (the **register**) is the **system of record** and works with no
internet. Supabase is a **one-way replica** used for the owner's read-only phone
view and as the off-site backup. Sync only goes PC → cloud, so there are no
conflicts to merge.

Everything is behind build flags; with no flags set the app behaves exactly as
before (`VITE_DATA_MODE=supabase`). The build refuses misspelt flags.

| Site (render.yaml) | Flags | Who uses it |
|---|---|---|
| `lensy-web` (today's app) | `VITE_DATA_MODE=supabase` | unchanged; retire it for sales after cutover |
| `lensy-register` | `VITE_DATA_MODE=local`, `VITE_CLOUD_URL=<lensy-phone URL>` | the one till computer |
| `lensy-phone` | `VITE_DATA_MODE=supabase`, `VITE_READ_ONLY=true` | owner's phone, QR photo uploads, vendor Platform page |

## How it works

```
 screens ─► data/*.ts hooks ─► getRepo() ─┬─ SupabaseRepository   (default / phone)
                                          ├─ readOnly(Supabase)   (VITE_READ_ONLY)
                                          └─ LocalRepository      (shop PC)
                                                 │ commit(): ONE IndexedDB transaction
                                                 ├─ mirror tables (customers, sales, …)
                                                 └─ outbox entry (row upserts/deletes)
                                                        │ sync engine (when online)
                                                        ▼
                                                  Supabase (upsert/delete by key)
```

- **Repository seam** – `src/lib/repository.ts`. `repositoryLocal.ts` reproduces
  the cloud's filters, sort orders, limits, cascade rules **and unique rules**
  (duplicate SKU / position / lens-type names are refused at once, as online).
- **Local DB** – `src/lib/local/db.ts`, a small dependency-free IndexedDB layer.
  Every write is applied to the mirror and appended to the outbox in one
  transaction. Other open windows of the app are told about every change.
- **Sync** – `local/sync.ts` drains the outbox **in order**:
  - batches consecutive entries; if the cloud rejects a batch, its entries are
    re-sent one by one so the queue stops at the entry that is really wrong;
  - a rejected change **holds the queue** (later changes may depend on it) and
    shows in the sync panel; an admin can skip exactly that change;
  - a photo the cloud refuses is set aside (shown in the panel, admin can stop
    it) and **never** blocks the other changes;
  - deletes the cloud silently ignores (license/permissions) are detected and
    held instead of being dropped;
  - only **one window** of the app syncs at a time (Web Locks);
  - nothing is sent while the store license is not active (it waits);
  - every 10 minutes: license refresh, register check, staff added elsewhere
    are brought down (and staff deactivated in the cloud are deactivated here);
  - photos taken on the phone are adopted from the newest files in storage
    (a photo older than its order is never attached);
  - after a full upload the PC writes `settings.pc_last_sync`, shown on the
    phone view ("Shop computer last synced").
- **One register per store** (migration 011) – setup claims the store's
  register slot. A second computer can only take over explicitly ("Replace the
  old register"); the old one then stops uploading.
- **Invoice numbers** – the PC's own sequence, **reserved when handed out**
  (an abandoned order never gives its number - or its photos - to the next
  customer), under a lock shared by all windows; never moves backwards (backup
  import also checks the cloud's highest number).
- **Sign-in on the PC** – `local/localAuth.ts`. When online, the password is
  checked against that person's own cloud login every time (a password changed
  or a login removed in the cloud stops working on the PC too); offline, a
  PBKDF2 verifier kept on the PC is used. Staff added after setup sign in once
  while online. Only admins can set an offline password.
- **Cloud sync account** – replication runs as the store admin who set the PC up.
  Signing out on a phone no longer signs the PC out (sign-out is per device).
- **New Sale wizard** – survives a reload or power cut, belongs to the signed-in
  person, is cleared on sign-out; a reload during checkout continues the saved
  sale instead of creating a duplicate.

## Going live (checklist)

**Supabase (once):**
1. SQL Editor: run `supabase/011_multistore_hardening.sql`. Then run the review
   query at its end and check the listed logins are your staff.
2. Edge Functions: deploy the new `supabase/functions/create-user/index.ts`
   (Dashboard → Edge Functions → create-user → paste → Deploy, or
   `supabase functions deploy create-user --project-ref qhbprvavoudetjbyxrsn`).
3. Authentication → Sign In / Providers: turn **off** "Allow new users to sign up"
   (logins are created only by Add Staff / the vendor).

**Web (Render):** deploy the three sites in `render.yaml`; set
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` on each, and on `lensy-register`
set `VITE_CLOUD_URL` to the `lensy-phone` address.

**Shop PC:** open the `lensy-register` address in Chrome or Edge, install it as an
app, and complete **Set up this computer** with the store admin login (internet
needed once). Recommended: a dedicated admin login used only for this PC.
Do not clear the browser's site data, and keep the address unchanged.

**After every site runs the new build:** run `supabase/012_settings_per_store.sql`.

**Cutover:** from then on sales are made on the PC only. Stop using `lensy-web`
for sales (set `VITE_READ_ONLY=true` on it, or remove it) - a second writer to the
cloud is the one thing this design cannot merge.

**PC replaced or broken:** set up the new computer (tick "Replace the old
register"). If the old one had changes it never uploaded, import its last backup
file on the new PC (Settings → Backup). "Restore from cloud" refuses while
changes are waiting and if the download looks wrong (empty, license, session).

## How to test each phase

Gate: `& $node node_modules\typescript\bin\tsc -b` and
`& $node node_modules\vite\bin\vite.js build` – both pass.

`.claude/launch.json` has **lensy-web supabase (node)** (port 5198) and
**lensy-web local-mode test (node)** (port 5199, `web/.env.localtest.local` →
`VITE_DATA_MODE=local`). Different ports = different browser storage, but both
use the **real Supabase project** from `web/.env.local`: test with a test store.

- **Phase 0 (seam)** – default build: log in, make a sale, adjust stock, change a
  lab status, open Reports, scroll History/Customers past the first page.
- **Phase 1 (local POS)** – local build: complete setup, then turn Wi-Fi off and:
  sign in, sell (with and without an exam), print, re-checkout the same invoice,
  add/edit a customer, adjust stock, change lab status, attach a photo, reload
  mid-sale (the order must still be there).
- **Phase 2 (sync)** – with changes made offline, open the sync chip (bottom of the
  sidebar): it shows the waiting count. Turn Wi-Fi on: the count drains to 0;
  check the rows/photos in Supabase and `settings.pc_last_sync`.
- **Phase 3 (phone)** – read-only build: owner sign-in lands on Reports with the
  "read-only view" strip and the PC's last sync time; the ☰ menu works at phone
  width; any save says "Read-only view…"; a QR photo from the PC appears on the
  PC order within ~2 minutes.
- **Phase 4 (safety)** – Settings → Backup: export, import back, Restore from cloud;
  a second browser profile running setup is told the store already has a register.

## Known limits

- **Phone read-only is enforced in the app**, not in the database (the owner's
  login can write via the API). For a hard guarantee give the owner a viewer login
  and an RLS rule that denies its writes.
- The cloud sync session is stored in the PC's browser; anyone with access to
  that Windows account can use it. Use a dedicated admin login for the PC and
  lock the Windows account.
- While the PC is **offline**, a staff member removed in the cloud can still sign
  in on it until it is online again.
- Photos attached before the PC was set up show from the cloud (need internet);
  photos taken on the PC or adopted from the phone are kept on the PC.
- If a column is added to Supabase after the sync engine stripped it, clear the
  `strippedColumns` entry (local DB → `meta` store) so it replicates again.
- `create_sale_order` RPC is not used by the PC (rows are upserted directly with
  the PC's invoice number); the online app still uses it.
- The offline license check uses the PC's clock.
