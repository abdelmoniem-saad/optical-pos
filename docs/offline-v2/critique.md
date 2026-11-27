REVIEW OF "LensyPOS offline-first register on top of main (cf78ca5)". Read-only review against the working tree (offline-first-v2 = origin/main). Paths are relative to web/ unless they say otherwise.

Overall: the direction is right. Option 2, an ordered op log, a non-staff register principal, server-enforced register_only, per-store uniques and the Phase 0 money fixes all hold up. But several claims are false against the real code, and three problems would break the build or kill sync outright. Findings are ordered by severity.

====================================================================
CRITICAL (must change before building)
====================================================================

C1. The resolve_can change in §3.3 breaks every restrictive RLS policy and makes calls ambiguous.
- Why:
  - The 029 action policies call `public.resolve_can('<code>')` inside RLS. That means the 2-argument function `resolve_can(text, uuid default auth.uid())` (029:52-71), evaluated as the querying role `authenticated`. Sites: 029:210-240, and the staff policies at 014:251,256.
  - Revoking EXECUTE on `resolve_can(text,uuid)` from `authenticated` (granted at 014:526) therefore makes every customers/inventory/suppliers/purchases/notes/settings/metadata/stock_movements write fail with "permission denied for function". This hits the cloud build for other stores too.
  - Adding a 1-argument `resolve_can(text)` next to a 2-argument version with a default makes one-argument calls ambiguous in Postgres. In PostgREST it gives PGRST203; create-user calls `rpc('resolve_can', {p_code})` at supabase/functions/create-user/index.ts:72-73.
- Fix:
  - Do not overload and do not revoke. Keep the signature.
  - Add a store check to the body: when `p_user <> auth.uid()`, require `user_store(p_user) = auth_store_id()`. That closes the cross-tenant leak.
  - Add a separate internal `_resolve_can_for(code, actor, store)` with a different name, revoked from clients.
  - Test: rerun the 029 restrictive-policy assertions after 032.

C2. Server-side recomputation and defaults are keyed on auth_store_id(), which is NULL for the register principal.
- Why:
  - `close_shift` takes its store from `auth_store_id()` (024:133) and calls `z_report`. `z_report` scopes through `report_window` (023:124-126, 016 ~200), which uses `auth_store_id()`.
  - `store_time_zone()` (016:170-179), `store_day_range`, `next_invoice_no` (012:146), `license_write_ok(auth_store_id())` call sites (029:271,805), the `audit_row` store fallback (014:93-99) and the `tenant_fill_store_id` trigger (008:240-247) all depend on it as well.
  - Consequences under the register JWT:
    - the server's "recomputed z_report" returns zeros, so every shift.close is flagged as a mismatch;
    - any impl insert that forgets an explicit store_id gets store_id NULL. Under the tenant read policy (008:305-309) such a row is invisible to the phone, so it is silently lost from every report.
- Fix:
  - Store-parameterised internals: `_report_window(p_store,…)`, `_z_report(p_store,…)`, `_store_time_zone(p_store)`.
  - Or set a transaction-local `lensy.store` GUC inside register_ingest and resolve it in an `effective_store()` helper that these functions use, guarded the same way as `effective_actor`.
  - Add a 033 test asserting zero NULL-store rows after ingesting every op kind. Consider `store_id NOT NULL` on synced tables.

C3. The hold and skip rules can deadlock sync permanently.
- Why:
  - There is one global gapless seq, and anything held blocks everything behind it.
  - §2.2 holds master data (customer, product, supplier, purchase) on a permission failure and makes it non-skippable, so one port bug in perms.ts stops all money sync until a vendor release.
  - Management ops are skippable, but money ops depend on them. If `staff.create` is skipped, the next sale by that cashier fails the `sales.user_id` FK, which is a hold on a money op, and money ops are never skippable. Sync is dead.
  - `staff.create` will hold in practice: `users.username` is UNIQUE across all tenants (000:51). A cashier named "ahmed" collides with any other store's "ahmed". The PC cannot check this offline.
  - `max_staff` "counted in SQL" can also disagree with the PC. The ingest piggyback does not even send max_staff (see M2).
- Fix:
  - Never hold on policy for anything the PC already committed: flag it.
  - Hold only on DB integrity failures (CHECK/FK/unique) and on malformed payloads.
  - Register-local staff must never collide on username. Either make uniqueness partial (unique where `password_hash <> 'register-local'` is excluded) plus per-store unique, or store the cloud username as `<store8>.<username>`. Make max_staff a flag.
  - Allow Skip only when no later outbox op references the entity (the PC checks dependencies), or have the server create a placeholder `users` row on a missing actor and flag it.
  - Add a vendor "accept and flag" override for held money ops.

====================================================================
HIGH
====================================================================

H1. The core premise "cloud state before op N equals PC state" is false in four places.
- Platform-admin writes are exempt: `store_write_ok` has `or is_platform_admin()`. PlatformPage writes stores, roles, role_permissions and the permission catalogue (data report §10). These diverge from the PC with no down-sync.
- The create-user Edge Function checks only `license_write_ok` (create-user/index.ts:74), not `store_write_ok`. The owner can create cloud staff from the phone, which the PC never learns about. This also skews the seat count and makes the PC's staff.create hold (C3).
- The setup snapshot runs under the owner's session, so RLS-limited rows never come down. Notes private to other users are hidden even from an admin (029:821-823). A later `note.upsert` or `note.delete` on such a note then hits a missing row.
- Skipped ops and vendor data migrations also break the equality.
- Fix:
  - Under register_only, platform admins may write only the licence tables for that store.
  - create-user refuses when register_only is set, except inside the setup flow.
  - Take the snapshot through a register-scoped SECURITY DEFINER export RPC (keyset paged), not the owner's RLS view.
  - Pin and compare the permission catalogue (`supported_permissions()` version) in the ingest response.

H2. "The phone UI degrades on its own" is false.
- Why: the UI gates on `perms.isAdmin || perms.can(...)` in many places:
  - VoidSaleButton.tsx:30
  - SalePayments.tsx:66
  - HistoryPage.tsx:241,277
  - SettingsPage.tsx:20
  - OpticalSettings.tsx:215
  - ExamSection.tsx:353
  - NotesPage.tsx:221
  - StaffPage.tsx:57,204,209

  `useIsAdmin` reads the role name from the polled current-user row (data/staff.ts:31-34; used at CustomersPage.tsx:96 and MUploadPage.tsx:28). The owner is admin, so every write button stays visible and then fails.
- Fix: when register_only, `my_permissions()` returns `is_admin=false` plus a `read_only=true` field. `useIsAdmin` is derived from perms, not from the role name. With that, the separate VITE_READ_ONLY build and the `lensy-phone` site are unnecessary (see OE2).

H3. A stolen register token can do more than §3.6 claims.
- Owner lockout:
  - The token can forge `staff.create` (actor = owner) with an admin role, which `_staff_create` allows because `is_store_admin(actor)`.
  - Using that new admin as the actor, it can `staff.set_access` the owner to inactive or demote him. The self-guard (029:175) does not apply because the actor is not the target.
  - The owner's `auth_store_id()` becomes NULL (029:74-79), so `revoke_register` (`is_store_admin()`) is no longer callable from the phone. The kill switch is lost.
- Photo wipe: the proposed storage DELETE policy on `store/<id>/orders/%` lets the token delete every photo of the store.
- Seq DoS: forged ops consume seq numbers, so the real PC's next ops become "conflict, held".
- Fix:
  - Ops from the register path must not change any `users` row that has a cloud login (an auth.users row exists). Flag and hold those ops.
  - `revoke_register` must also be callable by the platform admin, and by the owner without depending on rows the register can edit (e.g. a `stores.owner_uid` column).
  - Drop register storage DELETE. Leave replaced or voided photos as orphans for the age-gated sweep, or delete through an RPC that checks the path is unreferenced and belongs to this store.
  - On a seq conflict, show "register token misuse suspected" on the phone.

H4. Invoice allocation timing contradicts main's UI.
- Why: §2.4 allocates the invoice inside the sale's commit. Main needs the number at cart entry:
  - POSContext.tsx:345-363
  - the photo path embeds it: uploadOrderImage(file, invoiceNo, …) at storage.ts:50-67, called from ExamSection.tsx:373
  - the QR URL at ExamSection.tsx:317
- Fix: allocate at cart entry in its own IndexedDB transaction (gaps are fine, the server keeps `greatest`) and persist it in `drafts`.
- Also: 031 drops the global unique, but `create_sale_order` still checks `exists(select 1 from sales where invoice_no = v_inv)` across ALL stores (029:334-340). It must become per-store, or the online path keeps renumbering (H12 survives).

H5. Clock handling can trap the shop.
- Why: `eventNow() = max(Date.now(), clockHigh)`.
  - If the PC clock was ever ahead (BIOS battery, wrong year, a timezone slip), every later sale, payment and close is stamped in the future until real time catches up. Store-day and Z windows are wrong.
  - The licence evaluated against that future time can mark the store expired, which blocks selling. There is no recovery path.
- Fix:
  - Stamp events with Date.now().
  - Use clockHigh and last_server_now only for licence rollback detection: block only when the clock is earlier than last_server_now minus the skew.
  - Warn when the clock is ahead, and give the admin an "accept server time" reset driven by server_now from the last contact.

H6. Floating-point money in the TypeScript rules engine.
- Why: SQL uses `numeric(10,2)` (011:48) with 0.01 tolerances and PG `round()`. A JS float port of `price_cart` (013:259-357), the ceilings and z_report will drift. Under §2.4 a header mismatch is a HOLD on an unskippable money op.
- Fix: integer minor units throughout `rules/`, and PG-compatible rounding (half away from zero). Add parity cases for rounding edges.

H7. Void and refund payloads re-derive amounts on the server.
- Why:
  - `sale.void` sends only `refund_ids{method:id}`, and the server computes the amounts.
  - Method normalisation differs across main: create and update lowercase and trim (029:398, 545); refund stores `p_method` verbatim and compares case-sensitively (028:143-151); legacy collapsed methods like "cash + instapay" exist from H1.
  - So the PC's set of methods can differ from the server's: a missing id, or different amounts, means hold or silent divergence.
- Fix (the PC is truth): payloads carry the derived rows verbatim:
  - void: `refunds:[{id, method, amount}]` and `restock:[{id, product_id, qty}]`
  - refund: `{id, method, amount}`

  The server checks invariants (per-method sum ≥ 0, `amount_paid` ≥ 0 per 012:187, `voided_at` null) and flags any difference from its own derivation. Normalise methods on the PC with one function and test it.

H8. Backup restore and takeover hazards.
- Why:
  - Restoring an older backup on the same register (no epoch change) rewinds `nextSeq` below `last_seq`. Every new op then hits "same seq, different op_id, held", so sync is dead.
  - Ops acked after the backup exist only in the cloud. The system of record silently lost them.
  - A takeover (a second browser profile, or a new PC) strands the old PC's unsynced ops once `register.current=false`, with no recovery path.
- Fix:
  - Every restore performs a takeover (new epoch).
  - Re-hydrate the gap from `register_ops.payload` (already stored) through a register-scoped `register_export_ops(from_seq)`, or restore from cloud.
  - `create-register` refuses a takeover while `pending_reported > 0` unless forced.
  - A stranded PC can export its unsynced ops to a file that an admin ingests with new seq numbers.

H9. A browser profile as the system of record.
- Why:
  - "Clear browsing data", a profile reset, an origin change (renaming the Render domain) or service-worker cache eviction either destroys unsynced data or stops the app from booting offline. `storage.persist()` only stops automatic eviction.
  - The "automatic daily backup via File System Access" needs the permission re-granted after a restart unless the PWA is installed and Chrome's persistent permission is granted.
- Fix:
  - Install the register as a PWA on a fixed origin.
  - Require `navigator.storage.persisted()` at setup.
  - Back up at each shift close (a user gesture is available then).
  - Show the unsynced count and age prominently.
  - Document this risk for the owner.

====================================================================
MEDIUM
====================================================================

M1. FK re-point (032).
- The existing `sale_payments.recorded_by` default `auth.uid()` (011:52) stays. Under the register JWT any insert that omits it gets the register uid, which then fails the FK. That is good because it fails loudly, but every impl must pass the actor. Add a test.
- Add the FKs `NOT VALID`, check for orphan recorders first, then VALIDATE.
- Correction to the design: platform admins cannot void or refund today (014:352-355 and 028:112-115 raise when `auth_store_id()` is null), so the re-point does not break vendor support.

M2. Licence piggyback.
- The response returns `{state, starts_at, expires_at, revoked}` only. It lacks plan, max_staff and features (027:54-65), which perms.ts and staff.create need.
- §2.1 says "nothing runs when the outbox is empty", which contradicts the idle-day ping. An expired PC with an empty outbox would never learn it was renewed.
- Fix: ping once a day when online regardless of the outbox, add a "Check licence" button, and add the missing fields.

M3. Register session handling.
- supabase-js with `autoRefreshToken` in several windows sharing storage causes refresh-token reuse, which revokes the session and kills sync.
- Fix: only the sync worker under the Web Lock holds the register session, with `autoRefreshToken:false`, custom IndexedDB storage and lazy refresh. On an invalid refresh token, re-sign in with the stored register password.

M4. Batch time budget.
- PostgREST requests run under the `authenticated` statement_timeout (about 8 s on Supabase). A 200-op batch, with price locks, audit triggers and z_report recompute per close, can time out after a long offline period. The whole request then rolls back and retries forever.
- Fix: a server time budget (stop at about 3 s on `clock_timestamp()` and return `acked_seq`), and adaptive batch size on the PC. Test with a 2,000-op backlog.

M5. The design does not say what happens to these main behaviours:
- Main deletes photos after a void (data/sales.ts:1192-1197). Recommendation: keep them and let the age-gated sweep handle them.
- The QR / MUploadPage / findOrderImages flow breaks under register_only. Remove QR from the register build (ExamSection.tsx:317, HistoryPage.tsx:220).
- `syncExamReferences` deletes inventory (metadata.ts:251). On the server that delete is a silent no-op (inventory delete is `false`, 029:215), but a faithful local port would delete the row on the PC and diverge. There is no inventory-delete op kind. Do not port that delete.

M6. H3 fix changes what `sales.discount` means.
- After the fix, the header discount includes line discounts. Client `computeTotals` treats gross as items minus line discounts with the discount kept separate (features/pos/pricing.ts:25-37). OrderReceiptDialog.tsx:70-73 reprints from the header.
- Result: a reprinted receipt shows a different gross and discount than the one printed at the sale.
- Fix: define one representation, then change price_cart, pricing.ts, the PC port and the receipt together, with tests.

M7. Photo blobs kept forever in IndexedDB.
- At about 90 KB × 30 a day that is about 1 GB a year, which bloats backups and quota.
- Fix: keep a local thumbnail and drop the full blob N days after the upload is acked. The owner decides the trade-off, because old full-size photos then need the internet.

M8. Smaller corrections.
- `lensy.flags` set with `set_config(…, true)` is reverted when a savepoint rolls back. Reset it per op and read it before release.
- `sale.refund` payload `payment_id` is ambiguous. Name it `refund_row_id`.
- The `shift_closes` unique window is cited as 023:84; the constraint is at 023:89-91.

====================================================================
BANDWIDTH
====================================================================

- The budget (about 80 MB a month) is plausible, and photos dominate it.
- Return per-op results only for non-ok ops.
- Explicitly set `autoRefreshToken:false` (supabase-js refreshes on a timer otherwise).
- On the PC, cache an old photo after its first online view. Re-downloading it from the public URL each time wastes quota.
- If the owner's phone joins the shop Wi-Fi, it spends shop quota:
  - Reports' `useSalesSummary` downloads every sale header (sales.ts:244-259);
  - `useCustomers` downloads every customer (customers.ts:9-22);
  - the 15 s polls (permissions.tsx:68, staff.ts:24).

  Remove the polls on every build and page the phone's report reads.

====================================================================
OVER-ENGINEERING FOR ONE STORE AND ONE PC
====================================================================

OE1. The `_impl` + `p_mode` refactor of about 30 audited functions is high-risk and does not deliver "one code path".
- `price_cart` must branch between PC prices and catalogue prices, `now()` versus `t`, raise versus flag, and server ids versus PC ids. Each function forks internally while the online path is put at risk.
- The PC is the truth, so register mode decides nothing. Better:
  - Leave the online RPCs untouched apart from Phase 0.
  - Add small `_ingest_<kind>` writers that insert the PC's rows verbatim (explicit store_id, actor, timestamps, ids), set `lensy.money_write`, let the cache triggers run and enforce DB invariants.
  - Add one `_register_flags(kind, actor, store, payload)` evaluator that uses `_resolve_can_for`.
- The 365 SQL assertions then remain valid without a refactor, Phase 1 shrinks, and the golden parity test still guards correctness.

OE2. Three builds and three Render sites are not needed. With H2's `read_only` flag, the existing lensy-web site serves the phone, so `lensy-phone` and VITE_READ_ONLY can go.

OE3. Event-time licence (`license_write_ok_at`, `revoked_at` history) only produces flags. Replace it with a simple flag when `t` is outside `[starts_at, expires_at)`.

OE4. Changing `link_staff_ids` and `staff_id_problems` is pointless: `link_staff_ids` is only ever called in 015.

====================================================================
MISSING TESTS
====================================================================

- Existing restrictive-policy assertions still pass after the 032 resolve_can change (C1).
- z_report and close recompute under the register JWT give correct, non-zero figures; no NULL-store rows after ingesting each op kind (C2).
- Skip-dependency deadlock; cross-tenant username collision on staff.create; max_staff disagreement (C3).
- Platform-admin and create-user writes refused under register_only; snapshot completeness for private notes (H1).
- Phone UI with an admin owner hides write controls (H2).
- Forged-actor owner lockout refused; register cannot delete storage objects (H3).
- Invoice allocated at cart entry survives a reboot; online create_sale_order no longer renumbers on another store's number (H4).
- Clock ahead and then corrected; rollback detection (H5).
- Rounding-edge parity TS against SQL (H6).
- Void after partial refund with mixed-case and collapsed methods (H7).
- Backup restore below `last_seq`; takeover with pending ops (H8).
- A 2,000-op backlog within the statement timeout (M4).
- Licence renewal learned with an empty outbox (M2).

====================================================================
VERDICT
====================================================================

The design is not yet sound enough to start Phases 1 to 4. The model is sound; C1 to C3 and H1 to H9 must change first.

Must change before building:
1. The resolve_can approach (C1).
2. Store-parameterised server internals or a `lensy.store` GUC (C2).
3. Hold only on integrity failures, flag everything else, and fix the cloud username scheme for register-local staff (C3).
4. Close the platform-admin, create-user and snapshot gaps under register_only (H1).
5. Read-only through `my_permissions` with `is_admin=false` (H2).
6. Register token limits: no edits to cloud-login users, no storage delete, a revoke path the register cannot disable (H3).
7. Allocate the invoice at cart entry, and make 029:334-340 per-store (H4).
8. The clock model (H5).
9. Integer money (H6).
10. Verbatim derived rows in the payloads (H7).
11. Restore and takeover protocol (H8).
12. Commit to OE1 (thin ingest writers instead of the `_impl`/`p_mode` refactor).

Can start now: Phase 0 (030 money fixes and the H5–H7 client fixes). 031 can ship with it only if it also changes the global invoice check at 029:334-340.

The 49–72 developer-day estimate looks optimistic for Phase 3: 24 modules, about 118 `.from()` and 34 `.rpc()` call sites, behind a new seam.
