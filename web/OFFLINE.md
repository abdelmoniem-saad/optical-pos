# Offline-first LensyPOS (shop PC + cloud replica)

The shop PC is the **system of record** and works with no internet. Supabase is a
**one-way replica** used for the owner's read-only phone view and as the off-site
backup. Sync only goes PC → cloud, so there are no conflicts to merge.

Everything is behind build flags; with no flags set the app behaves exactly as
before (`VITE_DATA_MODE=supabase`).

| Build | Flags | Who uses it |
|---|---|---|
| Today's app (default) | `VITE_DATA_MODE=supabase` | unchanged |
| Shop PC | `VITE_DATA_MODE=local`, `VITE_CLOUD_URL=<phone app URL>` | the one till computer |
| Owner phone view | `VITE_DATA_MODE=supabase`, `VITE_READ_ONLY=true` | hosted, read-only |

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
                                                  Supabase (upsert/delete by PK)
```

- **Repository seam** – `src/lib/repository.ts` (`PosRepository`, `getRepo()`).
  `repositorySupabase.ts` is the original Supabase code moved verbatim;
  `repositoryLocal.ts` reproduces the same filters, sort orders, limits and cascade
  rules on IndexedDB.
- **Local DB** – `src/lib/local/db.ts`, a small dependency-free IndexedDB layer
  (no npm on the build machine, so no Dexie; nothing to install). Tables and
  their keys are in `local/schema.ts`.
- **Outbox** – the outbox stores *row-level* changes (table, op, primary key, full
  row), not "createSale" calls. Every write is applied to the mirror and appended to
  the outbox in the same transaction, so the two can never disagree. Inserts use
  client-generated UUIDs, so replaying an entry is harmless (upsert by PK).
- **Sync** – `local/sync.ts`: drains the outbox **in order**, batching consecutive
  entries for the same table; uploads queued photos first; refreshes the cached
  license; adopts photos taken on the phone. Network/5xx errors back off and retry.
  A change the database rejects (constraint, RLS…) **holds the queue** at that entry
  (later changes may depend on it) and shows up in the sync panel, where an admin
  can read the error and skip it. A column the cloud doesn't have is stripped
  automatically and remembered.
- **Invoice numbers** – the PC's own sequence: max(local invoices, persisted
  high-water mark) + 1. One writer means no collisions; numbers are never reused.
- **Stock** – still the append-only `stock_movements` ledger, so replay is exact.
- **store_id** – set explicitly on every row created offline (no trigger needed).
- **Local sign-in** – `local/localAuth.ts`: salted PBKDF2 password verifiers kept on
  the PC. A staff member's first sign-in while online is checked against Supabase and
  cached; after that it works offline. Admins can set an offline password per person
  (Staff → Offline sign-in). Replication runs as the separate **device account** (the
  admin who set the PC up); staff signing in/out never touches it.
- **License** – the cloud's answer is cached and made *stricter* as time passes
  offline (active → grace after expiry → expired after 30 days). Like the cloud's RLS,
  only an active license may write.
- **New Sale wizard** – now also persisted to `localStorage`, so a reload or power
  cut mid-sale keeps the order (all modes).
- **Phone photos (QR)** – the QR codes point at `VITE_CLOUD_URL` (phones can't open
  the PC's localhost). The phone uploads to storage only; the PC adopts the photo at
  checkout, or within ~2 minutes for recent orders.

## Deploying the shop PC

1. Build with `VITE_DATA_MODE=local` and `VITE_CLOUD_URL=https://<phone-app-host>`.
2. Serve it from **HTTPS or `http://localhost`** (offline sign-in needs WebCrypto,
   which browsers only allow on secure origins). Recommended: host this build on its
   own subdomain (e.g. `register.<domain>`) and install it as an app from Chrome/Edge –
   the existing PWA service worker caches the app so it opens with no internet.
3. First run shows **Set up this computer**: sign in once with the store admin account
   (internet needed this one time). Everything is downloaded; that admin can then sign
   in offline immediately.
4. Do **not** clear the browser's site data for that origin and do **not** run a second
   PC in local mode – there must be exactly one writer.

Owner phone: build with `VITE_READ_ONLY=true`, host it, sign in with the owner account.

## How to test each phase

Gate (no web tests exist): `& $node node_modules\typescript\bin\tsc -b` and
`& $node node_modules\vite\bin\vite.js build` – both pass.

`.claude/launch.json` has two extra configs: **lensy-web supabase (node)** (port 5198)
and **lensy-web local-mode test (node)** (port 5199, uses the git-ignored
`web/.env.localtest.local` → `VITE_DATA_MODE=local`). Different ports = different
browser storage, so local-mode test data never mixes with anything else.

- **Phase 0 (seam)** – default build: log in, make a sale, adjust stock, change a lab
  status, open Reports. Everything should behave exactly as before.
- **Phase 1 (local POS)** – local build: complete setup, then turn Wi-Fi off and: sign
  in, sell (with and without an exam), print the receipt, re-checkout the same
  invoice, add/edit a customer, adjust stock, change lab status, attach a photo,
  reload mid-sale (the order must still be there).
- **Phase 2 (sync)** – with changes made offline, open the sync chip (bottom of the
  sidebar): it shows the waiting count. Turn Wi-Fi on: the count drains to 0 within
  seconds; check the rows/photos in Supabase. Invoice numbers must match the PC's.
- **Phase 3 (phone)** – read-only build: owner sign-in lands on Reports, a
  "read-only view" strip is shown at the top, "New Sale" is hidden, and any save shows "Read-only
  view – changes are made on the shop computer." Phone photo upload (QR) still works
  and the photo appears on the PC order shortly after.
- **Phase 4 (safety)** – Settings → Backup: export a file, import it back, and
  "Restore from cloud" (refused while changes are still waiting to upload).

What was verified in this change (local-mode server with seeded test data, cloud
calls replaced by an in-page recorder so nothing reached Supabase): offline sale end
to end (UUID ids, `store_id`, staff attribution, stock 5→4, ordered outbox), wizard
survives reload, invoice sequence 000041→000042→000043, re-checkout updates the same
invoice (old lines/movements deleted before new ones), sync drains in order /
blocks on a rejected change / retries on network failure / strips an unknown
column, photo queue uploads, expired license refuses writes, cascade guard,
read-only wrapper, backup export→import round trip, offline password sign-in,
History/Inventory/Settings render from IndexedDB with no console errors. **Not
verified**: a real setup + sync against your Supabase project (needs an admin
login) – run Phase 1–4 above once on a test store.

## Known limits / follow-ups

- **Phone read-only is enforced in the app**, not in the database. For a hard
  guarantee give the owner a viewer account and add an RLS rule that denies writes
  for it (needs a schema change; not done here).
- Photos attached **before** the PC was set up are shown from the cloud, so they need
  internet; photos taken on the PC are kept locally.
- If a column is later added to Supabase after the sync engine stripped it, clear the
  `strippedColumns` entry (local DB → `meta` store) so it replicates again.
- An offline password stays valid until changed on the PC, even if the cloud password
  changes.
- `create_sale_order` RPC is not used by the PC (rows are upserted directly with the
  PC's invoice number); online mode still uses it.
- Behaviour change in all modes: the phone upload page now shows the photo slots for
  an invoice that isn't in the cloud yet (the existing "photos will attach when the
  order is confirmed" message was unreachable before).
