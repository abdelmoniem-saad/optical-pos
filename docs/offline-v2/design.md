# LensyPOS offline-first register: design, revision 2

Revision 2 replaces revision 1 (written against `main` at cf78ca5). It answers every item in `docs/offline-v2/critique.md` and every verified finding of the v1/v2 comparison; Appendix A maps each one to the section that resolves it.

**Conventions.**
- Paths are relative to `web/` unless they start with `supabase/functions` or `docs/`.
- `NNN:a-b` means `web/supabase/NNN_*.sql`, lines a-b, in the working tree (branch `offline-first-v2` = `main` + PR #3).
- `v1:` means branch `origin/offline-first` (read with `git show origin/offline-first:<path>`).
- "Flag" = the op is applied and a violation code is recorded. "Hold" = the op is rolled back and the queue stops at it. "Refuse" = the op is recorded but not applied, and the queue continues. §3.4 defines these exactly.

---

## 0. Status and what changed since revision 1

Phase 0 is **built and CI-green in PR #3, not deployed**. It contains `030_money_fixes.sql` (793 lines, stamped at 030:792): append-only re-checkout with refund first, legacy tenders take no new money, per-tender stale check (`expected_tenders`), `price_cart` keeps the net with line discounts (the header discount is the WHOLE discount), void after a partial refund, idempotent replay before the gates, per-store invoice uniqueness (`sales_store_invoice_no_key`, 030:82-84, with the per-store existence check at 030:325-330), client time bounded by `sale_event_time` (030:196-205) for the sale, its payments and its stock movements (030:371-375), and `create_sale_order` refusing unknown tenders (030:260-266). Client side: offline-queued first checkout with a default `mutationFn`, a checkout journal and banner for failed or lost queued sales, a refund-first pre-check, `receiptTotals` so the receipt matches the stored header, and access no longer polled. Gates: 299 vitest, 448 pgTAP assertions in 25 gate files; the schema fingerprint excludes pg_dump's version header (a0bcafc).

What changes in this revision, in one list:
1. The `_impl`/`p_mode` refactor of about 30 audited RPCs is dropped (OE1). The register path gets thin `_ingest_<kind>` writers and one flag evaluator. The online money RPCs (030's create/update/void, 028's refund, 029's collect) are untouched; the other body changes are listed in §4: the `receive_purchase` cost fix (029:588-675) and the `resolve_can`/`is_store_admin` store guard (029:44-71) in 032, `my_permissions` (029:81-89) in 033, and `my_license_state` (026:82-101) and `license_feature` (027:54-65) refactored onto store-parameterised internals in 034.
2. One outcome rule: policy failures flag, never hold. Holds are reserved for data the database cannot store or that proves divergence. Forger-only conditions are refused without stopping the queue.
3. `resolve_can` keeps its signature and grant (C1). Store-parameterised internals replace `auth_store_id()` on the ingest path (C2).
4. One guard trigger enforces `register_only` on every write path, including platform admins and service role (H1).
5. Two builds, not three. The phone reads `read_only` from `my_permissions()` (H2, OE2).
6. The stolen-token chain is cut: cloud logins and the owner are protected targets, `revoke_register` keys on `stores.owner_uid`, no register storage delete, seq-conflict quarantine (H3).
7. Invoice numbers are allocated at cart entry (H4); events are stamped with the wall clock (H5); the TS rules use integer minor units (H6); payloads carry derived rows verbatim (H7).
8. Every restore is a takeover with a new epoch and a re-hydrate from the cloud log (H8); browser-profile safeguards are mandatory at setup (H9).
9. Migrations are renumbered 031-034 because 030 is taken (034 is a working number; it takes the next free number when applied, §4). 031-033 ship live; 034 (the ingest contract) is applied only after the end-to-end parity test is green.
10. The plan is re-cut and re-estimated: about 62-92 developer-days after Phase 0.

---

## 1. The core decision

The PC is the system of record. The model of revision 1 stands, amended:

1. **On the PC.** A TypeScript port of the server's money and RBAC rules runs against IndexedDB. Each user action commits its mirror rows and exactly one op in one IndexedDB transaction. The op carries every id, the invoice number, the timestamp and every derived row (ledger rows, stock movements) verbatim.
2. **In the cloud.** One SECURITY DEFINER RPC, `register_ingest`, applies the log strictly in `seq` order. Each op goes to a thin writer that inserts the PC's rows with an explicit store, actor and time. The online RPCs that other stores use are not modified.
3. **Why ordering is enough.** The register is the only writer for its store (§4.3 guard trigger). Ops are applied in order, so the cloud's state before op N equals the PC's state when op N was committed. The server can therefore evaluate permissions, prices, stock and licence "as of event time" against its own state, without re-dating anything.
4. **Facts, checks and caches.**
   - Facts are stored verbatim: who, when, invoice number, lines, prices, tenders, derived refunds and movements, counted cash.
   - Policy (permission, catalogue price, stock, licence, clock, plan limits) is evaluated and **flagged**. The cash or goods already moved; holding would only hide the fact from the owner.
   - Representability (CHECK, FK, unique, NOT NULL, payload shape, tenancy) is **enforced**. A failure means a bug or divergence.
   - The trigger caches (`stock_qty`, `amount_paid`) recompute as they do online. Where the server's own recomputation of a stored figure differs (Z expected cash, weighted cost, void derivation), the PC value is kept and a flag records the difference.
5. **The owner's phone** is the ordinary cloud build, made read-only by the server.
6. **Selling never waits for the network.** Sync failures, holds, a seq-conflict quarantine and an owner Revoke delay the phone view; they never stop the till. There are exactly two deliberate stops, both enforced in `commit()` (§2.3 step 3) for business kinds only: another PC has taken over the register (`stranded`, §6.4), and the licence is not `active` (§2.5), which includes `contact_due` after 45 days or 45 shift closes without any server contact (vendor decision V2). In both, sign-in, PIN changes, reprints, reports and backup export keep working.

Rejected alternatives, unchanged from revision 1's analysis: row upserts (v1; refused by 029:739-740 and 029:818 grants, and no payment ledger), and replaying the public RPCs (they stamp `now()` and clamp time through `sale_event_time`, so multi-day offline sales would be re-dated; comparison sync-model v2_problems[9]).

---

## 2. Architecture

### 2.1 Builds (two)

| Build | Flags | Users | Data |
|---|---|---|---|
| Cloud (`lensy-web`) | `VITE_DATA_MODE=cloud` (default) | Other stores, the vendor's `/platform`, and the owner's phone | Supabase |
| Register (`lensy-register`) | `VITE_DATA_MODE=register` | The shop PC only | IndexedDB plus the sync worker |

- `VITE_READ_ONLY` and the `lensy-phone` site are dropped (OE2). Read-only comes from the server (§2.8).
- The register site is created at the **start** of Phase 3b on one fixed custom domain (for example `register.<vendor-domain>`), never a `*.onrender.com` service name, so the IndexedDB origin never changes (H9). It is installed as a PWA with `registerType: 'prompt'`.
- An update is applied only between commits: it waits until the commit queue is idle and the sync Web Lock is free. Drafts and held ops never block an update; when an op is held, the sync panel says "Update available - may fix the held change".
- Ported from v1: the build-flag check and misspelt-flag guard (`v1:web/src/lib/config.ts:16-54`, `v1:web/vite.config.ts:11-30`), the wrong-build guard and DB-open failure screen (`v1:web/src/main.tsx:50-107`), and the one-reload `vite:preloadError` guard, added to **both** builds. `VITE_CLOUD_URL` and `publicAppUrl` are dropped with the QR flow (§2.9).

### 2.2 Data seam

Counted in non-test `src/`: 119 `.from(` plus 34 `.rpc(` call sites in 22 files; 24 files import `lib/supabase` (sales.ts 39, suppliers.ts 15, inventory.ts 13, POSContext.tsx 12, customers.ts 12, PlatformPage.tsx 8, and the rest).

- `src/data/backend/types.ts` defines `Backend`, grouped by area, including an `auth` area (signIn, signOut, session, onChange).
- `src/data/backend/cloud/*.ts` holds today's `queryFn`/`mutationFn` bodies, moved verbatim. Hooks keep their names, query keys and invalidation groups (`data/refresh.ts`).
- `src/data/backend/local/*.ts` is the register implementation, checked with `satisfies Backend`.
- Selection is a static `@backend` alias resolved by a Vite `resolveId` plugin (the `qa/vite.config.ts:8-10` pattern), so the cloud bundle contains no IndexedDB code and the register bundle no PostgREST data calls outside `lib/register/sync.ts`.
- Cloud-only files stay outside the interface and out of register routes: `PlatformPage`, `platformReports`, `storageCleanup`, `MUploadPage` (12 call sites).
- Moved behind the seam: POSContext's 12 direct calls (`enterAfterCustomer`, `findOrCreateFrame`, `quickAdd`, `loadSale`, `findOrderImages`), `StaffPage.tsx:31`, `lib/licensing`, `lib/schemaVersion`, `lib/storage`, `data/staff.ts` `resolveStaffUserId`.
- `CHECKOUT_MUTATION_KEY` (defined at `lib/offlineMutations.ts:34`; its `setMutationDefaults` registration is `lib/queryClient.ts:53`) and the checkout variables shape are **frozen**: a paused checkout persisted by the previous build must still resume after the seam refactor.
- Register-only TanStack settings: `networkMode: 'always'`, no `PersistQueryClientProvider`, no `refetchInterval`, no offline mutation queue. Local commits invalidate through `commitSeq` and a BroadcastChannel.

The cloud build's Phase 0 offline queue stays as built and is **not** extended (no queued re-checkout, refund or collect). It covers only a connection lost after cart entry (`POSContext.tsx:685-688` documents that re-checkout is not queued). The register is the answer for this shop; other stores are online by design.

### 2.3 Local store (IndexedDB `lensy-register`)

`src/lib/register/db.ts`:
- **Versioned upgrade ladder** on `oldVersion` (`if (oldVersion < 1) …; if (oldVersion < 2) …`) keyed on `LOCAL_SCHEMA_VERSION`. A database newer than the build opens a "this computer's data is newer than this app; update the app" screen with no writes (v1's fixed `DB_VERSION=1`, `v1:db.ts:11`, never upgraded).
- **Mirror stores** (key `id`): customers, inventory (`stock_qty` is a local cache; removed from `NON_COLUMN_PROPS`, `v1:schema.ts:86`), stock_movements, sales (unique index on invoice_no, index on idempotency_key and lab_status_changed_at), sale_items, sale_payments (index paid_at), order_examinations, shift_closes (unique from_at+to_at), suppliers, purchases, purchase_items, purchase_payments, lens_types, frame_colors, frame_types, notes, settings, users, roles, role_permissions, user_permissions, permissions, plus local-only `note_seen`.
- **Control stores:**
  - `outbox`: keyPath `s`, **no** `autoIncrement` (gaps across aborts would be refused).
  - `skipped`: originals of skipped ops, keyed by seq, uncapped, included in backups.
  - `images`: `{path, full?, thumb, status: draft|pending|uploaded|set_aside, ref_seq, uploadedAt, lastViewedAt}`.
  - `meta`: `store`, `license`, `clock`, `register` (epoch, credentials), `nextSeq`, `ackedSeq`, `invoiceNext`, `commitSeq`, `sync` state, `bytes[YYYY-MM]`, `lastBackupAt`, backup directory handle, `oldestUnsentAt`.
  - `credentials`: PIN verifiers (§2.7). Never in the outbox, the snapshot or any backup.
  - `drafts`: one POS draft per user (§2.6).

**Commit invariant.** `commit(k, actor, build)`:
1. any `crypto.subtle` work happens before the call;
2. one transaction over the mirror stores, `outbox`, `meta`, `images` and `drafts`, with `durability: 'strict'` for **every** op;
3. **gate**: unless `k` is a log kind (`LOG_KINDS` = `session.start`, `session.end`, `auth.lockout`, `credential.set`, `clock.reset`, plus `staff.set_access` carrying `via_command`), throw and write nothing when `meta.sync` is `stranded` (§6.4) or the licence state (§2.5) is not `active`. Log kinds commit in every state, stranded and expired included, so signing in to reprint or export never throws. No other sync state (`held`, `diverged`, `reclaim_required`, `backoff`, `needs_update`) refuses a commit;
4. `build(tx)` runs the rule against the live snapshot and returns the payload; only IndexedDB requests on `tx` may be awaited;
5. op = `{s: meta.nextSeq, i: crypto.randomUUID(), k, v: OP_FORMAT[k], a: actor, sid, t: eventNow(), e: meta.epoch, p}`;
6. `applyOp(tx, op)` writes every mirror row from the payload and recomputes the local caches exactly as the server triggers do;
7. append to the outbox, bump `nextSeq` and `commitSeq`;
8. any throw aborts the transaction, so a failed rule consumes no seq;
9. after `oncomplete`, notify and broadcast.

`applyOp` is the **only** code that turns an op into mirror rows. Restore re-hydration (§6.2) uses it too, and the golden parity test checks it. A payload is at most 128 KB; a builder over that splits items into follow-up ops of the same kind.

### 2.4 Rules engine (`src/lib/register/rules/`)

The SQL is the specification and the SQL tests are the oracle. Sources are the **030 bodies**, not revision 1's pre-030 citations.

| File | Port of |
|---|---|
| `money.ts` | Integer minor units. `toMinor(x)` parses the shortest decimal string (`String(x)`, what JSON sends PostgREST) and rounds half away from zero, like `round(x::numeric, 2)`. `parseMoneyInput`, `fromMinor`, `divRoundHalfAway` (BigInt). |
| `tender.ts` | `tenderKey(m) = (m ?? '').replace(/^ +\| +$/g, '').toLowerCase() \|\| 'cash'`, the twin of SQL `tender_key()` (§4.2). Whitelist `cash|wallet|instapay|card` for **new money only**. |
| `pricing.ts` | `price_cart` (030:92-185): exact catalogue check against local `inventory.sale_price`, line discount ≤ line, stock check when `allow_negative_stock=false`, the net-snapping branch (030:173-178). |
| `sale.ts` | `createSale` (030:218-402, idempotency lookup first, never renumbers); `recheckout` (030:411-695: stale check against the live ledger, refund first, legacy tenders take no new money, `history.refund` on any negative delta, deltas appended); `voidSale` (030:704-777, honours `p_restock`, one refund per exact stored method); `refundSale` (028:96-169, exact-method ceiling); `collectPayment` (029:800-817); `setLabStatus` (029:748-756, 019:76-104); `updateHeader` (029:774-793 whitelist); `replaceExams` (029:758-770). |
| `zreport.ts` | `z_report` (023:112-169): cash = `lower(method)='cash'` (no trim, as SQL), tenders grouped by exact string; `close_shift` (024:121-182) without a licence gate. |
| `time.ts` | `store_time_zone` (016:170-179) and `store_day_range` via `Intl.DateTimeFormat`. |
| `perms.ts` | `resolve_can` (029:52-71: no role or loading means deny), `is_store_admin`, staff guards (029:93-182), reserved names, seat cap. |
| `license.ts`, `clock.ts` | §2.5. |
| `purchases.ts` | `receive_purchase` (029:589-672) with the **corrected** weighted cost (§4.2): `weightedCost(stockBefore, cost, qty, unit)`. |
| `reports.ts` | `report_sales_window`, `customer_balance`/`customer_debtors`, `lab_queue`, `search_text` (016:264-295, `%` and `_` escaped), all in minor units with parity vectors. |
| `invoice.ts` | §2.6. |

**Comparison rule.** The PC may be stricter than SQL, never looser. Ceilings compare exactly with no 0.01 tolerance, so every fact the PC accepts passes the server's tolerant checks. The only tolerance mirrored on purpose is the price_cart snapping branch, because it changes a stored value.

**Methods.** New money is normalised with `tenderKey` before commit. Refund, void and restock rows keep the **exact stored method** of the ledger rows they reverse (030:757-767 groups by `sp.method`; 028:143-151 matches exactly). Writers store methods verbatim, so PC and cloud rows are identical.

**Receipt.** The register prints the stored local header and recomputes nothing. In the cloud build, `receiptTotals` (pricing.ts) returns `net = round2(itemsGross - discount)` in the snapping branch (fixed in PR #3), so `receiptTotals(items, computeTotals(…))` equals the price_cart header for every parity vector, including net = items + 0.01 (M6 fully closed).

**Not ported:** `sale_event_time` (no replay on the PC; and ingest must not call it, §3.7). The inventory delete in `syncExamReferences` (metadata.ts:226-252; the server silently drops it, 029:213-216); auto-created zero-price frames stay and the inventory list can hide them.

### 2.5 Clock and licence on the PC

- `eventNow() = Date.now() + meta.clock.offsetMs`. There is no `max()` with a high-water mark; every op `t`, store day and Z window uses it (H5).
- `meta.clock = {offsetMs, high, serverNow, serverSeenAt, closesSinceContact}`. `high = max(high, eventNow())` at each commit is used only to show a "PC clock moved back N minutes" banner. Selling is not blocked.
- Each ingest or ping response carries `server_now`. When `|drift| > 5 min` the sync panel shows the Windows fix steps, and an **admin** may press "Use internet time" while the server time is under 60 s old; it sets `offsetMs` and resets `high`. A later contact with `|Date.now() - serverNow| < 2 min` clears the offset and resets `high` automatically. While `offsetMs ≠ 0` a boot banner shows "internet-time correction active (+N min)".
- Offline, the owner (PIN) may "accept the PC clock": `high = eventNow()`, and a `clock.reset {from, to}` op is emitted and flagged on the phone.
- **Licence** (port of 026:82-103 plus v1 `state.ts:67-85` ranking): states `pending`, `active`, `grace` (read-only, 026:54-63), `expired`, `revoked`→expired, and `contact_due` after 45 days **or** 45 shift closes without server contact (vendor decision, §9). Evaluated at `licenceNow = max(eventNow(), serverNow)`, so a once-fast clock cannot expire the licence and a clock rolled back after the last contact cannot move it earlier. When expiry is caused only by `eventNow() > serverNow + 1 day`, the block screen says the PC clock reads a wrong date.
- Business kinds commit only in `active`; the check is step 3 of `commit()` (§2.3), not scattered over the UI. Every other state keeps reads, reprints, reports, backup export and the log kinds (sign-in, lockout, PIN changes, clock reset, command-applied deactivation), because the data exists only here. `contact_due` is a deliberate stop (§1.6), lifted by any successful ping or ingest.
- `meta.license` holds `{state, plan, starts_at, expires_at, revoked, max_staff, features, server_now}` from the piggyback (§3.2). The cloud build's `LicenseState` (licensing.ts:34) gains `pending`.

### 2.6 Invoice numbers and drafts

- **Allocation at cart entry** (H4). `backend.sales.reserveInvoice(userId)` runs one strict transaction over `meta` and `drafts`: read `invoiceNext`, write `invoiceNext + 1`, write `drafts[userId].invoiceNo = pad6(n)` (grows past 999999 without truncation, as 012:163-165). IndexedDB serialises overlapping readwrite transactions, so two windows never draw one number. Gaps from abandoned drafts are accepted.
- **Collision.** The sale commit checks the local unique index. If the number is already used (same cashier, two windows), it allocates the next number in the same transaction, renames the draft-only image paths and header paths (they are local only, never uploaded) and tells the cashier "Order number changed to X". Re-entering the cart also checks the local index.
- **Seeding** at setup: `greatest(invoice_counter.next_val, max numeric invoice_no + 1)` from the export. Backup import and restore never lower it; a restore adds 1000 offline and is raised to at least the cloud max + 1 at re-claim, with colliding unsent sales renumbered (§6.2).
- **Drafts** (`drafts`, keyPath `userId`, with `draftVersion`, `invoiceNo`, `idempotencyKey`, `saleId?`, `state`, `photoPaths`, `updatedAt`). Writes are debounced 300 ms with `durability: 'relaxed'`. `sale.create` deletes `drafts[userId]` in the same transaction when the idempotency key matches; `sale.recheckout` does so when `saleId` matches. The commit broadcasts `{sale.create, idempotencyKey}`; another window holding that key switches to the receipt and refuses a second Finish. A version-mismatched draft is shown read-only in "Unfinished orders" and not hydrated. Sign-out keeps drafts; drafts older than 30 days are pruned with their draft-only blobs. The cloud build keeps `posDraft.ts` in sessionStorage.

### 2.7 Identity on the PC

- **Sessions are per window and in memory only** (comparison finding: v1 `auth.tsx:69-79` propagated sign-ins to every window). No localStorage, no sessionStorage, no `storage` listener. A reload or new window opens the lock screen. BroadcastChannel only **ends** sessions (deactivation, PIN reset). Every op carries `a` (actor) and `sid`.
- **Identity by id.** The lock screen lists active users with a role in the store (029:74-79 rule) from the mirror; the user taps a name and enters a PIN. There is no username-to-email mapping and no online check (v1 `belongsTo`, `verifyOnline`, `pullStaffMember` dropped).
- **Verifier:** PBKDF2-SHA256, 600,000 iterations (stored per record, upgraded on next sign-in), 16-byte salt, constant-time compare. This reworks `v1:localAuth.ts:81-140`: the derive/compare helpers are reused, but v1 uses a fixed `ITERATIONS = 150_000` (`v1:localAuth.ts:21`) and its `setOfflinePassword` is rewritten.
- **PIN policy:** digits; ≥ 4 for cashiers, ≥ 6 for admin/owner roles; blocklist of runs and repeats; 5 failures lock the user for 60 s, doubling to 30 min, persisted and emitted as `auth.lockout`.
- **Who sets a PIN:** self with the current PIN; a `staff.edit` holder for non-admins; the owner for admins; the owner's own PIN only after an online re-auth (`signInWithPassword` in a non-persisting client, then `am_store_owner()`). At setup the owner chooses a **new** PC PIN; it is never derived from his cloud password (comparison: v1 `sync.ts:925`). Every change emits `credential.set {user_id, by, kind}` with no secret.
- **Session ops.** `session.start {sid, user_id}` and `session.end {sid, reason: signout|idle|switch|deactivated|reload}`. At boot, and when the sync worker takes the Web Lock, the PC emits `session.end reason:'reload'` for every open sid that no live window claims within 500 ms. Idle lock after `idle_lock_minutes` (setting, default 5); the POS draft survives it.
- **Staff on the PC.** New cashiers get a PC uuid, `password_hash = 'register-local'` and a PIN. Usernames match `^[^@\s]{2,32}$` and are not `superadmin` or `register` (applied to new `staff.create` only; converted rows keep their names). `perms.ts` also refuses `staff.create` at commit when `lower(btrim(username))` equals that of **any** mirror `users` row of the store, active or not, cloud login or register-local, so the server's per-store index (§4.3) can never turn an entity create, which cannot be skipped, into an INT hold (`'Ahmed '` vs `'ahmed'` is refused). Seats count **active** users. `perms.ts` refuses ops on protected targets (owner, cloud logins, platform admins) using the snapshot's `protected` flag.
- **Remote deactivation** (comparison finding: v2 lost remote revocation). The owner's phone issues `owner_deactivate_staff(p_user)` (§4.3), which only queues a command. Ingest and ping responses carry unapplied commands; the PC commits `staff.set_access {user_id, active:false, via_command}` with `actor = owner_uid` and `sid = null`, ends that user's sessions in every window, and records the command id. The PC pings at app start, at each staff sign-in and every 30 min while open and online if nothing was pushed in that time.
- **Hardening (documented):** a dedicated Chrome/Edge profile, installed PWA, `DeveloperToolsAvailability = 2`.

### 2.8 Phone view

- When `stores.register_only` is true, `my_permissions()` returns `{is_admin:false, read_only:true, is_owner, active, assigned, codes: only '.view' codes}`. Every `perms.isAdmin || perms.can(x)` gate (VoidSaleButton.tsx:30, SalePayments.tsx:67, HistoryPage.tsx:241,277, ExamSection.tsx:353, OpticalSettings.tsx:215, SettingsPage.tsx:20, NotesPage.tsx:221, SuppliersPage.tsx:402-403, StaffPage.tsx:57,204,209) then evaluates false with no call-site change. `useIsAdmin` derives from perms (done in PR #3). `readEffectiveAccess` treats missing fields as false.
- AppLayout shows "Read-only: the shop PC is the system of record" and hides POS and `/m` upload.
- Phone actions left: Revoke register and Deactivate staff (owner only), plus:
  - freshness banner from `register_status()`: last ingest, acked seq, pending count and oldest age reported by the PC, held op, flag/skip/park totals, alert;
  - Flags page from `register_flags(p_limit)`: kind, actor, time, violation codes, short summary (no full payloads);
  - a red alert banner on `alert` (seq conflict, refused ops) with the Revoke button.
- Report reads on the phone are paged in Phase 5 (`useSalesSummary`, `useCustomers`).

### 2.9 Photos on the PC

- Compressed at capture: today `downscaleImage` (`lib/storage.ts:26-42`) caps every photo at a 1600 px edge and JPEG quality 0.82; Phase 4 changes this to rx 1280 px q 0.65 and frame 1024 px q 0.7, so the pilot measures real sizes. An order can carry two photos, the prescription and the frame (ExamSection.tsx:296-298). Register file names end in 16 random base32 characters instead of a millisecond stamp, because the `prescriptions` bucket is public (`storage.ts:20-23`).
- Lifecycle: capture → `draft` (local only) → the commit that references it sets `pending` and `ref_seq` → upload after that op is acked, `upsert:false`, 409 = success → `uploaded`. A replaced `pending` photo's blob is kept until the replacing op is acked, then dropped without upload.
- Retention (M7): a 320 px thumbnail is kept forever; the full blob is kept while not uploaded and for 30 days after upload (owner-tunable), then pruned; never before upload. Above 80 % of `storage.estimate()`, the oldest uploaded fulls go first. A pruned photo opened online is fetched once and cached 7 days (LRU, 200 MB).
- Void keeps photos (M5); the register has no storage DELETE. QR / "Attach from mobile" is hidden in the register build (ExamSection.tsx:305-321, HistoryPage.tsx:176,218-222) and `findOrderImages` is not called. Orphans from uploaded-then-replaced photos are **kept** for `register_only` stores: the RESTRICTIVE storage policy (§4.3) refuses DELETE there for everyone, platform admins included, and the platform orphan scan skips those stores. The scan itself is fixed for all tenants in Phase 0b (§4.1).

---

## 3. Replication protocol

### 3.1 Envelope

`{s, i, k, v, a, sid, t, e, p}`, short keys, nulls omitted.
- `s`: bigint seq, the position in the **store's** log; starts at 1, gapless, continues across epochs and devices (`last_seq` is kept on every claim).
- `i`: op_id, uuid v4 minted at commit; `register_ops` has `unique (store_id, op_id)`.
- `k`: kind; `v`: per-kind format version (`OP_FORMAT[k]`); `a`: actor `users.id`; `sid`: session id (null only for `auth.lockout` and command-applied `staff.set_access`).
- `t`: `eventNow()` as ISO with milliseconds; `e`: epoch at commit (audit only).
- `p`: payload with every derived row verbatim.

The server keeps a supported range `[min_v, max_v]` per kind. `v > max_v` stops the batch with `server_upgrade_required` (not a hold); `v < min_v` is a MAL hold. `min_v` is raised only after every register's `last_seq` has passed the last op of the old format.

### 3.2 Request and response

`register_ingest(p_epoch int, p_protocol int, p_pending int, p_oldest_pending_at timestamptz, p_ops jsonb) returns jsonb`. The register is identified by `auth.uid()` only; revision 1's `p_register` is dropped. Caps: 200 ops and 256 KB; an oversize request returns `{retry:true, reason:'batch_too_large'}` and does not hold.

Response: `{current, reason, epoch, acked_seq, more, retry, server_now, min_protocol, catalog, held:{s, code, msg}|null, conflict:{s}|null, results:[{s, st, v}] (non-ok only), dup:n, license:{state, plan, starts_at, expires_at, max_staff, features, is_revoked}, commands:[…], store_day:{from, to}, flags_total, skipped_total, parked_total}`.
- `license` is built by one internal `_license_state(p_store)` that `my_license_state()` (026:82-101) is refactored to call, so the two can never drift.
- `catalog = md5(array_to_string(supported_permissions(), ','))`; a mismatch with the build shows "update the register".
- `store_day` comes from a new internal `_store_day_range(p_store, p_day)` (034, revoked from clients) that resolves the zone with the existing `store_time_zone_for(p_store)` (025:64-73). The public `store_day_range` cannot be used: it resolves the zone through `store_time_zone()` → `auth_store_id()` (016:170-192), which is NULL for the register principal, so it would answer the UTC day and every op would be flagged. If `store_day` differs from the PC's `time.ts` result, the PC shows a banner and the next op carries flag `tz_mismatch` (browser vs Postgres tzdata skew for Africa/Cairo DST).

`register_ping(p_epoch, p_pending, p_oldest_pending_at)` returns the same envelope with no ops and stamps `last_contact_at`.

### 3.3 How the server processes a batch

0. `v_started := clock_timestamp()`.
1. `select … from store_registers where register_uid = auth.uid() for update`. No row (a takeover or re-claim moved the store to a new uid) → `{current:false, reason:'replaced'}`. `revoked_at` set → `{current:false, reason:'revoked'}`. `quarantined_at` set → `{current:false, reason:'quarantined', conflict:{s: conflict_seq}}`.
2. Epoch differs → `{current:false, reason:'replaced', epoch}`. `p_protocol < min_protocol` → `{upgrade_required:true}`. The batch is **never** refused for the licence.
3. Batch prologue, outside any savepoint: `set_config('lensy.ingest','1',true)`, `set_config('lensy.store', store, true)`.
4. For each op in order:
   a. `s <= last_seq`: same `op_id` in `register_ops (store_id, s)` → `dup`. Different → **seq conflict**: set `quarantined_at`, `alert='seq_conflict'`, `conflict_seq`; return `conflict`; apply nothing further (§5, §6.3).
   b. `s > last_seq + 1`: stop; return `acked_seq` (gap).
   c. `i` already exists in this store's `register_ops` at another seq: insert a `dup_import` row (op_id null, `result.dup_of`), advance `last_seq`, continue.
   d. Otherwise, inside `BEGIN … EXCEPTION WHEN others`:
      - set `lensy.actor`, `lensy.event_at` and `lensy.seq` (the last keys the undo log, §4.4);
      - shape check (`malformed: <field>`); version range;
      - `_register_guard(k, a, sid, p)` → may return a refusal code (§3.4);
      - `v_flags := _register_flags(k, a, store, t, p)`, evaluated on the state **before** the op;
      - `v_flags := v_flags || _ingest_<k>(store, a, t, p)` (the writer's own post-write findings);
      - insert `register_ops` (status `ok`, `flagged`, `refused` or `skipped`; violations; detail);
      - `last_seq = s`, `max_t` update (§3.5); clear `held_*` if this was the held seq.
   e. On exception: `get stacked diagnostics` (sqlstate, constraint, message); classify (§3.4). A hold writes `held_seq`, `held_code`, `held_error`, `held_at`, `held_op` **after** the block, then stops. 40001/40P01 stop with `retry:true` and no hold.
   f. Before each op after the first: stop with `more:true` when `clock_timestamp() - v_started` ≥ the budget. Budget = `least(coalesce(nullif(current_setting('lensy.ingest_budget_ms', true), '')::int, 3000), 3000)`; tests may lower it, nothing can raise it. At least one op is always attempted.
5. Stamp `last_ingest_at`, `last_contact_at`, `pending_reported`, `oldest_pending_at`; clear `lensy.ingest` and `lensy.store`; return.

Flags live in a plpgsql local and the writers' `text[]` return values, never in a GUC (M8): locals survive the savepoint rollback; `set_config(…, true)` values set inside the block are reverted with a held op. A 57014 (statement timeout) or 53xxx cannot be caught; the whole request rolls back (nothing commits) and the PC halves its batch.

### 3.4 Outcomes

| Outcome | When | Effect |
|---|---|---|
| `ok` / `flagged` | The op is representable; any policy check failed → flagged | Applied; `last_seq` advances |
| `dup` | Same seq and op_id already applied | Nothing; counted |
| `refused` | Forger-only conditions the honest PC never emits: `foreign_actor` (actor not a `users` row of this store), `foreign_id` (a payload id exists in another store), `protected_target` (op changes the owner, a cloud login or a platform admin), `reserved_name`, `reserved_role` (lower(btrim(name)) in admin/owner/superadmin, or grants on those roles), `bad_command`, `no_session_sid`, `money_skip_forbidden` | Not applied; `last_seq` advances; `alert` set; red on the phone |
| `skipped` | `noop` from an admin Skip (§3.8) | Recorded with `skipped:<kind>` |
| **hold** `MAL` | Shape, unknown kind, `v < min_v` | Rolled back; queue stops |
| **hold** `INT` | SQLSTATE class 23 or 22 (CHECK, FK, unique, NOT NULL, invalid value) | Rolled back; queue stops |
| **hold** `STATE` | Writer-raised divergence: target sale missing (any `sale.*` kind and `payment.collect`) or voided where a live one is needed (`sale.recheckout`, `sale.refund`, `sale.void`, `payment.collect`), purchase missing or line already received on `purchase.receive`, delete of a referenced supplier | Rolled back; queue stops |
| **hold** `FAULT` | Any other error (server bug) | Rolled back; queue stops |
| transient | 40001, 40P01 inside; 57014, 53xxx fail the whole request | Retry with backoff |

Classification uses SQLSTATE and the `malformed:`/`state:` prefixes the **new** writers raise; existing raise texts in the online RPCs are untouched, so no existing gate changes. A missing target follows one rule per kind, stated in the §3.6 table ("Missing target" paragraph): a STATE hold on sale and money kinds, a flag elsewhere, never a silent ok. An id present in another store is always `foreign_id`. Unknown payload fields are flagged `unknown_fields`; the payload is stored whole.

### 3.5 Flag codes

Evaluated by `_register_flags` against pre-op state, or returned by writers:
- **actor and permission:** `actor_inactive` (not active or no role in store), `perm:<code>` via `_resolve_can_for` and the `_register_kind_perms` table, `no_session` (actor is not the user of an open sid: started at an earlier seq and not ended), `assign_admin`, `self_change`, `max_staff`, `note_authorship`, `photo_replace_not_admin`, `after_remote_deactivation`, `reactivated_after_remote_deactivation`;
- **licence and plan:** `licence` (revoked, or `t` outside `[starts_at, expires_at)`; OE3), `feature:<code>` (kind needs a plan feature the licence lacks). `license_feature(p_name)` has no store parameter and reads `auth_store_id()`, so under the register JWT it would always answer allowed (027:54-65). 034 adds the internal `_license_feature_for(p_store uuid, p_name text)` (revoked from clients), refactors `license_feature` to `select _license_feature_for(auth_store_id(), p_name)` (same answers), and `_register_flags` calls the internal one with the ingest store;
- **time:** `clock_ahead` (`t > now() + 10 min`; `max_t` is then not advanced past `now() + 10 min`), `clock_back` (`t < max_t - 5 min`), `in_closed_shift` (`MONEY_KINDS`, §3.6, with `t` < the latest closed `to_at`), `tz_mismatch`;
- **money:** `price_changed`, `negative_stock`, `unknown_tender`, `overpaid`, `refund_first`, `refund_exceeds_tender`, `header_rule`, `kind_rule`, `divergence`, `void_derivation_differs`, `void_not_zero`, `z_mismatch`, `cost_mismatch`, `edit_voided`;
- **other:** `delete_missing`, `target_missing`, `unknown_fields`, `skipped:<kind>`, `clock_reset`, `invoice_renumbered` (a `sale.create` whose payload carries `renumbered_from`, §6.2).

`register_ops.detail jsonb` holds the figures behind a flag (for example both sets of Z figures).

### 3.6 Per-op table

Writer contract, for the 23 writers named in §4.4 (one per row of the table below, with the log-only kinds and `noop` sharing `_ingest_log`): signature `(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb) returns text[]`; SECURITY DEFINER, `search_path=public`, revoked from public, anon and authenticated; `store_id = p_store` on every insert (never from the payload); every actor column = `p_actor`; every time column = `p_at`; every id = the PC's id; every row looked up by `(id, store_id = p_store)`; references checked with `_ingest_ref(tbl, id, store)`. A writer never calls a public RPC, `price_cart`, `sale_event_time`, `next_invoice_no`, `auth_store_id()`, `license_write_ok()` or `require_perm()`. Inside one op, positive ledger rows are inserted before negative ones (the `amount_paid >= 0` CHECK is evaluated per row, 011/013:231-247).

**Money-column flag.** `sales_money_guard` (013:208-227) raises 42501 on any UPDATE that changes `total_amount`, `discount`, `net_amount` or `amount_paid` unless `lensy.money_write = '1'`, and `sync_sale_amount_paid` resets that flag to `''` after every ledger row it syncs (013:231-247). A writer that updates those columns therefore calls `set_config('lensy.money_write','1',true)` immediately before that UPDATE, issues the header UPDATE **before** any ledger insert, and calls `set_config('lensy.money_write','',true)` after its last ledger insert (the order 030 uses: flag 030:622, header 030:623, ledger 030:681, clear 030:689). Only `_ingest_sale_recheckout` needs it: `sale.create` inserts the header (the guard is BEFORE UPDATE only), `sale.void` changes only `voided_*` (030:769), and `amount_paid` moves through the ledger trigger. Without it every re-checkout raises 42501, which classifies as FAULT and holds the queue.

**Money kinds.** `MONEY_KINDS` = `sale.create`, `sale.recheckout`, `sale.refund`, `sale.void`, `payment.collect`, `shift.close`, `purchase.receive`, `purchase.payment.add`, `purchase.payment.delete`, `stock.adjust`. It is one constant in `src/lib/register/ops.ts` and the `money boolean` column of `_register_kind_perms`; the generated parity vectors (§8 Phase 2) carry the list so vitest and pgTAP compare the two. It drives the Skip refusal (§3.8, `money_skip_forbidden`) and `in_closed_shift`. `product.upsert` with `initial` stock is not in it, but as an entity create it can never be skipped anyway.

**Missing target** (one rule per kind; replaces the earlier blanket "absent from every store is a flag" sentence in §3.4):
- `sale.*` and `payment.collect`: the sale missing from this store → STATE hold (money and receipts must never be dropped silently). A voided sale is a STATE hold for `sale.recheckout`, `sale.refund`, `sale.void` and `payment.collect`, and an `edit_voided` flag (applied) for `sale.header`, `sale.exams` and `sale.lab_status`.
- `purchase.receive`: purchase or line missing → STATE hold.
- Deletes of customers, suppliers, purchases, purchase payments, notes and metadata: target missing → `delete_missing` flag (nothing to delete; recorded).
- Non-money updates (`staff.set_access`, `staff.update_profile`, `role.set_permission`, `user.set_permission`, `metadata.reorder`): target missing → `target_missing` flag. Upsert kinds create the row, so they have no missing case. `stock.adjust` on a missing product fails its FK → INT hold.

| Kind | Payload (beyond `a`, `t`) | Writer enforces | Flags |
|---|---|---|---|
| `customer.upsert` / `.delete` | full row / id | tenancy; FK on delete (the PC refuses first, customers.ts:216-241) | `perm:customers.*` |
| `product.upsert` | row without `stock_qty`, optional `initial{movement_id, qty>0}` | `on conflict (id) do update … where store_id = p_store`; per-store sku (031) | `perm:inventory.create\|edit` |
| `stock.adjust` | `{movement_id, product_id, qty≠0, type, ref_no, note}` | product in store | `perm:inventory.edit`, `negative_stock` |
| `metadata.upsert\|delete\|reorder` | table ∈ lens_types, frame_colors, frame_types | other table → MAL; per-store names (031) | `perm:inventory.edit` |
| `supplier.upsert\|delete` | row / id | delete with purchases → STATE (PC refuses first) | `perm:suppliers.*` |
| `purchase.upsert\|delete` | header + unreceived items / id | changing a received item → STATE | `perm:suppliers.*` |
| `purchase.payment.add\|delete` | row / id | missing on delete → `delete_missing` flag | `perm:suppliers.*` |
| `purchase.receive` | `{purchase_id, lines[{item_id, movement_id}], cost_after{product_id: cost}}` | items belong to purchase; `received_at` null; qty > 0 | `perm:suppliers.edit`, `cost_mismatch` (PC cost stored) |
| `sale.create` | header (id, invoice_no, idempotency_key, customer_id, kind, total, discount, net, payment_method, delivery_date, doctor_name, lab_status, photo paths), `items[{id, product_id, name, qty, unit_price, total_price, discount, discount_reason, movement_id}]`, `exams[]`, `payments[{id, method, amount>0}]` | references; CHECKs (012:184-190, 013:110-111); per-store invoice unique; `invoice_counter` bumped with `greatest` on `(store_id, prefix)` for numeric numbers | `perm:pos.create`, `price_changed`, `negative_stock`, `unknown_tender`, `overpaid`, `header_rule`, `kind_rule`, `licence`, time flags |
| `sale.recheckout` | `sale_id`, header, full items and exams with ids, `movements[{id, product_id, qty}]`, `payments[{id, method, amount ±}]`, `expect{paid, tenders}` | sale live (STATE); `amount_paid >= 0`; `lensy.money_write` around the header UPDATE (above) | `perm:pos.edit\|history.edit`, `perm:lab.edit`, `perm:history.refund`, `photo_replace_not_admin`, `refund_first`, `unknown_tender`, `negative_stock`, `price_changed`, `header_rule`, `overpaid`, `divergence` |
| `sale.header` | whitelisted fields (029:780-783) | sale in store (missing → STATE) | `perm:history.edit`, `photo_replace_not_admin`, `edit_voided` |
| `sale.exams` | `sale_id, exams[]` | sale in store (missing → STATE) | `perm:history.edit`, `edit_voided` |
| `sale.lab_status` | `sale_id, status` | vocabulary (MAL); lab_status not null (STATE) | `perm:lab.edit`, `edit_voided`, `feature:lab` |
| `payment.collect` | `sale_id, lines[{id, method, amount>0}], expect` | sale live | `perm:history.edit`, `unknown_tender`, `overpaid`, `divergence` |
| `sale.refund` | `sale_id, row{id, method, amount>0}, note, expect` (renames revision 1's `payment_id`, M8) | sale live | `perm:history.refund`, `refund_exceeds_tender`, `divergence` |
| `sale.void` | `sale_id, reason, refunds[{id, method, amount}], restock[{id, product_id, qty}], expect` | sale in store, not voided | `perm:history.void`, `void_derivation_differs`, `void_not_zero`, `divergence` |
| `shift.close` | id, from_at, to_at, counted_cash, every PC figure, note | window CHECK and unique (023:84); `variance = counted - expected` | `perm:closing.edit`, `z_mismatch` (server `_z_report` recompute; both figure sets in `detail`) |
| `note.upsert\|delete` | row / id; `created_by = actor` | — | `perm:notes.*`, `note_authorship` (029:825-832 rules) |
| `setting.set`, `store.update` | key/value; allow_negative_stock, time_zone | `on conflict (store_id, key)` | `perm:settings.edit` |
| `staff.create` | `{id, username, full_name, role_id, is_active}` | id not in auth.users, platform_admins or register_uid (`refused: protected_target`); reserved names refused; per-store username unique (INT) | `perm:staff.create`, `assign_admin`, `max_staff` |
| `staff.set_access`, `staff.update_profile` | user_id, role_id, active, full_name, optional `via_command` | protected targets refused; `via_command` must match an unapplied command for that user with `active=false`, else `bad_command` | `perm:staff.edit\|delete`, `self_change`, `assign_admin`, `reactivated_after_remote_deactivation` |
| `role.create`, `role.set_permission`, `user.set_permission` | as the RPCs | reserved roles and admin/owner grants refused; `user.set_permission` on a cloud login refused | `perm:staff.edit`, `self_change` |
| `session.start`, `session.end`, `credential.set`, `auth.lockout`, `clock.reset` | as §2.5, §2.7 | log only (stored in `register_ops`, no table write) | `clock_reset` on `clock.reset` |
| `noop` | `{skipped: <original envelope>, reason, by}` | `skipped.k` in `MONEY_KINDS` → `refused: money_skip_forbidden` | `skipped:<k>` |

There is no inventory-delete kind (M5). Images are not ops (§2.9).

### 3.7 Money semantics at ingest (030 guards on the register path)

| 030 guard | On the PC | At ingest |
|---|---|---|
| Refund first (030:568-579) | Refusal | Flag `refund_first` |
| `expected_amount_paid` / `expected_tenders` (030:474-503) | Checked against the live ledger inside the commit | `expect` compared with the server ledger grouped by `tender_key` → `divergence` (the canary) |
| Legacy tender takes no new money (030:602-609); unknown tenders refused (030:260-266) | Refusal | `unknown_tender` |
| `history.refund` when a tender goes down (030:614-616) | Refusal without the permission | `perm:history.refund` |
| New-units stock guard (030:536-554) | Refusal | `negative_stock` |
| Catalogue price check (030:141-152) | Exact match required | `price_changed` (no catalogue lock) |
| Header shape (030:173-182) | Computed exactly | `header_rule`; the 012/013 CHECKs still hold |
| Void per tender (030:755-767) | Rows derived per exact method | Stored verbatim; compared → `void_derivation_differs` |
| Idempotency first (030:243-251) | Local index lookup before gates | Replaced by seq/op_id; `(store_id, idempotency_key)` unique (012:170-172) still enforced |
| Per-store invoice (030:82-84) | Local unique index | Unique violation → INT hold |
| `sale_event_time` (030:196-205) | Not applicable | **Not applied.** It would replace a `t` older than 2 days, or after a close, with the ingest time. `t` is stored verbatim and flagged (`clock_*`, `in_closed_shift`); every row of an op gets `t` |

The online re-checkout and void still stamp `now()` (030:665, 686, 748, 761); that matters only for stores not on a register.

### 3.8 Holds, Skip and the vendor park

- **Held state on the PC:** red badge; selling continues; automatic retry only 24 h after `heldAt`, after a build change, on "Retry now" (admin), or when a response's `acked_seq` has moved past the held head.
- **Admin Skip** (PC, sync panel, one readwrite transaction): allowed only when the op is the outbox head and equals the held seq; its kind is not in `MONEY_KINDS` (§3.6; so `purchase.payment.delete` is never skippable although it is a delete); it creates nothing referenceable (leaf kinds: `setting.set`, `note.*`, the remaining `*.delete` kinds, role/permission assignments, metadata names, which sales reference by text); and no later outbox op contains any id it creates (`JSON.stringify(later.p).includes(id) || later.a === id`). The head is rewritten **in place** as `noop` with the same `s` and `i`; the original goes to the `skipped` store. An entity-create hold (staff, customer, product, supplier, purchase) is never PC-skippable: the paths are a server fix and Retry, or the vendor park. So a skip can never orphan a later sale's FK (C3).
- **Vendor park:** `register_resolve_held(p_store, p_seq, p_reason)`, platform admin only, `for update` on `store_registers`, `p_seq = held_seq`. It inserts `register_ops(status 'parked', payload = held_op)`, advances `last_seq`, clears `held_*`, increments `parked_total` and writes `audit_log`. A later op that depends on a parked entity holds in turn and is parked or repaired. There is no "lenient" force mode: with every money rule a flag, the remaining holds are constraints that cannot be forced.
- Retry after a server fix remains the normal path.

### 3.9 PC drain (`src/lib/register/sync.ts`)

- **One worker.** Every window calls `navigator.locks.request('lensy-register-sync', …)` with a holder that never resolves; the first window keeps the role, a queued window takes over when it closes. Without `navigator.locks` sync refuses to start (v1 ran unlocked, `v1:db.ts:199-200`). Other windows only commit; "Sync now" from them is a BroadcastChannel command.
- **Register session (M3).** Only the holder constructs `registerClient` with `{autoRefreshToken:false, persistSession:true, detectSessionInUrl:false, storageKey:'lensy-register-session', storage: IndexedDB adapter}`. Before each request, refresh once if the token expires within 60 s; on an invalid or reused refresh token, `signInWithPassword` with the stored register credential; on `invalid_credentials`, state `reclaim_required`; on `user_banned` (only a takeover or re-claim bans a register uid, §4.5), state `stranded`. Setup's admin sign-in uses a throwaway non-persisting client and signs out with `scope:'local'`.
- **States:** `idle`, `sending`, `backoff{n, nextAttemptAt}`, `held{s, code, msg, heldAt}`, `diverged{s}`, `stranded`, `reclaim_required`, `needs_update`.
- **`current:false` by reason** (§3.3): `replaced` → `stranded` (the only sync state that refuses business commits; the other refusal is the licence, §2.3); `quarantined` → `diverged{conflict.s}`; `revoked` → `reclaim_required`. In `diverged` and `reclaim_required` the PC keeps selling and stops sending until the owner re-claims (§6.3), so an owner Revoke after a token theft never stops the till.
- **Triggers:** no `setInterval`. After each commit one timeout fires when the oldest unsent op is 90 s old, immediately at ≥ 50 unsent ops, on `shift.close`, on "Sync now", at app start and on `online`. Pings per §2.7 and on licence events (daily minimum; `pending` licence at `starts_at`; "Check licence" button). Offline (`navigator.onLine` false) attempts are skipped without counting.
- **Batch:** the contiguous outbox head, up to `batchOps` (start 100, 1-100) and 64 KB. `more:true` → send again immediately with `max(1, ops acked)`. 57014, a 15 s client timeout, 413 or `batch_too_large` → halve. Three successes in a row → double.
- **Backoff** on transient errors (network, 0, 408, 429 with Retry-After, 5xx, 40001, `retry:true`, missing RPC PGRST202/42883 as "server not upgraded", never as success): 30 s, 1 m, 2 m, 5 m, 10 m, cap 30 m, ±20 % jitter; reset after any 2xx (comparison: v1 had no backoff, `v1:sync.ts:743-746`).
- **Ack:** `acked_seq` always wins; delete `outbox` keys `≤ acked_seq` in one transaction. Outbox head > `acked_seq + 1` → `diverged`.
- **Images:** after the op drain, upload `pending` images with `ref_seq ≤ acked_seq`; per-image backoff; set-aside after repeated refusal; a photo error never blocks ops.
- **Byte counter:** `meta.bytes[YYYY-MM] += body + response + 1.5 KB` per request, photos counted separately; amber above 200 MB in total.
- **Badge:** "N unsynced · oldest 3 h"; grey caught up, amber ≥ 24 h, red ≥ 72 h or held/diverged/stranded. `skipped_total` is shown separately; "caught up" means outbox empty and nothing held.

### 3.10 Bandwidth

Per month at 30 sales a day, 26 days: ops ≈ 2.1 MB; push overhead 25-40 pushes/day × 7-10 KB ≈ 5-10 MB; lazy token refresh ≈ 1.3 MB; pings (start, sign-ins, 30-min idle) ≤ 4.5 MB; photos once, after ack, ≈ 90 KB × 1-2 photos per order × 780 ≈ 70-140 MB (an order can carry a prescription and a frame photo, ExamSection.tsx:296-298; the real ratio is measured in the pilot); app updates ≈ 1 MB. **Total ≈ 85-160 MB**, of which non-photo traffic is ≈ 14-19 MB. The pilot exit criterion (§8) therefore bounds non-photo traffic and reports the measured photo bytes per order instead of one fixed total.

Rules: results only for non-ok ops; short keys; no timers except the ping timeout; no cloud reads after setup except recovery exports; photos insert-only, never listed or downloaded by the PC (v1's `adoptPhoneImages` storage listing alone was estimated at 7-30 MB a day, main-map.md:2002); the phone's paged reports (Phase 5) keep shop Wi-Fi use low.

Initial download, once: about 6-12 MB gzipped for 5k customers, 2k products and 20k sales, with a size estimate from `register_export_heads()` first. Photos are not downloaded.

---

## 4. Server changes, migration by migration

Every file ends with `select public.record_schema_version(N, …)` (020 gate, `scripts/check-migrations-stamp.sh`), re-records `schema.fingerprint` from CI, and ships with a `RELEASE_03N.md` runbook (schema-version precheck, apply at closing, checks in a test store) and SETUP.md steps in the same PR. `EXPECTED_SCHEMA_VERSION` (`src/lib/schemaVersion.ts:11`, now 30) is bumped per client release to the highest migration that client needs: **31** with the Phase 0b client, **33** with the read-only-aware phone client, **34** only in the register build. Existing gate files stay unedited, with two exceptions noted below (015 and 018).

**Migration numbering.** "034" is a working name. The ingest migration stays on the branch for months while 031-033 are live; any hotfix migration needed meanwhile takes the next free number on `main` as usual (the 020 stamp gate needs a contiguous sequence). When the ingest migration is applied (§8 Phase 4) it is renamed to the next free number, together with its `record_schema_version(N)` stamp, its three test files and the register build's `EXPECTED_SCHEMA_VERSION`; a branch CI step rebased on `main` runs `check-migrations-stamp.sh` so a collision fails before merge. Merging it early "dark" was rejected: every Phase 4 fix to an applied migration would need another migration.

**Data migrations and `register_only` stores.** Migrations run as `postgres`, and the guard trigger (§4.3) fires for them too, so after 033 a data fix that touches a `register_only` store either fails 42501 or, if it set the bypass, silently makes the cloud differ from the PC. Rule (also in SETUP.md and every `RELEASE_03N.md`): a migration must not modify rows of a `register_only` store; its data statements carry `where not store_is_register_only(store_id)`. A correction for such a store ships as a PC op kind or a register command, applied on the PC and replicated like any other op. A 033 assertion shows an UPDATE by `postgres` on store A without the bypass is refused.

### 4.1 `031_per_store_unique.sql` (live, Phase 0b)

- `update inventory set sku = null where btrim(sku) = ''`.
- For `inventory.sku` and the `name` of `lens_types`, `frame_types`, `frame_colors`: create the per-store unique index first, then drop the global constraint. Only the index-before-drop order is 030's idiom (030:82-84); 030 drops `sales_invoice_no_key` by name, whereas 031 looks the constraint name up in `pg_constraint` by `conrelid` and `conkey` (new code, because these constraints were created inline in 000 and their generated names are not guaranteed). Global uniqueness implies per-store, so no data fix is needed and uniqueness never lapses.
- `settings`: add `settings_store_key_key (store_id, key)` only. The global `settings_key_key` (000:280) stays until 032, so cached clients still sending `onConflict:'key'` keep working. Client `settings.ts:31` → `onConflict:'store_id,key'` (valid while both exist; `tenant_fill_store_id` fills `store_id` before arbitration, 008:240-247).
- `contact_lens_types`: no `store_id`, no RLS, unused by the client; `revoke all … from anon, authenticated` (a live cross-tenant leak).
- Identity hardening (a live leak independent of v2): `drop view if exists public.staff_id_problems; drop function if exists public.link_staff_ids();`. 015 is left unchanged; SETUP.md says "do not re-paste 015".
- **Orphan scan fix** (a live data-loss path for every tenant, moved from Phase 5): today `referencedPaths()` (`data/storageCleanup.ts:38-50`) selects every sale's photo paths in one unpaged request, so under the PostgREST row cap the platform scan can list live photos as orphans and the Delete button removes them; it has no age gate either. 031 adds `referenced_image_paths(p_store uuid, p_after text, p_limit int)` (platform admin only, keyset-paged over the store's `rx_image_path`/`frame_image_path`); `useOrphanScan` pages through it per store, and `findOrphanedImages` ignores files younger than 14 days (the storage listing's `created_at`), which protects a photo uploaded at cart entry whose sale row is not yet written. From Phase 1 (033) the scan also skips `register_only` stores (§2.9).
- Not here: `sales.invoice_no` (done in 030), roles (029:6-7), `users.username` (033).
- **Tests** `tests/031_per_store_unique_test.sql`: two stores share sku and each metadata name; same-store duplicate → 23505 in each table; two null skus coexist; old constraints absent; `on conflict (store_id, key)` upserts as authenticated; `contact_lens_types` not selectable/insertable by anon or authenticated; `link_staff_ids` and `staff_id_problems` do not exist. `tests/015_link_staff_ids_test.sql` is **replaced** by these assertions. vitest: `useSetSetting` sends `onConflict:'store_id,key'`.

### 4.2 `032_actor_core.sql` (live, ≥ 7 days after the 0b client and every shop device reloaded)

- **C1.** `resolve_can(p_code, p_user default auth.uid())` keeps its single definition and grant (014:526). New body adds: `if p_user is distinct from auth.uid() and not is_platform_admin() and user_store(p_user) is distinct from auth_store_id() then return false`. `is_store_admin` gets the same guard. Internal `_resolve_can_for(p_code, p_actor, p_store)` and `_is_store_admin_for(p_actor, p_store)`: STABLE, SECURITY DEFINER, `search_path=public`, revoked from clients; no platform branch; require `users.store_id = p_store`, active, role in store; the view-prerequisite recursion calls `_resolve_can_for`.
- `tender_key(m) = coalesce(nullif(lower(btrim(m)), ''), 'cash')`, immutable.
- **C2.** `_z_report(p_store, p_from, p_to)` with 023:112-169's body; `z_report(p_from, p_to)` becomes `select z.* from report_window(p_from, p_to) w, lateral _z_report(w.store_id, w.from_at, w.to_at) z`. Same signature and behaviour. (`report_window`'s UTC-date rounding, 016:199-208, is correct only east of UTC; Cairo is fine.)
- **M1.** Re-point `sale_payments.recorded_by` (011:52), `sales.voided_by` (013:85) and `shift_closes.closed_by` (023:62) to `public.users(id) on delete set null`: find the old FK by `conkey`, add the new one NOT VALID, then a guarded VALIDATE (012:176-200 pattern) that warns with the orphan query instead of aborting. The `recorded_by` default `auth.uid()` stays: under the register JWT a forgotten actor fails the FK loudly.
- `sale_payments.store_id`: backfill from `sales` (total, since `sale_id` is NOT NULL with cascade), then `set not null`.
- Drop `settings_key_key`.
- **Weighted-cost fix** (found in review; affects every tenant). `receive_purchase` (029:653-660) averages after `stock_qty_sync` has already added the received quantity, so 10 @ 4.00 + 10 @ 6.00 stores 4.67 instead of 5.00. Use `v_old := stock_qty - v_row.qty`; `case when v_old > 0 then round((v_old*cost + q*unit)/(v_old+q), 2) else coalesce(unit_cost, cost_price) end`. `tests/018_purchase_stock_test.sql` G-P4b (lines 199-226, which records the author changing 5 to 4.67) is **corrected** to 5.00.
- **Tests** `tests/032_actor_core_test.sql`: one `resolve_can` in `pg_proc`; cross-store `resolve_can`/`is_store_admin` false; platform admin unchanged; `_resolve_can_for` parity with `resolve_can` for every fixture user (platform admins excluded) and every code; internals not executable by anon/authenticated; `z_report` = `_z_report` on the 023 fixture; `tender_key` on the shared table (`'Cash '`, `' INSTAPAY'`, `''`, null, `'cash + instapay'`, tab, NBSP); auth-only `recorded_by` fails 23503; constraints validated; `sale_payments.store_id` NOT NULL; two stores share a setting key; weighted cost 5.00. The 014, 023, 024 and 029 gates pass unedited.

### 4.3 `033_register.sql` (live, dark: `register_only` defaults false, no register rows)

- `stores.register_only boolean not null default false`; `stores.owner_uid uuid references auth.users(id)`, backfilled only when exactly one active admin/owner-role user of the store satisfies `is_cloud_principal(u)` (`exists auth.users with id = u.id and password_hash is distinct from 'register-local'`) and is not in `platform_admins`; else null and set by the vendor with `set_store_owner(p_store, p_uid)` (platform only; when `register_only`, it also revokes the register so a fresh setup refreshes the PC's protected flags).
- Tables (RLS forced, no client grants): `store_registers` (§3.2-3.3 columns: `register_uid`, `epoch`, `claimed_*`, `revoked_at`, `quarantined_at`, `alert`, `alert_at`, `snapshot_until`, `snapshot_done_at`, `last_seq`, `max_t`, `last_ingest_at`, `last_contact_at`, `pending_reported`, `oldest_pending_at`, `held_seq`, `held_code`, `held_error jsonb`, `held_at`, `held_op jsonb`, `conflict_seq`, `skipped_total`, `parked_total`, `min_protocol`); `register_ops` (pk `(store_id, seq)`, `unique (store_id, op_id)`, kind, v, actor, sid, occurred_at, received_at, status, violations, detail, payload; partial index on `(store_id, status) where status <> 'ok'`); `register_commands` (`kind = 'staff.deactivate'`, user_id, issued_by, issued_at, applied_seq).
- `register_store_id()`: store of `auth.uid()` when not revoked or quarantined; null for everyone else.
- **Guard trigger** `zz_register_only` → `guard_register_only()`: BEFORE INSERT/UPDATE/DELETE, named to fire after `tenant_fill_store_id` and every other BEFORE trigger. Store = `coalesce(NEW.store_id, auth_store_id())` on insert, both OLD and NEW on update, OLD on delete (via `role_store`/`user_store` for role and user permissions; `id` for `stores`). If that store is `register_only`, raise 42501 `'read-only: this shop records on its register PC'` unless (`lensy.ingest='1'` and `lensy.store` = that store and `register_store_id()` = that store) or `lensy.register_admin` = that store's id. The bypass is set with `set_config(…, true)` only inside the SECURITY DEFINER functions that must write a `register_only` store outside ingest: `_register_install`, `_register_convert_staff` and `_register_mark_local` (they update that store's `users` rows after `_register_install` has set `register_only`, §4.5), `set_store_owner` (it updates `stores`), `release_register`, `end_register_mode`, and `register_revert_ops` (§4.4). The guard honours it only when `current_user` is the functions' owner, so a client session can never use it; a migration also runs as that owner, which is why the data-migration rule in §4's preamble exists. Attached to customers, inventory, stock_movements, sales, sale_items, order_examinations, sale_payments, shift_closes, invoice_counter, suppliers, purchases, purchase_items, purchase_payments, notes, settings, lens_types, frame_colors, frame_types, prescriptions, warehouses, users, roles, role_permissions, user_permissions, stores. Not attached to `note_seen`, `store_licenses`, `platform_admins`, `permissions`, `audit_log` and the register tables. Triggers fire for definer RPCs, PostgREST, platform admins and service role, so no RPC body changes (rejected alternative: redefining `license_write_ok`, which misses service role and platform-admin bypass branches).
- **Triggers on the ingest path.** Gate `v_ingest := current_setting('lensy.ingest', true) = '1' and register_store_id() is not null`. `audit_row` (014:88-111): actor = `lensy.actor`, store fallback `lensy.store`, new columns `audit_log.via_register` and `audit_log.event_at`, under that gate only. `lab_status_stamp` (019:76-104): `v_at := lensy.event_at` (read with `current_setting(…, true)`) under the gate, else `now()`. No `effective_*` function is exposed.
- `my_permissions()` adds `read_only` and `is_owner` (§2.8). `store_is_register_only(p_store)`.
- `users`: precheck that raises listing same-store `lower(btrim(username))` duplicates; then `unique (store_id, lower(btrim(username)))` and `users_cloud_username_key unique (username) where password_hash is distinct from 'register-local'`; drop `users_username_key` (000:51). The global cloud index stays on the **exact** text, as today's `users_username_key` is, so it holds for every existing row and 033 cannot abort on cross-store rows such as `'Ahmed'` in store A and `'ahmed'` in store B (which today's constraint allows). Case and space collisions between new cloud logins are already refused by Supabase Auth, because create-user trims the username and derives the login email from it (`create-user/authz.ts:88,151`) and auth emails are case-insensitive.
- Storage: a PERMISSIVE `lensy_register_storage_insert` (INSERT to authenticated, bucket `prescriptions`, `store/<register_store_id()>/orders/…`); a RESTRICTIVE policy refusing INSERT/UPDATE/DELETE when the target store is `register_only` except that register insert (for legacy root paths, the target store is the oldest store, 008:440-443). `lensy_storage_all` (008:426-459) is left **unchanged**: it is one `for all` policy with one USING clause shared by SELECT, UPDATE and DELETE (008:429-444) and one WITH CHECK (008:445-459), so adding `not register_only` to it would also hide the owner's own photos from his phone; the RESTRICTIVE policy alone blocks the writes. Register SELECT on its folder only while `snapshot_until` is in the future.
- Functions: `register_status()`, `register_flags(p_limit)` (store members; summaries only), `revoke_register(p_store)` (`auth.uid() = stores.owner_uid` or platform admin; exempt from the guard), `owner_deactivate_staff(p_user)` (owner of `user_store(p_user)`; protected targets refused), `release_register(p_store)` (owner with `is_store_admin()` or platform admin), `end_register_mode(p_store, p_force)` (refuses while `pending_reported > 0` unless forced; clears `register_only`, revokes the register, sets `invoice_counter.next_val = greatest(next_val, max numeric invoice + 1)`, and deactivates and renames **every** register-local user, active or not, to `username || '~local-' || left(id::text, 8)`, keeping their ids so history stays attributed; plain names are then free for create-user, which a rename of inactive users only would not achieve), `set_store_owner`, service-role-only `_register_install`, `_register_convert_staff`, `_register_mark_local`.
- Index `sale_payments (store_id, paid_at)`.
- **Tests** `tests/033_register_test.sql`, with store A `register_only`: refused 42501 — platform admin inserting a customer, role_permissions or updating A's store row; owner calling every write RPC (create/update/void/refund/collect, lab status, exams, close, receive, add item, staff RPCs) or a direct settings upsert; a direct customers insert with `store_id` omitted; a platform admin moving a customer from A to B; service-role users insert. Still working: store B's checkout; `note_seen` in A; a platform admin's `store_licenses` update in A. Read-only `my_permissions` for the owner (view codes, `is_admin` false, `is_owner` true); unchanged answer for B. Staff session setting `lensy.ingest/actor/event_at` without a register gets normal audit actor and lab stamp. `revoke_register` by a non-owner admin, by A's owner on B → raises; by a platform admin → ok. Storage: register insert in its folder ok, delete/update fails, insert elsewhere fails; owner delete of a legacy root object fails when A is the oldest store. Case-duplicate precheck fixture; cross-store cloud logins `'Ahmed'` (A) and `'ahmed'` (B) present before 033 → it applies; register-local `ahmed` in two stores ok; cloud-login `ahmed` reused → 23505. `end_register_mode` counter, deactivation and rename of active and inactive register-local users, then create-user's insert of a cloud `ahmed` in A succeeds. Bypass: `set_store_owner` on A succeeds; `_register_convert_staff` and `_register_mark_local` on A after `register_only = true` succeed; an UPDATE of A's customer by `postgres` without the bypass → 42501; `lensy.register_admin` set in an `authenticated` session is ignored. Storage: the owner can still SELECT objects in A's folder. Commands: owner issues; non-owner, other store's owner and register JWT refused.

### 4.4 `034_register_ingest.sql` (applied only after the Phase 4 parity test is green, ≥ 1 week before the dry run)

- `_ingest_ref`, `_register_kind_perms` (kind, permission codes, `money boolean`, writer name), `_register_guard`, `_register_flags`, `_license_state` (with `my_license_state` refactored onto it), `_license_feature_for` (with `license_feature` refactored onto it, §3.5), `_store_day_range(p_store, p_day)` (§3.2), `register_ingest`, `register_ping`, `register_resolve_held`, `register_revert_ops`.
- **The 23 writers**, one per row of the §3.6 table: `_ingest_customer`, `_ingest_product`, `_ingest_stock_adjust`, `_ingest_metadata`, `_ingest_supplier`, `_ingest_purchase`, `_ingest_purchase_payment`, `_ingest_purchase_receive`, `_ingest_sale_create`, `_ingest_sale_recheckout`, `_ingest_sale_header`, `_ingest_sale_exams`, `_ingest_sale_lab_status`, `_ingest_payment_collect`, `_ingest_sale_refund`, `_ingest_sale_void`, `_ingest_shift_close`, `_ingest_note`, `_ingest_settings` (`setting.set`, `store.update`), `_ingest_staff_create`, `_ingest_staff_update` (`staff.set_access`, `staff.update_profile`), `_ingest_rbac` (`role.create`, `role.set_permission`, `user.set_permission`), and `_ingest_log` (`session.start`, `session.end`, `credential.set`, `auth.lockout`, `clock.reset`, `noop`: no table write).
- **Undo log** (for H3 recovery, §6.3). `register_undo (store_id, seq, n bigserial, table_name, pk jsonb, action, before_row jsonb)`, RLS forced, no client grants. A generic AFTER INSERT/UPDATE/DELETE row trigger `zz_register_undo` on the guard trigger's table list writes one row per changed row, under the ingest gate only (§4.3), keyed by `lensy.seq`; rows written by trigger cascades (the `stock_qty` and `amount_paid` syncs, `invoice_counter`) are captured too. `audit_log` was not used: `audit_row` is attached to only twelve tables (014:479-483, 026:226-227) and misses customers, inventory, exams, notes, settings and metadata. `register_revert_ops(p_store, p_from_seq, p_reason)`, platform admin only, `for update` on `store_registers`, refuses unless the register is quarantined or revoked and `p_from_seq` ≤ `last_seq`; it replays the undo rows with `seq ≥ p_from_seq` in reverse `n` order (insert → delete; update → restore `before_row`; delete → re-insert `before_row`) under `lensy.register_admin` and with `lensy.money_write` set around each `sales` UPDATE, never writing the cache columns `inventory.stock_qty` and `sales.amount_paid` (the 012/013 sync triggers recompute them from the reverted ledgers); it clears `register_commands.applied_seq` in the range, moves the `register_ops` rows of the range to `register_ops_foreign` (same columns, status `reverted`), sets `last_seq = p_from_seq - 1`, recomputes `max_t`, and writes `audit_log`. Undo rows are pruned after 60 days (longer than the 45-day contact limit, §2.5); a revert reaching a pruned seq raises `undo_pruned`. Cost: about one extra row per written row on the ingest path (≈ 300 a day for this shop).
- `register_export(p_table, p_after, p_limit ≤ 1000)` and `register_export_heads()`: register JWT only, store from `register_store_id()`, only while `now() < snapshot_until` and `snapshot_done_at` is null; whitelisted tables and columns; includes private notes, `sale_payments`, `shift_closes`, `invoice_counter`, role/user permissions, store and licence rows; `users` without `password_hash` but with a computed `protected` flag. `register_snapshot_done()` closes the window.
- `register_export_ops(p_from_seq, p_limit ≤ 500)`: callable only by the store **owner's** session (never the register JWT), contiguous rows including noop, parked, dup_import and lost rows; error `retention` if pruned.
- `register_fill_gap(p_store, p_from, p_to, p_reason)` (platform only) writes `lost` noop rows.
- `prune_register_ops(p_before)` (platform only) drops payloads older than 400 days, keeping the row skeleton, and undo rows older than 60 days.
- **Tests** `tests/034_register_ingest_test.sql` (register impersonation via `request.jwt.claim.sub`, `_shim.sql:54-62`): every kind in `_register_kind_perms` names an existing writer and has its own ok test; dup; gap; `current:false` with `reason` `replaced` (epoch mismatch, and the old uid after a takeover), `revoked` and `quarantined` (with `conflict.s`); a re-checkout whose total changes applies (no 42501) and leaves `lensy.money_write` empty; a register in an `Africa/Cairo` store gets the Cairo `store_day`, not the UTC day; a licence with `features.lab = false` flags `sale.lab_status` with `feature:lab`, and `license_feature('lab')` answers unchanged for a staff session; each kind in `MONEY_KINDS` wrapped in a `noop` → `refused: money_skip_forbidden`, and the `money` column equals the generated list; a missing target holds STATE for every `sale.*` kind and `payment.collect` and flags `delete_missing`/`target_missing` for the others (§3.6); **revert**: three forged ops (`customer.upsert`, `sale.create` with a payment and a stock movement, `staff.set_access` deactivating a cashier) after a conflict, then `register_revert_ops` → every guarded table of the store equals its snapshot taken before the forgery (including `stock_qty`, `amount_paid` and `invoice_counter`), the forged rows sit in `register_ops_foreign`, `last_seq` is back, and the genuine ops at the same seqs then apply; revert refused for a store that is neither quarantined nor revoked and for non-platform callers; held op rolls back its own rows and keeps earlier ops; held_* cleared after a successful retry; licence revoked mid-batch → applied and flagged; each flag fires once in isolation; each hold class fires; each refusal fires (forged `staff.set_access` on the owner, `staff.create` with the register uid, foreign product id, foreign actor, `' admin '` role, bad command) with the target row unchanged and `alert` set; seq conflict quarantines; no NULL-store row after every kind; attribution columns equal the op actor and never the register uid; `audit_log.via_register/event_at`; event times verbatim with `t = now() - 7 days`; `lab_status_changed_at = t`; `shift.close` recompute equals the PC figures; budget 0 acks one op per call and a loop drains 2,000 `note.upsert` ops to `last_seq = 2000`; `lensy.ingest` empty after return; writers not executable by authenticated; a register JWT calling `create_sale_order` refused; the register cannot select any table; export windows and owner-only `register_export_ops`. `tests/034_ingest_twin_test.sql`: the 030 scenarios through the online RPCs in store A and through ingest in store B with `t` near `now()`; equal ledger per method, `stock_qty`, header money and `z_report`. `tests/034_register_parity_test.sql`: generated (§8, Phase 4). A 2,000-op backlog timing bench lives in `web/supabase/bench`, not in the gate.

### 4.5 Edge Functions and client pieces

- **`supabase/functions/create-register`** (+ pure `authz.ts`, tested like `createUserAuthz.test.ts`), modelled on create-user/index.ts:54-150. Caller must be `stores.owner_uid` (not a platform admin) and `license_read_ok` (so a dead PC can be replaced in grace). Modes: `setup`, `restore` (backup file, §6.2), `takeover` (another PC, §6.4), `reclaim` (the same PC with its database intact, after `diverged` or `reclaim_required`, §6.3), `{resume:true}`. Takeover is refused unless `p_force` + a reason of ≥ 10 characters when `pending_reported > 0` or `last_contact_at` is older than 15 minutes or null. Steps: create auth user `register.<store_id>.<epoch+1>@<domain>` with 32 random bytes; `_register_install` (epoch+1, keep `last_seq`, `snapshot_until = now() + 24 h`, `register_only = true`); on error delete the new user; ban the old register uid; conversion: ban each id from `_register_convert_staff` (cloud principals except owner and platform admins), then `_register_mark_local`; legacy rows with no auth user are marked without a ban; `register_status.convert_pending` lets `{resume:true}` finish a partial run. `reclaim` takes the PC's `acked_seq` and the op ids of its outbox; ops in `(acked_seq, last_seq]` whose id is not among them are foreign (they must form a suffix; anything else is refused for the vendor). `restore` does not apply this check, because ops sent after the backup was written are the PC's own and are re-hydrated. With foreign ops present, and the call is refused with `foreign_ops{from_seq, count}` (and `alert` set) until the vendor has run `register_revert_ops` (§6.3). The response returns the credential once, `L = last_seq` and the store's numeric `max_invoice` (§6.2). **Deployed only after 034 is applied.**
- **create-user**: the seat count uses `.eq('is_active', true)` (index.ts:93-96) and ships in **Phase 0b**; the 409 "add staff at the shop PC" when `store_is_register_only` ships with 033 (Phase 1).

---

## 5. Security analysis

| Threat | Outcome |
|---|---|
| Stolen register token | Can call ingest and ping and insert photos in its own folder. Cannot read tables (`auth_store_id()` null; export only in a 24 h setup window). Can forge ops as any staff member, including the owner; those pass permission checks, so detection is the seq conflict (the real PC's next op collides → quarantine and phone alert) and `no_session`. Cannot change the owner, cloud logins or platform admins (`protected_target`), cannot use reserved roles, cannot delete or overwrite photos, cannot touch other tenants (`foreign_id`, `foreign_actor`). Revision 1's "equivalent to having the shop's data" understated this; the residual is forged history visible on the phone until the vendor reverts it from the undo log and the owner re-claims (§6.3); the till keeps selling throughout. |
| Owner lockout | Cut at every step: protected owner row, `revoke_register` keyed on `stores.owner_uid` (which only the vendor and create-register write), owner re-claim on a new epoch. |
| Forged actor / actor trust | The actor must be a `users` row of the store (`foreign_actor` refusal). Owner-attributed forgery is visible only through `no_session` and seq conflict; session and credential ops give the phone a who-was-at-the-till trail. |
| Staff revocation | Owner command from the phone (`owner_deactivate_staff`), applied by the PC as an ordinary op when online. While the PC is offline, physical access is the control; the phone says so. Banned cashier JWTs stay valid up to 1 h after cutover; the guard trigger already blocks their writes. |
| `link_staff_ids` / `staff_id_problems` | Dropped in 031 (takeover primitive, sync-killing FK swap, cross-tenant leak with anonymous access per DEFERRED.md:27-29). |
| Cross-tenant probing | `resolve_can`/`is_store_admin` store guard (032). |
| Platform admin / service role / create-user writes under `register_only` | Guard trigger; create-user 409. Platform admins keep licence control and `set_store_owner`, `revoke_register`, `end_register_mode`, `register_resolve_held`, `register_revert_ops`. Migrations do not modify `register_only` stores (§4 preamble). |
| Storage | Register insert-only; owner phone writes blocked; register file names unguessable; the public bucket itself is an existing risk noted for the vendor. |
| Staff JWT setting `lensy.*` GUCs | Ignored: every ingest GUC path also requires `register_store_id()` = the row's store, and `lensy.register_admin` is honoured only when `current_user` is the definer functions' owner (§4.3). |
| Clock rollback | Licence floor `serverNow`; 45-day/45-close contact allowance; backwards-clock banner; `clock_back` flags. |
| Cloned PC or restored backup | A restore is a takeover with a new epoch; the old epoch gets `current:false, reason:'replaced'` and goes `stranded` (business commits refused, export kept). A clone that keeps the old epoch collides on seq → quarantine. |
| Register credential at rest | In IndexedDB `meta.register`, read only by the lock holder; excluded from backups and exports; revocation makes re-sign-in fail. |
| `contact_lens_types` | Revoked from anon and authenticated (031). |
| Op payload privacy | `register_ops.payload` holds customer PII; readable only through summaries for the owner and in full by platform admins; credentials never appear; pruned after 400 days. |
| Public sign-up | SETUP.md requires it disabled; a 033 assertion shows a login with no users row and no register row gets `auth_store_id()` and `register_store_id()` both null. |
| Remaining advisor items (mutable `search_path` on seven functions, DEFERRED.md:27-34) | Not v2 work; new functions all set `search_path`. |

---

## 6. Recovery

### 6.1 Backup

- Every shift close: in the Close button's click handler, call `requestPermission({mode:'readwrite'})` on the directory handle loaded at page mount; after the close commits, write `lensy-<store8>-<YYYYMMDD-HHmm>-s<nextSeq>.json`; keep the newest 30. No handle or denied → download to Downloads. `meta.lastBackupAt` is amber after 2 days.
- Format `lensy-register-backup` v3 (port of `v1:backup.ts:24-127`): mirror, outbox, skipped, `nextSeq`, `ackedSeq`, `epoch`, `invoiceNext`, clock, non-uploaded image fulls and thumbnails of photos uploaded in the last 30 days. Credentials and the register credential are excluded. An admin "full archive" export may include every thumbnail.

### 6.2 Restore from a backup file (works offline)

1. Refused while this database has unsent or skipped ops not yet exported; run under the sync lock with `expectCommitSeq` (v1 import was not serialised, `v1:backup.ts:128-160`).
2. `replaceStores` from the file; `invoiceNext = max(file, local) + 1000`; `epoch = null`; state `reclaim_required`. Selling continues; new ops are numbered locally but not sent.
3. Re-claim (online, owner): create-register `restore` → new epoch, returns `L = last_seq` and the cloud's numeric `max_invoice`; the PC sets `invoiceNext = greatest(invoiceNext, max_invoice + 1)`. The offline `+ 1000` of step 2 is only a guess made before the cloud max is known, and is wrong when more than 1000 sales were acked after the backup.
4. Re-hydrate with the owner session: page `register_export_ops(ackedSeq + 1)` to `L`. A cloud op whose `i` is in the local outbox deletes that local op. A full-row upsert/delete cloud op whose id is touched by a later local op is skipped; partial kinds are applied in seq order and the local ops re-applied after. Everything else goes through `applyOp`.
5. Invoice collisions, before the rebase: any unsent local `sale.create` whose `invoice_no` now equals a re-hydrated sale's number gets the next free number from `invoiceNext`, in one transaction that rewrites the op payload (adding `renumbered_from`), the mirror header and any local image paths that embed the number. The server flags it `invoice_renumbered` (§3.5), and the PC shows the cashier the list of old and new numbers, because those receipts were already printed. Without this the per-store unique `sales_store_invoice_no_key` (030:82-83) would make an INT hold on a money op.
6. Rebase: renumber remaining local ops to `L+1…` in order, set `nextSeq`, `epoch`, `idle`, drain.

Restore from cloud (no file, or past retention) is setup again; it is refused while the outbox or `skipped` store is non-empty until the admin has exported them and typed "DISCARD" (v1 lost skipped sales this way, `v1:sync.ts:948-980`).

### 6.3 Seq conflict (token misuse)

The server quarantines the register and answers `current:false, reason:'quarantined'`; the PC enters `diverged` and **keeps selling** (an owner Revoke likewise gives `reclaim_required`, not `stranded`). The forger's ops are already applied in the cloud: they are exactly the range `[conflict_seq, last_seq]`, because the genuine PC always sends from its head and the conflict stops the batch at the first collision. Leaving them would make cloud and PC differ permanently and put the genuine ops on top of forged state (for example `actor_inactive` flags after a forged deactivation, or STATE holds on a forged-voided sale). So recovery is:
1. The vendor runs `register_revert_ops(store, conflict_seq, reason)` (§4.4). It undoes the forged ops from `register_undo` in reverse order, moves them to `register_ops_foreign` and sets `last_seq = conflict_seq - 1`; the cloud then equals its state before the forgery. Photos the forger inserted stay in storage as listed orphans (the register cannot delete, §4.3).
2. The owner re-claims on the genuine PC with create-register `reclaim` (new epoch, old uid banned). `L = conflict_seq - 1 ≥ acked_seq`, so the PC's outbox already continues at `L + 1` and nothing is rebased; ops it sent with a lost response come back as `dup`.

After an owner Revoke without a conflict, `reclaim` finds the forged suffix itself from the PC's `acked_seq` and outbox ids, refuses with `foreign_ops{from_seq}`, and the same two steps follow. The forged ops are listed to owner and vendor from `register_ops_foreign`. Cost: the undo log and the revert function (about 2-3 developer-days in Phase 1, with the test in §4.4) and one vendor action per theft; the alternative of compensating ops on the PC cannot undo a forged void.

### 6.4 Takeover and the stranded PC

- Takeover refusal rules are in §4.5. The new PC gets `invoiceNext = cloud max + 1000`.
- The old PC, on `current:false, reason:'replaced'` or a `user_banned` sign-in (§3.9), enters `stranded`: business commits refused (two writers are never allowed; log kinds still commit so staff can sign in to export, §2.3), red banner "This computer is no longer the register", and two actions: "Export unsynced changes" (a read-only `lensy-ops` file of outbox, skipped and pending images, for the owner to review and re-enter by hand) and, for an online owner, "Make this computer the register again" (a new claim plus the §6.2 rebase).
- Automatic import of a stranded PC's ops into the new PC is **not** built: re-sequenced ops would need per-kind conflict rules against a state that has moved on, and the guard makes the case rare (a dead PC cannot export anyway). Cost: manual re-entry in the rare forced-takeover-with-live-old-PC case.

### 6.5 Browser storage risk (H9)

- Fixed origin; installed PWA; setup requires `navigator.storage.persisted() === true` and standalone display mode; every boot warns red if not persisted and amber above 80 % of quota.
- Backups at every close; the unsynced badge with age; the owner page in `web/OFFLINE.md`: never clear site data, never uninstall, one profile, backups hold customer PII.
- Residual risk: anything committed after the last backup and never synced is lost if the profile is wiped. The 90 s push debounce and the daily close backup bound it.

---

## 7. Reuse from v1

| v1 file:lines | v2 module | Verdict | Why |
|---|---|---|---|
| `web/src/lib/local/db.ts:104-221, 306-320, 389-505` (wrap/done, getters, listeners, BroadcastChannel, withLock, commitSeq, cleanRow, meta, images/credentials, replaceStores, snapshot) | `lib/register/db.ts` | Rework | Generic, hardened IndexedDB helpers kept as written, except `withLock`: v1 runs the function **unlocked** when `navigator.locks` is missing (`if (!locks?.request) return fn()`, `v1:db.ts:199-200`); v2 refuses instead (§3.9) |
| `db.ts:10-16, 68-103, 240-304` (openDb, commit) | `db.ts` | Rewrite | Versioned ladder; `commit(k, actor, build)`, gapless seq, strict durability, `applyOp`; keep abort-on-throw (285-296) and onversionchange/onblocked (91-101) |
| `db.ts:322-388` (outbox helpers, `outboxSkipHead`) | `db.ts` | Rework | Seq keys, `outboxAckThrough`, in-place noop skip with leaf/dependency checks, uncapped `skipped` |
| `schema.ts:1-89` | `register/schema.ts` | Rework | New stores and indexes; `stock_qty` becomes a cache |
| `uuid.ts` | `register/uuid.ts` | Keep | — |
| `sync.ts:72-188, 507-515` (status store, classifier, deviceId) | `register/sync.ts` | Keep | New fields and codes; never map a missing function to success |
| `sync.ts:383-424, 431-485, 715-760, 766-818` (drain loop, images, syncNow/startSync, pull) | `sync.ts` | Rework | Batched ingest; ack-gated images; no `setInterval`; pull via `register_export` |
| `sync.ts:867-987` (link/provision/restore guards) | Setup, restore | Rework | create-register flow; keep the sync-lock, empty-outbox and store-match guards |
| `localAuth.ts:81-140` | `register/auth/verifier.ts` | Rework | Derive/compare helpers reused; v1's fixed `ITERATIONS = 150_000` (`localAuth.ts:21`) becomes 600k stored per record with upgrade on sign-in; `setOfflinePassword` rewritten with target rules |
| `localAuth.ts:20, 40-77, 142-243`; `auth.tsx:58-95` | — | Drop | Shared localStorage session, online check, name-to-email identity |
| `backup.ts:24-127` | `register/backup.ts` | Keep | Format v3, refusal rules (101-108) |
| `backup.ts:128-160` | `backup.ts` | Rework | Lock, takeover, never replace a live outbox |
| `state.ts:9-16, 67-85` | `rules/license.ts` | Rework | `pending`, `starts_at`, `max_staff`, `features`, server floor |
| `boot.ts:13-35` | `register/boot.ts` | Keep | Persist result enforced; schema check; lazy images |
| `config.ts:16-54`, `main.tsx:50-107`, `vite.config.ts:11-30` | same | Keep | Minus `READ_ONLY`/`VITE_CLOUD_URL`; plus `@backend` and `prompt` |
| `features/local/SetupPage.tsx`, `SyncStatus.tsx`, `BackupPanel.tsx` | `features/register/*` | Rework (40-70 % survives) | New states (held, diverged, stranded, reclaim), flags, bytes, clock and licence banners; RelinkForm → "Re-claim" |
| `repositoryLocal.ts` read helpers 64-111, 144-167; reads only: 205-248, 591-617, 710-721, 811-818, 836-845, 917-922, 975-978, 1003-1009, 1016-1027, 1042-1055 | `data/backend/local/*` | Rework | Behind main's hook signatures; about 20-30 % of the file. The writes in between (`addNote`/`updateNote`/`deleteNote`/`markNoteSeen` 819-858, `addSupplier`/`updateSupplier`/`deleteSupplier` 979-1001, `addPurchase`/`addPurchasePayment`/`deletePurchasePayment` 1010-1040) are **not** ported (do-not-port item 12); v2 writes go through `commit()` |
| `repositoryLocal.ts:368-386` | `rules/invoice.ts` | Concept | Persisted high-water mark; the `getAll('sales')` scan is dropped |
| `supabase/011_multistore_hardening.sql:26-95` | 031 | Rework (list idea only) | No sales/roles/contact_lens_types; `create unique index if not exists` instead of the abort-prone handler (51-62) |
| `011:276-324` | 033 | Concept only | Rewritten; "no role = admin" and missing-function-as-success dropped |
| `render.yaml:65-84` | `render.yaml` | Keep | The `lensy-register` block |

**Do not port:**
1. The repository seam (`lib/repository*.ts`, `repositorySupabase.ts` writing revoked tables).
2. v1 money: `repositoryLocal.ts:432-554, 649-670, 764-810` (float money, deleted movements, PRESC numbering, inventory delete).
3. Row upserts and deletes, column stripping, `assertCanWrite`, `pushDelete` (`sync.ts:200-341`): silent data loss.
4. The device-admin account model and RBAC/user writes (`repositoryLocal.ts:860-973`).
5. `011` sections 2-5 (96-332): `auth_staff_id`, the `auth_store_id` override without `is_active`, permissive delete policies, `claim_register`.
6. v1 create-user (`superadmin` unreserved).
7. `adoptPhoneImages`, heartbeat, licence/staff/claim polls, `pullNewStaff`, the timers (`sync.ts:57-63, 487-633, 746, 988-1029`).
8. `cloudMaxInvoice` (text-sorted), `requireStore`/`myStaffRow` name matching (`sync.ts:820-866`).
9. `auth.tsx:69-79` cross-window session propagation.
10. `wizardStore.ts`.
11. `render.yaml:39-64` (`lensy-phone`) and `VITE_READ_ONLY`.
12. Every v1 write in `repositoryLocal.ts`, including the note, supplier and purchase writes at 819-858 and 979-1040 (`deleteSupplier`/`deletePurchasePayment` among them).

A grep test fails if `repository*`, `wizardStore` or `adoptPhoneImages` appears in `web/src`. About 1.6-1.8k of v1's ~5.5k client lines carry over; v1 has no tests, so each ported file lands with its v2 suite.

---

## 8. Phased build plan

Developer-days for one developer, remaining after the built Phase 0. Global gate on every merge: oxlint, `tsc -b`, vitest, build, stamp check, all pgTAP files, schema fingerprint (ci.yml).

| Phase | Content | Days | Ships |
|---|---|---|---|
| 0 | PR #3 as built | 0.5 | Live (deploy) |
| 0b | 031 (incl. `referenced_image_paths`) + `settings.ts` + create-user active seats + paged orphan scan with 14-day age gate; EXPECTED 31 | 1.5-3 | Live |
| 1 | 032 (live after the 7-day gap), 033 (live, dark) + phone read-only client (EXPECTED 33) + create-user 409 + orphan scan skips `register_only`; 034 (working number, §4) written with the undo log and `register_revert_ops` but kept on the branch | 15-22 | 032/033 live |
| 3a | Cloud half of the seam (§2.2), auth area, frozen checkout key | 6-9 | Live (pure refactor) |
| 2 | `lib/register/db.ts`, `money.ts`, `rules/*`, `ops.ts`, `applyOp`, clock, licence, invoice, drafts | 12-16 | Not shipped |
| 3b | Local backend, register shell, lock screen and PINs, local PermissionsProvider, register site created first | 12-18 | Register origin, test store only |
| 4 | Sync, setup, backup/restore/takeover/reclaim (incl. invoice renumbering at re-claim), phone banner and Flags page, commands, photo compression, golden parity | 13-18 | Then 034 applied under the next free number (§4); create-register deployed |
| — | Dry run on the test store; cutover; pilot 1-2 calendar weeks | — | Real shop |
| 5 | Thumbnail/prune, phone paging, OFFLINE.md, README, DEFERRED.md:16 | 2-5 | During/after pilot |

**Total ≈ 62-92 developer-days; the pilot starts after ≈ 60-87.** Path C (v2 server, v1 client infrastructure) is chosen over rebasing v1 (60-90 d, nothing shippable until the end) and over v2 without reuse (rebuilds what v1 has).

**Phase tests (beyond §4):**
- **0** Already green. Ship steps (RELEASE_030.md): merge; at closing run `select * from lensy_schema_versions` and confirm 29 is latest; paste 030 and confirm 30; deploy `lensy-web` and reload every shop device that evening; run the release checks (split-tender re-checkout after a partial refund, void after refund, receipt vs header) in a **test store**, never with real money in the shop. The only transition cost is a cached pre-PR#3 tab until it reloads (it sends no `expected_tenders`, which is optional at 030:485-488).
- **0b** `031_per_store_unique_test.sql` (plus `referenced_image_paths` pages past 1,000 rows and is refused for non-platform callers); vitest for `onConflict`; `storageOrphans.test.ts` (a file younger than 14 days is never an orphan; a store with 1,500 sales keeps every referenced photo); `createUserAuthz`/index test that inactive users do not count against `max_staff`.
- **1** `032_actor_core_test.sql`, `033_register_test.sql`; the 034 files run on the branch; all 25 existing files green with `register_only` false (015 replaced, 018 G-P4b corrected); vitest `readOnlyPerms.test.tsx` (no write controls on the gated components; banner; Revoke only for `isOwner`), `createRegisterAuthz.test.ts`.
- **3a** Existing vitest green; `backendSeam.test.ts` (lib/supabase imported only by `data/backend/cloud/**` and the four cloud-only files); a fixture of a paused checkout serialised by the pre-3a build resumes; no `indexedDB` or `lensy-register` string in the cloud bundle; a cloud build with no register flags passes the wrong-build guard. Deploy at closing with every journal empty.
- **2** fake-indexeddb: failed rule writes nothing and uses no seq; gapless seq across two connections; strict durability (spy); business kinds refused in `stranded` and in every licence state but `active` (including `contact_due`), committed in `held`, `diverged` and `reclaim_required`; every `LOG_KINDS` kind commits in every state; sign-in (`session.start`) succeeds on an expired PC and on a stranded PC; `MONEY_KINDS` equals the generated list; `staff.create` with `'Ahmed '` refused when a mirror user `'ahmed'` exists (active or not); `applyOp` fold equals the live database for every kind; `stock_qty` cache equals movements; v1→v2 ladder keeps the outbox. `money.test.ts` (1.005→101, −1.005→−101, 2.675→268, 1000.005→100001, 0.1+0.2→30; `weightedCost` (10,400,10,600)→500, (0,500,3,700)→700, (−2,500,3,700)→700, (1,1,1,2)→2). Generated parity: `rules/parity.vectors.json` → `web/scripts/gen-rules-parity.mjs` → `tests/rules_parity_test.sql` (round, price_cart, weighted cost, z_report, variance), and `parity.test.ts` runs the same vectors; CI regenerates and runs `git diff --exit-code`. `sale.test.ts` mirrors the 030 and 028 gate files case by case, plus legacy `'Cash'`/`'cash + instapay'` refund-then-void, cash→card swap without `history.refund`, idempotent replay after a role change, invoice collision renumbering. `tender.test.ts` against the shared `tender_key` table. `perms.test.ts` from `029_effective_permissions_test.sql`. `clock.test.ts` and `license.test.ts` (1-year-fast clock then corrected; −20 min banner; Use internet time; licence floor; pending; 46 days or 46 closes → contact_due). `time.test.ts` (Africa/Cairo 23 h and 25 h days). `invoice.test.ts` (50 concurrent allocations distinct; survives reopen; never lowered by import). `drafts.test.ts`. `zreport.test.ts` mirrors 023/024.
- **3b** Local and cloud backends export identical keys; per-module fixture tests (lists, search with `%`/`_`, paging, reports); two provider instances never share an actor; no localStorage/sessionStorage writes or `storage` listener; reload shows the lock screen; PIN policy, lockout schedule, reset matrix; credentials absent from outbox and backups; session ops carry `sid`; the full offline POS script (new customer → quickAdd → exam with new frame → Finish → receipt → re-checkout → refund → void → Z) makes **zero** fetch calls; no QR button in the register build; void calls no storage API; `syncExamReferences` never deletes inventory.
- **4** Fake ingest: ok, dup after a lost response, gap, held stops sends while commits succeed, `current:false` reasons (`replaced` → stranded; `quarantined` → diverged and `revoked` → reclaim_required, both still selling), `user_banned` → stranded, Skip rules (refused for each of the `MONEY_KINDS`, for entity creates, for dependants, for a changed head; allowed noop keeps `s`/`i`), backoff with jitter and Retry-After, offline attempts uncounted, no network call with empty queues until a ping is due, 50-op and `shift.close` triggers, halving and doubling, `more:true`, PGRST202 transient, images after ack, 64 KB cut never splits an op; one lock holder builds `registerClient` with `autoRefreshToken:false`, refresh within 60 s, re-sign-in on "Already Used", `reclaim_required` on invalid credentials; setup claims before export, refuses `persisted()=false`, seeds `invoiceNext`; restore → reclaim → re-hydrate → rebase; restore with 1,200 sales acked after the backup: `invoiceNext` ends above the cloud max and colliding unsent sales are renumbered, carry `renumbered_from` and are listed; `reclaim` after a conflict sends `acked_seq` and outbox ids, gets `foreign_ops` until the revert, then continues at `L + 1` with forged ops absent from the mirror; stranded refuses business commits and exports; byte counter; ping schedule; commands applied once; badge thresholds at exactly 24 h and 72 h. **Golden parity:** a vitest scenario runs a trading day through the PC rules and regenerates `tests/034_register_parity_test.sql`, which feeds the ops to `register_ingest` and asserts cloud `z_report`, `report_sales_window` and `customer_balance` equal the embedded PC figures; vitest fails when the committed file is stale.
- **5** Thumbnail ≤ 320 px; backup size bounded after a simulated year; pilot exit criteria by hand.

**Cutover checklist (real shop).**
Preconditions: 030 live ≥ 2 weeks; 031-033 live ≥ 2 weeks; 034 applied ≥ 1 week; 3a live; a full dry run on a **test store** in the same project using a **separate browser profile or machine**; owner decisions answered; licence active with > 30 days left; `stores.owner_uid` set.
1. Take a Supabase backup.
2. Bring **every** device that ever sold on `lensy-web` online; confirm its checkout journal is empty; sign it out; retire it from selling. List any unreachable device and check its journal before it is ever opened online again.
3. Close the shift (Z) on `lensy-web`.
4. Review staff: the owner keeps the cloud login; cashiers become register-local (their cloud logins are banned by create-register).
5. On the PC: dedicated profile, install the register PWA from the fixed origin, choose the backup folder.
6. Setup: owner signs in; create-register (claims, sets `register_only`, epoch 1, conversion) **before** the export; paged export with size estimate; seed `invoiceNext`; owner and staff PINs; `register_snapshot_done`; admin session signed out.
7. Compare counts with the cloud: customers, products, sales, open balances, stock total, max numeric invoice = `invoiceNext - 1`, `convert_pending = 0`.
8. One real low-value sale; on the phone: appears within about 2 minutes, green banner, write buttons hidden, a `lensy-web` write attempt refused.
9. First backup written.
10. Day 1: developer on call; Flags page reviewed at close.

**Pilot exit:** zero held ops, zero `z_mismatch`, flags reviewed, non-photo `bytesThisMonth` projected under 30 MB, photo bytes per order measured and the monthly photo projection (expected 70-140 MB, §3.10) accepted by the owner, one restore drill on a spare profile against the test store.

**Rollback plan.** Migrations are forward-only.
- Before cutover everything is dark or a pure refactor: redeploy the previous web commit; forward-fix a migration within the day; 030 is never reverted.
- Planned return to online mode: stop selling, "Sync now" until pending is 0, `end_register_mode(store)` (owner or platform admin; force only for a lost PC), staff get new cloud logins through create-user (plain names are free because `end_register_mode` deactivates and renames every register-local user, active ones included; history stays attributed to the old ids).
- PC lost or wiped: restore the latest backup on a new profile (§6.2); unsynced work after the last backup is the residual loss.
- Stolen token: `revoke_register` from the phone (the till keeps selling), the vendor reverts the forged ops, then the owner re-claims (§6.3).

---

## 9. Owner decisions needed before Phase 1

Defaults in brackets.

1. Deploy Phase 0 (PR #3) to the live shop now, at closing time, before any register work? [yes]
2. Which existing cloud login is the store owner? Only that account can install or replace the register, revoke it and deactivate staff from the phone. [the single admin login; the vendor sets it if there are several]
3. Should anyone besides the owner see the shop on a phone? [no; at cutover every cashier's cloud login is switched off and they sign in only at the PC with a PIN]
4. Staff are added, changed and switched off only at the PC. A cashier switched off from the phone is locked out when the PC next goes online, normally within minutes. Acceptable? [yes]
5. If the PC clock is wrong, sales show on the phone at the time the PC recorded, with a warning, rather than being moved. This keeps the phone in line with the printed receipt and the PC's own Z. Acceptable? [yes]
6. Sales after the day is closed: allow with a warning and show them as "after close" under the closed day, or block until the next day? [allow]
7. Who may press "Use internet time" when the PC clock is wrong? [owner and admins only]
8. PIN rules: at least 4 digits for cashiers, 6 for admins and the owner; screen locks after 5 idle minutes; 5 wrong tries lock that person for 1 minute, rising to 30 minutes. [as stated]
9. Photos: taken only at the PC (webcam, scanner or file), or also by phone through the QR code (needs an online phone and about 100 KB more quota per photo)? Is about 90 KB per photo clear enough to read a prescription? With up to two photos per order (prescription and frame) the shop's internet use is about 85-160 MB a month. [PC only; yes]
10. How long full-size photos stay on the PC after upload; older ones show as previews offline and full size only online. [30 days]
11. Voided sales keep their photos. [agreed]
12. How fresh must the phone be? [about 2 minutes after a sale]
13. History loaded at setup: everything (about 6-12 MB once) or the last 2 years plus every open balance? [everything]
14. Backups: which folder or USB stick, and who checks weekly that files appear? Is the Downloads folder acceptable if none is chosen? [a USB stick; owner checks]
15. Unsynced warning thresholds: amber when the oldest unsent change is 24 hours old, red at 72 hours. [as stated]
16. After a restore or a replacement PC, invoice numbers jump by 1000, leaving a visible gap. Acceptable to the accountant? [yes]
17. Moving the register to another computer while the old one may hold unsent changes: may the owner force it alone with a typed reason, or should it need the vendor? [owner alone]
18. The register must run as an installed Chrome or Edge app, from one fixed web address, in one Windows profile with developer tools disabled. Clearing site data destroys unsent sales. Can the shop commit to that, and which browser? [Chrome]
19. The cloud keeps every change the PC sent for 400 days so a lost PC can be rebuilt; it includes customer details. Acceptable, or shorter? [400 days]
20. When the licence has expired, the PC keeps read-only access (history, reprints, reports, backup export) rather than blocking the app as the online app does. Acceptable? [yes]
21. Who reviews the Flags page, and how often? [owner, daily at close]
22. Approve a dry run on a separate test store in the same cloud project; choose the cutover day, the pilot length (1-2 weeks) and which old devices are retired. [approve; a quiet weekday; 2 weeks; all]

**Vendor decisions:**
- V1. If a store's licence is revoked or unpaid, do sales made while it was valid still reach the owner's phone? [yes: the cloud applies and flags them; stopping a register is `revoke_register`; the PC stops new selling locally]
- V2. How long may the PC sell without reaching the internet? [45 days or 45 shift closes, whichever comes first; expiry is enforced offline by the clock, revocation and renewal at contact]
- V3. Who may end register mode (return to online selling): the owner from the phone, the vendor, or both? [both; force only by the vendor]

---

## Appendix A. Resolution table

### A.1 Critique items

| Item | Section | Resolution |
|---|---|---|
| C1 | §4.2 | `resolve_can` keeps signature and grant; store guard in the body; internal `_resolve_can_for`; parity test. |
| C2 | §3.2, §3.5, §3.6, §4.2, §4.3, §4.4 | Writers pass the store from `store_registers`; `_z_report(p_store)` with `z_report` as a wrapper; `_store_day_range(p_store)` on `store_time_zone_for` for `store_day`; `_license_feature_for(p_store)` for `feature:<code>`; `audit_row`/lab stamp under the ingest gate; `sale_payments.store_id` NOT NULL. |
| C3 | §3.4, §3.6, §3.8, §2.7, §4.3 | Policy always flags; holds only for MAL/INT/STATE/FAULT, with one missing-target rule per kind (§3.6); Skip only for leaf kinds outside the explicit `MONEY_KINDS` with no dependants; per-store usernames (033, §4.3) and a PC-side uniqueness check on `staff.create` (§2.7); `max_staff` a flag; vendor park. |
| H1 | §4 preamble, §4.3, §4.4, §4.5 | Guard trigger covers platform admins, service role and migrations; its bypass is set only in the named definer functions (incl. `set_store_owner` and the conversion helpers); migrations never modify `register_only` stores (corrections ship as ops); create-user 409; register-scoped time-boxed export incl. private notes; catalogue hash in responses. |
| H2 | §2.8, §4.3 | `my_permissions` returns `read_only`, `is_admin:false`, `is_owner`; existing gates hide writes unchanged. |
| H3 | §3.3, §3.4, §3.9, §4.3, §4.4, §5, §6.3 | Protected targets refused; `revoke_register` on `owner_uid`; insert-only register storage (RESTRICTIVE policy; `lensy_storage_all` unchanged); seq-conflict quarantine and alert; `current:false` carries a reason so quarantine and revoke keep the till selling; forged ops reverted from the undo log before re-claim. |
| H4 | §2.6 | Invoice allocated at cart entry in its own transaction; drafts in IndexedDB; collision renumbers draft-only photos; 030 already made the online check per-store (030:325-330). |
| H5 | §1.6, §2.3, §2.5 | Wall-clock stamps; `high` only for a banner; server-time licence floor; Use internet time; owner clock reset op; the licence gate lives in `commit()` for business kinds only, log kinds always commit. |
| H6 | §2.4 | Integer minor units, decimal-string parsing, half-away rounding, generated parity vectors against SQL. |
| H7 | §2.4, §3.6, §4.2 | Derived refund/restock/delta rows sent verbatim; `tender_key`/`tenderKey` twins; server flags differences. |
| H8 | §6.2-6.4, §4.5 | Every restore is a takeover; owner-session `register_export_ops` re-hydrate and rebase; `invoiceNext` raised to the cloud max at re-claim with colliding unsent sales renumbered; takeover guard on pending or stale contact; stranded PC refuses business kinds only and exports. |
| H9 | §2.1, §6.1, §6.5 | Fixed origin, installed PWA, `persisted()` required, backup at every close, unsynced badge with age, owner page. |
| M1 | §4.2 | FKs re-pointed NOT VALID then guarded VALIDATE; default kept so a forgotten actor fails loudly; test. |
| M2 | §3.2, §3.9 | Piggyback carries plan, max_staff, features, is_revoked; pings with an empty outbox; Check licence button. |
| M3 | §3.9 | One Web Lock holder owns the session; `autoRefreshToken:false`; IndexedDB storage; lazy refresh; re-sign-in. |
| M4 | §3.3, §3.9 | 3 s server budget with `more`; 57014 fails whole and the PC halves; bench for 2,000 ops; drain test in the gate. |
| M5 | §2.4, §2.9 | Void keeps photos; QR removed from the register; inventory delete not ported; no inventory-delete kind. |
| M6 | §2.4 | Register prints the stored header; cloud `receiptTotals` snapping branch fixed in PR #3 (pricing.test.ts pins net = items + 0.01 → items, + 0.02 kept). |
| M7 | §2.9, §6.1 | Thumbnail kept, full blob pruned 30 days after upload, quota guard, backups bounded to 30 days of thumbnails. |
| M8 | §3.3, §3.6, §4.4 | Flags in locals, not a GUC; `sale.refund` carries `row{id,…}`; the window unique is `shift_closes_window_uniq` at 023:84 (the critique's 023:89-91 is the RLS comment). |
| OE1 | §3.6, §4.4 | Adopted: 23 thin writers listed by name; no online money RPC refactor; writers raise `lensy.money_write` around the re-checkout header UPDATE; the 448 assertions stay the oracle. |
| OE2 | §2.1 | Adopted: two builds; `lensy-phone` and `VITE_READ_ONLY` dropped. |
| OE3 | §3.5 | Adopted: `licence` flag when `t` is outside `[starts_at, expires_at)` or revoked; no `revoked_at` history. |
| OE4 | §4.1 | Overruled: `link_staff_ids` and `staff_id_problems` are dropped in 031 (verified takeover and anonymous-read leak). |
| Bandwidth notes | §3.9, §3.10, §2.9, §2.8 | Non-ok results only; `autoRefreshToken:false`; photo cache after first view; polls already removed in PR #3; phone reports paged in Phase 5. |

### A.2 Critique "Missing tests"

| Bullet | Where | Test |
|---|---|---|
| MT1 restrictive policies after C1 | §4.2 | 014/029 gates unedited + `032_actor_core_test` parity. |
| MT2 z_report/close non-zero under register; no NULL-store rows | §4.4 | `034_register_ingest_test` (shift.close recompute; NULL-store sweep). |
| MT3 skip deadlock; username collision; max_staff | §8 Phase 4, §4.3, §4.4 | vitest Skip refusals; 033 per-store usernames; 034 `max_staff` flag. |
| MT4 platform-admin/create-user refused; private-notes snapshot | §4.3, §4.4, §4.5 | 033 refusals; 034 export returns private notes; create-user 409 vitest. |
| MT5 phone hides write controls | §8 Phase 1 | `readOnlyPerms.test.tsx`. |
| MT6 forged owner lockout; no storage delete | §4.3, §4.4 | 034 refusal of forged `set_access`; 033 storage delete fails. |
| MT7 invoice at cart entry survives reboot; no cross-store renumber | §8 Phase 2 | `invoice.test.ts`; 030 per-store check already gated in `030_money_fixes_test`. |
| MT8 clock ahead then corrected; rollback | §8 Phase 2 | `clock.test.ts`, `license.test.ts`. |
| MT9 rounding parity | §8 Phase 2 | `rules_parity_test.sql` + `parity.test.ts`, generated. |
| MT10 void after partial refund, mixed-case/collapsed methods | §8 Phase 2, §4.4 | `sale.test.ts`; 034 twin and ingest tests. |
| MT11 restore below last_seq; takeover with pending | §8 Phase 4, §4.5 | vitest restore/rebase; create-register takeover tests. |
| MT12 2,000-op backlog | §4.4 | Budget-0 drain loop in the gate; timing bench outside it. |
| MT13 renewal with empty outbox | §8 Phase 4 | vitest ping at 21 h with empty outbox; renewal unlocks selling. |

### A.3 Verified comparison findings (verification "missed" lists)

| ID | Finding (short) | Section | Resolution |
|---|---|---|---|
| SM-0 | v1 had no server-enforced single writer | §4.3 | Guard trigger enforces `register_only` server-side. |
| SM-1 | 030 already did per-store invoices | §0, §4.1 | 031 limited to sku, metadata names, settings index. |
| SM-2 | v1 skipped sales still decremented cloud stock | §3.6, §7 | One op per action carries sale and movements atomically; row replication not ported. |
| SM-3 | v1 skip + restore loses skipped sales | §3.8, §6.2 | Uncapped `skipped` store; restore refused while it is non-empty. |
| SM-4 | v1 heartbeat reported caught-up after skips | §3.9 | No heartbeat; `skipped_total` reported separately. |
| SM-5 | v1 queue stops at the first sale on main | §1, §7 | Ingest RPC replaces row upserts. |
| SM-6 | v1 strips columns permanently | §3.4, §7 | Do-not-port; unknown fields are flagged and the payload kept whole. |
| SM-7 | v1 licence lacks pending; polls every 30 s | §2.5, §3.9 | `pending` added; no licence polling, piggyback and pings only. |
| SM-8 | supplier delete with purchases holds on FK | §3.6 | PC refuses first; server STATE hold if it ever arrives; deletes never silently acked. |
| SM-9 | v1 pulls `select('*')`, ignores voided_at, no ledger | §4.4, §2.3 | Whitelisted export columns; mirror includes `sale_payments` and void fields. |
| SM-10 | register cannot read tables, so restore needs an export | §4.4, §6.2 | Time-boxed `register_export`; owner-session `register_export_ops`. |
| SM-11 | rows audited as the device admin | §4.3 | `audit_row` uses `lensy.actor` under the ingest gate; `via_register`, `event_at`. |
| SM-12 | main-map wrongly says v1 writes sale_payments | §7 | Noted: v1's problem is the missing ledger, recorded in the reuse table. |
| MR-0 | create_sale_order had no tender whitelist | §0 | Superseded: 030:260-266 now refuses unknown tenders (commit 6560015). |
| MR-1 | v1 deletes on money tables silently dropped | §3.4, §7 | Do-not-port; ingest flags `delete_missing` and never acks silently. |
| MR-2 | v1 011 would replace main's `auth_store_id` | §7 | Do-not-port item 5. |
| MR-3 | v1 re-checkout not serialised | §2.3 | One strict IndexedDB transaction per op with the rule inside. |
| MR-4 | sale movements stamped `now()` | §0 | Superseded: 030:371-375 dates them with the sale; ingest uses `t`. |
| MR-5 | design's 031 plan stale | §4.1 | Rewritten. |
| MR-6 | v1 `cloudMaxInvoice` sorts as text | §2.6, §7 | Seed from `invoice_counter` and numeric max; do-not-port item 8. |
| MR-7 | 030 test file list | §0 | Recorded as the Phase 0 gate (7 files of 25). |
| AS-0 | v1 server has no RBAC | §7 | v1 SQL not ported; server RBAC from 029 kept. |
| AS-1 | v1 unreserved `superadmin` escalation | §2.7, §3.4 | `superadmin`/`register` reserved; refused at ingest. |
| AS-2 | v1 per-window session is shared | §2.7 | Memory-only per-window sessions. |
| AS-3 | v1 `belongsTo` is a no-op | §2.7 | Identity by `users.id`; no name-to-email mapping. |
| AS-4 | `staff_id_problems` leaks across tenants, anon access | §4.1 | Dropped in 031. |
| AS-5 | `link_staff_ids` swap kills sync | §4.1 | Dropped in 031. |
| AS-6 | v2 lost remote staff revocation | §2.7, §4.3 | Owner command channel. |
| AS-7 | v1 never pulled demotions | §2.7 | Not ported; commands replace it. |
| AS-8 | v1 setup matches by name | §4.5, §7 | create-register checks `owner_uid` server-side. |
| AS-9 | design.md:389 understated stolen token | §5 | Threat row rewritten. |
| OU-0 | v1 sign-in shared across windows | §2.7 | As AS-2. |
| OU-1 | v1 offline passwords only work offline | §2.7 | Local-only PIN verification; no cloud check. |
| OU-2 | v1 treats missing claim function as success | §3.9 | Missing RPC is transient, never success. |
| OU-3 | main refuses v1 writes beyond new sales | §1 | Ingest path instead of direct writes. |
| OU-4 | v1 import not serialised with sync | §6.2 | Import under the sync lock with `expectCommitSeq`. |
| OU-5 | v1 fixed DB_VERSION=1 | §2.3 | Versioned upgrade ladder and newer-DB screen. |
| OU-6 | orphan sweep reads sales unpaged | §4.1, §8 Phase 0b | Paged `referenced_image_paths` (031) and 14-day age gate, moved to Phase 0b because it is a live data-loss path for every tenant; `register_only` stores keep orphans. |
| OU-7 | phone-photo listing 7-30 MB/day | §3.10 | No storage listing by the PC; QR removed. |
| OU-8 | design does define a takeover epoch | §6.2-6.4 | Kept; the H8 gaps are closed. |
| OU-9 | Phase 0 net covers only a first checkout | §2.2 | Cloud queue frozen; the register removes all POS network dependencies (zero-fetch test). |
| IC-0 | v1 loses deletes silently | §3.4 | As MR-1. |
| IC-1 | v1 pushes users/roles, revoked on main | §3.6 | Staff and RBAC go through actor-checked writers. |
| IC-2 | v1 011 recreates permissive delete policies | §7 | Do-not-port item 5. |
| IC-3 | Phase 0 lacked 031 and settings change | §4.1, §8 | Phase 0b. |
| IC-4 | stale test baselines | §0 | 299 vitest, 448 assertions in 25 files. |
| IC-5 | photos uploaded before rows; unpaged sweep | §2.9, §4.1 | Upload after ack; paged references and age gate in Phase 0b. |
| IC-6 | v1 had no network backoff | §3.9 | New backoff with jitter. |

### A.4 Other verified v2 problems and review findings

| ID | Finding | Section | Resolution |
|---|---|---|---|
| SM-p9 | `sale_event_time` would re-date multi-day offline sales | §3.7 | Not applied at ingest; time flags instead. |
| MR-p1 | design's re-checkout semantics predate 030 | §2.4, §3.6 | Port uses 030 desired-state deltas; payload carries deltas verbatim. |
| MR-p5 | other RPCs stamp `now()` | §3.7 | Writers stamp `t`; online paths unchanged. |
| AS-p3 | `revoke_register` without store pin | §4.3 | Keyed on `stores.owner_uid`. |
| AS-p4 | actor is the PC's word; owner-attributed abuse unflagged | §2.7, §3.5, §5 | Session ops, `no_session`, seq-conflict quarantine; residual stated. |
| AS-p7 | whole-batch licence refusal strands facts | §3.3 | Never refused for licence; flagged. |
| AS-p8 | `license_feature()` true for a null store | §3.5, §4.4 | `license_feature(p_name)` has no store parameter (027:54-65), so 034 adds `_license_feature_for(p_store, p_name)`, refactors `license_feature` onto it and `_register_flags` calls it with the ingest store; `feature:<code>` flag. |
| AS-p10 | owner verifier seeded from cloud password | §2.7 | New PC PIN at setup. |
| AS-p11 | client licence type lacks `pending` | §2.5 | Added in the cloud build and on the PC. |
| R-1 | weighted cost averages after the trigger (4.67 vs 5.00) | §4.2 | Fixed in 032; 018 G-P4b corrected. |
| R-2 | `contact_lens_types` untenanted and open to anon | §4.1 | Grants revoked in 031. |
| R-3 | `receiptTotals` keeps net = items + 0.01 | §2.4 | Fixed in PR #3. |
| R-4 | browser vs Postgres tzdata skew | §3.2 | `store_day` from `_store_day_range(p_store)` (not the auth-scoped `store_day_range`) in responses; `tz_mismatch` banner and flag. |
| R-5 | public bucket with guessable names | §2.9, §5 | Random register file names; bucket privacy left to the vendor. |
| R-6 | persisted checkouts across the seam refactor | §2.2, §8 Phase 3a | Frozen key and shape; fixture test. |
| R-7 | dropping `settings_key_key` with old tabs open | §4.2 | 7-day gap and every device reloaded. |
| R-8 | `invoice_counter` not advanced for PC numbers | §3.6, §4.3 | Writers and `end_register_mode` bump it. |
| R-9 | `register_ops` retention and index | §4.3, §4.4 | Partial index on status; 400-day payload prune. |

### A.5 Review of revision 2 (gaps and corrected facts)

| ID | Finding | Section | Resolution |
|---|---|---|---|
| G-1 | `current:false` had no reason, so a quarantine or Revoke stranded the genuine PC | §3.3, §3.9, §6.3, §6.4 | `reason` `replaced` → stranded; `quarantined` → diverged; `revoked` → reclaim_required; the last two keep selling. 034 asserts each reason; vitest that the PC keeps selling. |
| G-2 | Re-checkout header UPDATE raised 42501 (`sales_money_guard`), a FAULT hold | §3.6 | Writer contract sets `lensy.money_write` before the header UPDATE, which precedes the ledger inserts, and clears it after (030:622-689 order). 034 re-checkout with a changed total. |
| G-3 | Guard bypass missing in `set_store_owner` and the conversion helpers | §4.3 | Bypass set in those three as well (and in `register_revert_ops`), honoured only for the definer owner. 033 assertions. |
| G-4 | `store_day` used the auth-scoped `store_day_range` (UTC under the register JWT) | §3.2, §4.4 | `_store_day_range(p_store)` on `store_time_zone_for` (025:64-73). 034 Cairo assertion. |
| G-5 | `license_feature` has no store parameter | §3.5, §4.4 | `_license_feature_for(p_store, p_name)`; `license_feature` refactored onto it. 034 `feature:lab` test. |
| G-6 | Commit gating contradicted itself; log kinds unspecified | §1.6, §2.3, §2.5 | Gate in `commit()` step 3 for business kinds (stranded or licence not active); `LOG_KINDS` always commit; `contact_due` named as the second deliberate stop. vitest sign-in on expired and stranded PCs. |
| G-7 | Forged ops stayed applied in the cloud after a conflict | §4.4, §6.3, §4.5 | Dedicated undo log on the guard's tables (not `audit_log`, which covers 12 tables only) and platform-only `register_revert_ops`; `reclaim` refuses while foreign ops exist. 034 revert test. |
| G-8 | "Money kind" never listed | §3.6, §3.8, §4.4 | Explicit `MONEY_KINDS` (10 kinds) in TS and `_register_kind_perms.money`. vitest and 034. |
| G-9 | Missing target was a hold in one sentence and a flag in another | §3.4, §3.6 | One rule per kind in §3.6; blanket sentence removed. |
| G-10 | `staff.create` could hit the per-store username index (INT hold, unskippable) | §2.7 | PC refuses on a `lower(btrim)` match against every mirror user. vitest `'Ahmed '` vs `'ahmed'`. |
| G-11 | 033's global `lower(btrim)` cloud index could abort on cross-store case pairs | §4.3 | Global cloud index kept on exact `username` (what `users_username_key` guarantees today); Auth's case-insensitive emails cover new logins. 033 cross-store fixture. |
| G-12 | `end_register_mode` left active register-local names in place | §4.3, §8 | Deactivates and renames every register-local user. 033 re-add test. |
| G-13 | Orphan sweep vs RESTRICTIVE policy; unpaged sweep is a live data-loss path | §2.9, §4.1, §8 | `register_only` stores keep orphans; paged references and 14-day age gate moved to Phase 0b (031). |
| G-14 | Editing `lensy_storage_all` would hide the owner's photos | §4.3 | Policy left unchanged; RESTRICTIVE policy blocks writes. 033 owner SELECT assertion. |
| G-15 | Vendor data migrations break cloud = PC | §4 preamble, §5 | Migrations never modify `register_only` stores; corrections ship as ops or commands. 033 `postgres` update refused. |
| G-16 | Parked 034 collides with hotfix numbering | §4 preamble, §8 | Hotfixes take the next free number; the ingest migration is renumbered at apply time with its stamp, tests and the register's EXPECTED value. |
| G-17 | Seat-count phase, §0 item 1 wording, A.1 C3 section | §0, §4.5, §8, A.1 | Active seats in 0b, 409 in 033; §0 item 1 lists the body changes; C3 cites §4.3. |
| G-18 | Writer count not checkable | §3.6, §4.4 | 23 writers named in §4.4; 034 asserts every kind has a writer and an ok test. |
| G-19 | Restore `+1000` can collide after > 1000 acked sales | §6.2, §2.6, §4.5 | `invoiceNext` raised to cloud max + 1 at re-claim; colliding unsent sales renumbered and flagged `invoice_renumbered`. vitest with 1,200 sales. |
| G-20 | Bandwidth assumed one photo per order | §3.10, §3.9, §8, §9 | 1-2 photos per order (85-160 MB); pilot exit bounds non-photo bytes and measures photos. |
| F-1 | `license_feature` called "with a store" (§3.5, AS-p8) | §3.5, A.4 | Corrected (see G-5). |
| F-2 | v1 `withLock` "refuses without locks" | §7 | Corrected: v1 runs unlocked (`v1:db.ts:199-200`); verdict Rework. |
| F-3 | §0 "029/030 RPC bodies untouched" | §0 | Corrected (see G-17). |
| F-4 | 031 "conkey (030:79-84 idiom)" | §4.1 | Corrected: 030 drops by name (030:84); the conkey lookup is new. |
| F-5 | `CHECKOUT_MUTATION_KEY` at queryClient.ts:50-56 | §2.2 | Corrected: defined at offlineMutations.ts:34, registered at queryClient.ts:53. |
| F-6 | Compression sizes attributed to storage.ts:26-42 | §2.9 | Corrected: today 1600 px q 0.82; 1280/1024 is the Phase 4 change. |
| F-7 | `lensy_storage_all` "write branches" | §4.3 | Corrected (see G-14). |
| F-8 | repositoryLocal "read" ranges contained writes | §7 | Read ranges narrowed; the writes listed as not ported (item 12 widened). |
| F-9 | v1 verifier "600k, Keep" | §2.7, §7 | Corrected: v1 is 150,000 (`localAuth.ts:21`); verdict Rework. |
| F-10 | A.1 C3 cited §4.1 for usernames | A.1 | Corrected to §4.3. |
| F-11 | `store_day_range` gives the register the store's day | §3.2 | Corrected (see G-4). |
