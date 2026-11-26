# LensyPOS offline-first register on top of `main` (cf78ca5): design

This is a read-only design. Paths are relative to `D:/Projects/optical-pos/optical-pos/web/` unless they start with `supabase/functions`. Citations point at the latest definition of each function. I spot-checked these against the working tree: `029:246-408`, `013:335-357`, `014:385-405`, `012:105-166`, `019:76-104`, `023:58-88`, `014:61-111` and `create-user/index.ts:128-136`.

**Two corrections to the input reports:**
- `refund_sale` is defined at `028_partial_refund.sql:96-169`. Line 288 does not exist; the file has 177 lines.
- `public.users.id` has no foreign key to `auth.users` (`000:49-57`). Cashier rows with no cloud login are therefore possible today.

---

## 0. The core decision (option 2: the PC is the system of record)

**Model: an ordered event log with a trusted ingest path that reuses the server's own rules.**

1. **What happens on the PC.**
   - The PC runs a TypeScript port of every server money and RBAC rule against IndexedDB.
   - Each user action commits its rows and one outbox op in a single IndexedDB transaction.
   - Each op is `{seq, op_id, kind, actor, occurred_at, payload}`.
   - `seq` is gapless.
   - The payload carries every id the PC created, the PC's invoice number and the PC's timestamps.
2. **What the cloud does with the log.**
   - The cloud applies the log strictly in `seq` order through one SECURITY DEFINER RPC, `register_ingest`.
   - `register_ingest` dispatches each op to an internal `_impl` function.
   - The existing public RPCs (`create_sale_order`, `void_sale` and the rest) become thin wrappers over those same `_impl` functions.
   - So there is one SQL code path for every money rule. The online path passes `(auth_store_id(), auth.uid(), now(), server ids, mode 'online')`. The register path passes `(store, actor, occurred_at, PC ids, mode 'register')`.
3. **Why ordering makes this safe.** The register is the only writer: `stores.register_only` blocks everything else. Because ops are applied in exact order, the cloud's state before op N equals the PC's state when op N happened. That holds for catalogue prices, stock, the ledger, RBAC and settings. So the server can re-run its rules **as of event time** by evaluating them at replay time. This removes H8, H9, H10 and H12 by construction.
4. **Facts versus rules versus caches.**
   - **Facts are stored verbatim:** who did it, when, the invoice number, the lines and prices, the tenders, and the counted cash.
   - **Arithmetic and ledger invariants are always enforced.** A violation holds the queue; this would mean a bug.
   - **Policy checks become accept-and-flag for money facts.** These are permission, catalogue price, negative stock and licence-at-event-time. The goods or cash already moved, so rejecting the op would only hide the truth.
   - **The trigger caches recompute as they do today:** `stock_qty` and `amount_paid`.
   - **Where the server's recomputation differs from the PC's value,** both are stored and a mismatch is flagged. This covers Z-report expected cash and weighted-average cost.
5. **The owner's phone** is main's cloud build in read-only mode. The server enforces read-only through `register_only`, not just the build.
6. **Selling never depends on the network.** Sync failures only delay the phone view.

---

## 1. Architecture

### 1.1 Three builds, one codebase

| Build | Flags | Who uses it | Data |
|---|---|---|---|
| Register | `VITE_DATA_MODE=register` | The shop PC | IndexedDB, plus the sync worker |
| Cloud | `VITE_DATA_MODE=cloud` (default) | Other stores on today's online app, and the vendor's `/platform` | Supabase, main unchanged apart from the Phase 0 fixes |
| Phone | `VITE_DATA_MODE=cloud VITE_READ_ONLY=1` | The owner | Supabase, read only |

- Build flags and a check against misspelled flags are ported from `ref:web/src/lib/config.ts:16-54` and `ref:web/vite.config.ts:11-30`.
- `render.yaml` gets three sites: `lensy-web`, `lensy-register` and `lensy-phone` (reference branch).
- The register build uses `registerType: 'prompt'` instead of `autoUpdate` (`vite.config.ts:11-41`). Updates are downloaded only when an admin taps "Update", and never while a draft or held op exists. This saves quota and keeps the local schema and the build in step.

### 1.2 The data seam

- Main has no seam today. 17 modules in `src/data/` and 7 others import `lib/supabase.ts` directly.
- **Shape of the seam:**
  - New interface `src/data/backend/types.ts` (`Backend`), grouped by area: customers, inventory, sales, payments, zreport, reports, suppliers, metadata, exams, notes, search, settings, staff, permissions, licence, storage.
  - `src/data/backend/cloud/*.ts` holds the current `queryFn`/`mutationFn` bodies, moved verbatim from `data/*.ts`.
  - `src/data/backend/local/*.ts` holds the register implementation.
  - The hooks in `data/*.ts` keep their names and query keys and call `backend.<area>.<fn>`.
- **Selection** is a static alias `@backend`, resolved by a Vite `resolveId` plugin, using the same pattern as `qa/vite.config.ts:8-10`. The phone and cloud bundles therefore contain no IndexedDB code.
- **Parity:** `local/index.ts` is checked with `satisfies Backend`, so TypeScript forces both sides to match.
- **Direct Supabase calls that must move behind the seam:**
  - `features/pos/POSContext.tsx`: `enterAfterCustomer` :344-364, `findOrCreateFrame` :431-469, `quickAdd` :494-512, `loadSale` :692-789, `findOrderImages` :588-594. The `from('products')` bug at :737 is fixed while moving it.
  - `features/staff/StaffPage.tsx:31`
  - `features/mobile/MUploadPage.tsx`
  - `lib/licensing.ts`, `lib/schemaVersion.ts`, `lib/storage.ts`, `data/staff.ts:26-30` (`resolveStaffUserId`)
- **TanStack Query on the register build:**
  - `networkMode: 'always'` for queries and mutations. The default `'online'` pauses everything while `navigator.onLine` is false.
  - No `PersistQueryClientProvider`, no `refetchInterval`, and no `offlineMutations.ts`.
  - Local commits invalidate queries via `commitSeq` and a BroadcastChannel, ported from `ref:web/src/lib/local/db.ts:174-186`, using main's invalidation groups (`data/refresh.ts:4-18`).

### 1.3 The local store on the PC (IndexedDB `lensy-register`)

**`src/lib/register/db.ts`** is a port of `ref:lib/local/db.ts` with two changes:
- a real versioned upgrade ladder keyed on `oldVersion`, with constant `LOCAL_SCHEMA_VERSION`;
- money commits use `db.transaction(stores, 'readwrite', { durability: 'strict' })`, so a power cut after the "Saved" message cannot lose the sale.

**Mirror stores.** Key is `id` unless stated. Each line gives the store and its indexes.
- `customers`: name_lc, phone, created_at
- `inventory`: sku_lc (unique per store), name_lc, category. It keeps `stock_qty` as a local cache updated in the same transaction as the movement.
- `stock_movements`: product_id, ref_no, created_at
- `sales`: invoice_no (unique), order_date, customer_id, lab_status, idempotency_key. It includes `kind`, `voided_*` and `lab_*_at`.
- `sale_items`: sale_id, product_id. It includes `discount` and `discount_reason`.
- `sale_payments`: sale_id, paid_at
- `order_examinations`: sale_id
- `shift_closes`: from_at
- `suppliers`; `purchases` (supplier_id); `purchase_items` (purchase_id); `purchase_payments` (purchase_id)
- `lens_types`, `frame_colors`, `frame_types`
- `notes`: user_id, created_at
- `note_seen`: local only, never synced
- `settings`: key
- `users`, `roles`, `role_permissions` (role_id), `user_permissions` (user_id), `permissions` (the catalogue)

**Control stores:**
- **`outbox`.** The key is `seq`. It is allocated from `meta.nextSeq` inside the same transaction. Do not use IndexedDB `autoIncrement`: generator values are not guaranteed gapless across aborted transactions, and the server refuses gaps.
- **`images`.** The key is the storage path. Fields: blob, status `pending|uploaded|delete_pending`, attempts.
- **`meta`.** Holds: `store` (id, name, time_zone, allow_negative_stock), `license` (state, plan, starts_at, expires_at, revoked, features, last_server_now), `register` (register_id, epoch, ackedSeq, session), `nextSeq`, `invoiceNext`, `clockHigh`, `commitSeq`, `bytesThisMonth`, `heldSeq`/`heldError`, `flagCount`.
- **`credentials`.** PBKDF2 verifiers per user, ported from `ref:localAuth.ts:91-140`. They are never synced or exported.
- **`drafts`.** The POS draft per user, keyed by its idempotency key. It replaces the sessionStorage draft (`lib/posDraft.ts:39`), which does not survive a reboot.

**Invariant:** a single `commit(mutator)` (port of `ref:db.ts:240-300`) runs the rule, writes the rows, appends the outbox op, and bumps `commitSeq` and `clockHigh`, all in one transaction. Nothing inside it may await a non-IndexedDB promise; any `crypto.subtle` work happens before the transaction opens.

### 1.4 Local rules engine (`src/lib/register/rules/`)

These are pure TypeScript ports. The SQL source is the specification, and the SQL tests are the oracle.

| File | Port of |
|---|---|
| `pricing.ts` | `price_cart` (`013:259-357`), with the H3 fix from §3 |
| `sale.ts` | `createSale` (029:246-408); `recheckout` (029:410-562 with the new append-only semantics); `voidSale` (014:338-408 with the H4 fix); `refundSale` (028:96-169); `collectPayment` (029:800-817, method whitelist `cash|wallet|instapay|card`); `setLabStatus` (029:748-756 plus the `lab_status_stamp` rules 019:76-104); `updateHeader` (whitelist from `guard_sale_access` 029:774-793); `replaceExams` (029:758-770) |
| `zreport.ts` | `z_report` (023:112-169) and `close_shift` (024:121-182) |
| `time.ts` | `store_time_zone` (setting `time_zone`, then `stores.time_zone`, then UTC; 016:165-179) and `store_day_range` (016:184-194), using `Intl.DateTimeFormat` with `timeZone` |
| `perms.ts` | `resolve_can` (029:52-71), `is_store_admin` (029:44-50), the staff guards (029:93-182) and `authz.ts` rules (superadmin reserved, password ≥ 6, `max_staff`) |
| `license.ts` | the 026:42-103 state machine, including `pending` |
| `purchases.ts` | `receive_purchase` (029:589-675), weighted-average cost |
| `reports.ts` | `report_sales_window` (022:272-311), payment mix, top customers, voided count (016), `customer_balance`/`customer_debtors` (018:166-260), `lab_queue` (019:117-148), `search_text` (016:264-295, with `%` and `_` escaped) |
| `invoice.ts` | 6-digit zero-padded allocation as in 012:151-165 |
| `clock.ts` | `eventNow() = max(Date.now(), meta.clockHigh)` |

**Reads offline:** every list, search and report runs from IndexedDB indexes. The search keeps in-memory lower-cased arrays, rebuilt on `commitSeq` change; about 5k customers scan in milliseconds.

### 1.5 Identity on the PC

- **Staff sign-in is local only.** It uses PBKDF2 verifiers, ported from `ref:localAuth.ts:67-140`, with a per-window session.
  - Drop the online-first check with its 6-second timeout (`ref:localAuth.ts:166-184`).
  - Drop `ensureStaffRecord` (`ref:auth.tsx:189-246`).
- **Who may sign in:** `is_active` and a role in the same store (029:74-79).
- **Every op carries `actor` =** the signed-in `users.id`.
- **`PermissionsProvider` on the PC** returns the same `{is_admin, active, assigned, codes}` shape as `my_permissions` (029:81-89), computed by `perms.ts`. There is no network and no 15 s poll (`data/permissions.tsx:68`, `data/staff.ts:24`).
- **Cashiers without cloud logins.** They are created on the PC with a PC uuid, `password_hash='register-local'` and a local verifier, and replicated through the `staff.create` op. Only the owner keeps a cloud login (Supabase Auth, id = `users.id`).
- **The register's own cloud identity** is a non-staff principal (§3.4). Staff never use it.

### 1.6 The read-only phone view

- **Cloud build with `VITE_READ_ONLY=1`.**
  - It hides write controls; it already gates on `perms.can`.
  - It removes `refetchInterval` from `my-permissions` and `current-user`. Permissions are fetched once per session plus on focus, with `staleTime` 5 min.
  - Lists use the existing paged hooks.
- **Server enforcement.**
  - `stores.register_only = true` makes every direct write and public write RPC fail for the store (§3.5).
  - `my_permissions()` returns only `*.view` codes, so the UI degrades on its own.
- **New phone screens:**
  - A freshness banner from RPC `register_status()`: last ingest time, acked seq, pending count reported by the PC, held error, flag count.
  - A "Flags" page from RPC `register_flags(p_limit)`. It lists ops accepted with violations, for example "Refund by Ahmed without history.refund".
- **Reports on the phone use main's server RPCs unchanged.** They are now correct because every row carries its event time and its real actor.

---

## 2. Replication strategy per operation

### 2.1 Envelope, ordering and retries

**PC to cloud request:**
- `rpc('register_ingest', {p_register, p_epoch, p_protocol, p_pending, p_ops})`
- `p_ops` is an array of `{s: seq, i: op_id, k: kind, a: actor, t: occurred_at, p: payload}`.
- Short keys are used and nulls omitted. A batch is at most 200 ops or about 64 KB.

**Response:**
`{acked_seq, server_now, results:[{s, st:'ok'|'dup'|'flagged'|'held', v?:[violations], e?}], license:{state, starts_at, expires_at, revoked}, register:{current, epoch}, min_protocol, flags_total}`

**How the server processes a batch:**
1. Lock the `store_registers` row `FOR UPDATE`; this serialises ingest.
2. Check that `auth.uid() = register_uid`, that `revoked_at` is null and that `epoch` matches. Otherwise return `register.current=false` and apply nothing.
3. Check `p_protocol >= min_protocol`. Otherwise return `upgrade_required`.
4. If `license_read_ok(store)` is false (revoked, or past the 30-day grace), refuse the whole batch with `license`.
5. Apply each op in order:
   - **`s <= last_seq`:** the stored `op_id` must equal `i`, and the result is `dup`. A different `op_id` means a conflict, and the op is held.
   - **`s ≠ last_seq + 1`:** stop and return `acked_seq`; the PC re-sends from the gap.
   - **Otherwise,** inside `BEGIN … EXCEPTION` (a savepoint per op):
     - set the transaction-local GUCs `lensy.actor`, `lensy.event_at` and `lensy.register`;
     - dispatch on `k`, the op kind, to the matching `_impl`;
     - insert into `register_ops`;
     - set `last_seq = s`.
   - **On exception:** roll back to the savepoint, write `held_seq`/`held_error` on `store_registers`, stop, and commit everything applied before.
6. Stamp `last_ingest_at`, `pending_reported` and `last_server_contact`.

**PC drain** (port of `ref:sync.ts:344-424`, with the row-upsert parts dropped):
- One Web Lock so only one window syncs (`ref:db.ts:194-205`).
- **Trigger:** a commit with debounce, the `online` event, or app start. Nothing runs when the outbox and the image queue are empty.
- **Network failure:** back off 30 s, 1 m, 2 m, 5 m, 10 m, then 30 m at most.
- **Lost response:** re-send; the server answers `dup`.
- **`held`:** the badge turns red and the PC stops automatic retries, apart from one retry per day and on "Retry now". Selling continues.
- **Admin "Skip":** allowed only for kinds marked skippable in §2.3 (metadata, note, setting, role or permission). It sends op kind `noop` with the same `seq` and `op_id` plus `{skipped_kind, reason}`, so the cloud log still records the skip.
- **Money ops are never skippable.** They are fixed by a server migration or a PC build update.

**Time bounds checked by the server** (violation is flagged, not rejected):
- `t <= server_now + 10 min`
- `t >= claimed_at - 10 min`
- `t >= previous op's t - 5 min`

The PC shows a "fix the PC clock" banner when `|server_now - Date.now()| > 5 min`.

### 2.2 Policy by class

| Class | On permission, price, stock or licence failure | On invariant failure, missing referenced row, or malformed payload |
|---|---|---|
| Money facts: `sale.*`, `payment.*`, `refund`, `void`, `shift.close`, `stock.adjust`, `purchase.receive` | **Accept and flag** (`register_ops.status='flagged'`, `violations text[]`) | **Hold** (bug or divergence) |
| Master data: customer, product, supplier, purchase header and items, purchase payment | Hold | Hold |
| Management: `staff.*`, `role.*`, `user.set_permission`, `setting.set`, `store.update`, metadata, notes | Hold; admin-skippable | Hold; admin-skippable |

**Implementation.** Each `_impl` takes `p_mode`. Checks go through `check_policy(p_kind_code text, p_ok boolean, p_mode)`:
- in `'online'` mode it raises exactly as today, which keeps existing behaviour and tests;
- in `'register'` mode it appends to `lensy.flags` (via `set_config`) and continues.

`register_ingest` reads `lensy.flags` after each op and stores them.

### 2.3 Per-op table

All PC ids are uuids generated on the PC. "Impl" is the internal function from §3.2. Every op is idempotent through the `register_ops` op ledger, and the impls also use `on conflict (id) do nothing` as a backstop.

| Op kind | Payload (beyond actor and time) | Cloud impl and server rules re-run | Notes |
|---|---|---|---|
| `customer.upsert` | the full row | `_customer_upsert`: customers.create/edit for the actor; tenancy | — |
| `customer.delete` | id | `_customer_delete`: customers.delete; FK from sales raises, so hold | The PC refuses locally first, like `customers.ts:216-241` |
| `product.upsert` | inventory row without `stock_qty` | `_inventory_upsert`: inventory.create/edit; per-store unique sku | **Never send `stock_qty`** (the `stock_qty_sync` trigger owns it, 012:69-91) |
| `product.create` | row plus optional `{movement_id, qty}` | `_add_inventory_item` with PC ids; `initial` movement at `t` | Replaces `add_inventory_item`'s server id |
| `stock.adjust` | `{movement_id, product_id, qty, type, ref_no, note}` | `_stock_adjust`: inventory.edit (flag); `created_at = t` | The trigger recomputes `stock_qty` |
| `metadata.upsert`, `metadata.delete`, `metadata.reorder` | table in {lens_types, frame_colors, frame_types}, rows, or ordered id[] | `_metadata_*`: inventory.edit | One op replaces N updates (`metadata.ts:61-73`) |
| `supplier.upsert`, `supplier.delete` | row or id | suppliers.* | — |
| `purchase.create` | header plus items (PC ids) | `_purchase_create`: suppliers.create | — |
| `purchase.receive` | `{purchase_id, lines:[{item_id, movement_id}], cost_after:{product_id: cost}}` | `_receive_purchase`: suppliers.edit (flag); movements and `received_at = t`; weighted-average cost recomputed | If the server cost differs from `cost_after` by more than 0.01, flag `cost_mismatch` and set the PC value (the PC is truth) |
| `purchase.payment.add`, `purchase.payment.delete`, `purchase.delete` | row or id | `_purchase_payment_add` (`paid_at` is a date), `_delete_purchase_payment`, `_delete_purchase` | "Not found" on delete is treated as ok |
| `sale.create` | the header: id, invoice_no, customer_id, kind, idempotency_key, delivery_date, doctor_name, lab_status, photo paths, payment_method, total, discount, net; `items:[{id, product_id, name, qty, unit_price, discount, discount_reason, movement_id}]`; `exams:[{id,…}]`; `payments:[{id, method, amount}]` | `_sale_create` (§2.4) | Frames auto-created at checkout are preceding `product.create` ops from the same local transaction |
| `sale.recheckout` | sale_id, header fields, the full new items with ids, exams, `new_payments:[{id, method, amount}]`, `movements:[{id, product_id, qty}]` (deltas) | `_sale_update` (§2.4) | Phase 0 append-only semantics |
| `sale.header` | sale_id plus whitelisted fields (doctor_name, delivery_date, photo paths) | `_sale_header`: history.edit; replacing a photo needs `is_store_admin(actor)` (flag) | Rules from `guard_sale_access` 029:774-793 |
| `sale.exams.replace` | sale_id, exams with ids | `_replace_exams`: history.edit | Exam ids are now stable (PC ids) |
| `sale.lab_status` | sale_id, status | `_set_lab_status`: lab.edit (flag); vocabulary check; the stamp trigger uses `lensy.event_at` | `z_report.lab_delivered` and lab dwell use event time |
| `payment.collect` | sale_id, `lines:[{id, method, amount}]` | `_collect_payment`: history.edit (flag); whitelist; sum ≤ balance (**hold** if broken); `paid_at = t` | Idempotent via the op ledger (fixes A15) |
| `sale.refund` | sale_id, payment_id, amount, method, reason | `_refund_sale`: history.refund (flag); per-tender ceiling (**hold**); `paid_at = t` | — |
| `sale.void` | sale_id, reason, restock, `refund_ids{method: id}`, `movement_ids{item_id: id}` | `_void_sale` (H4-fixed): history.void (flag); `voided_at = t`, `voided_by = actor` | Already voided means `dup`-like ok |
| `shift.close` | id, from, to, counted_cash, note, plus the PC's `expected_cash`, `expected_total`, `expected_by_tender`, counts, `refund_total`, `lab_delivered`, `variance` | `_close_shift` (§2.4) | — |
| `note.upsert`, `note.delete` | row or id; `created_by = actor` | `_note_*`: notes.*; authorship = actor | Notes RLS stays for phone reads |
| `setting.set` | key, value | `_setting_set`: settings.edit; `on conflict (store_id, key)` | — |
| `store.update` | allow_negative_stock, time_zone | `_store_update`: settings.edit | — |
| `staff.create` | `{id, username, full_name, role_id}` | `_staff_create`: actor needs staff.create (and staff.edit when a role is given); `max_staff` counted in SQL; reserved names; admin role only if `is_store_admin(actor)` | No auth user is created |
| `staff.set_access`, `staff.update_profile` | user_id, role_id, active, full_name | `_set_staff_access`: guards from 029:166-182 with the actor in place of `auth.uid()` | — |
| `role.create`, `role.set_permission`, `user.set_permission` | as the RPCs | `_create_staff_role`, `_set_role_permission`, `_set_user_permission`, actor-aware | Closes the escalation path in the RBAC report §6.2 |
| `noop` | skipped_kind, reason | records the skip | — |

**Images are not in the op log.** They have their own queue, described in §4.

### 2.4 How money stays correct while the PC is offline

**Invoice numbers**
- The PC allocates from `meta.invoiceNext` inside the sale's transaction. Two windows are serialised by IndexedDB, so a number is never handed out twice.
- **Seeding at setup:** `greatest(invoice_counter.next_val, max numeric invoice_no + 1)` for the store.
- **On the server, `_sale_create` in register mode:**
  - inserts `invoice_no` verbatim;
  - holds the op if `(store_id, invoice_no)` already exists with a different id. This cannot happen once 031 makes the number unique per store and `register_only` blocks other writers;
  - sets `invoice_counter.next_val = greatest(next_val, inv + 1)`.
- The online wrapper keeps today's behaviour.
- A standalone prescription uses the same counter with `kind='prescription'` (022).

**Attribution**
- `sales.user_id`, `sale_payments.recorded_by`, `voided_by`, `closed_by`, `notes.created_by` and `audit_log.actor` all equal the op's `actor`.
- Migration 032 re-points the foreign keys to `public.users`.
- `audit_log` gets `via_register uuid` and `event_at timestamptz`.

**Totals and balances**
- The PC prices the cart with `pricing.ts`, which is identical to the fixed `price_cart`.
- **`_sale_create` in register mode:**
  - uses the PC's line prices and recomputes the header with the same arithmetic as `price_cart`. A mismatch with the PC's header greater than 0.01 means **hold**;
  - compares each line's `unit_price` with `inventory.sale_price`. A difference only flags `price_changed`; it does not reject;
  - with `allow_negative_stock=false`, flags `negative_stock` when stock would go below zero;
  - inserts items, movements (`created_at = t`), exams and payments (`paid_at = t`, `recorded_by = actor`) with PC ids;
  - lets `amount_paid` be recomputed by `sync_sale_amount_paid` (013:231-247). The PC computes the same sum.
  - Payments must not exceed net, and no negative lines are allowed. Breaking either means hold.

**Re-checkout (`sale.recheckout`, after the Phase 0 fix)**
- Items and exams are replaced.
- Stock changes are written as delta movements at `t`. They are never deleted or re-dated, which fixes H2.
- The ledger is **never deleted**, which fixes H1. `new_payments` are appended.
- If the new net is below the ledger sum, the PC must first emit `sale.refund` ops; otherwise the server holds the op.
- `history.refund` is no longer needed inside re-checkout, because refunds are their own ops.

**Refunds**
- Per tender: amount ≤ Σ ledger rows for that method (028:143-151), at `t`.
- Void after a partial refund now mirrors the **net per method**, which fixes H4.

**Z-report and close**
- **Locally,** `zreport.ts` computes from the PC ledger by `paid_at` within the store-day window from `time.ts`.
- **`shift.close`** stores the PC's figures in the existing columns `expected_cash`, `expected_by_tender`, `expected_total`, the counts and `variance`. These are what the cashier saw (023:58-88).
- **The server** recomputes `z_report(from, to)`. Every earlier ledger op has already been applied in order, with its true `paid_at`.
  - The server results go in new columns `server_expected_cash` and `server_expected_total`.
  - `mismatch boolean` is set when they differ by more than 0.01, which can only come from a porting bug.
- The unique window constraint (`023:84`) stays.
- Close gets the event-time licence check.

**Idempotency** is universal through `register_ops (store_id, seq)` plus `op_id`. The PC also keeps main's per-checkout `idempotency_key` on the sale row for continuity (012:169-172).

---

## 3. Server changes (migrations 030 onwards)

Each migration ends with `select public.record_schema_version(N, …)`, as required by `scripts/check-migrations-stamp.sh`. `EXPECTED_SCHEMA_VERSION` (`lib/schemaVersion.ts:11`) is bumped to 34.

### 3.1 `030_money_fixes.sql` (benefits the online app too)

- **H3: `price_cart`.** When `v_net <= v_line_net + 0.01`, set `v_total := v_items`, `v_discount := round(greatest(0, v_items - v_net), 2)` and `v_net := v_total - v_discount` (today 013:349-353).
- **H4: `void_sale`.** Insert one refund per method: `select method, sum(amount) … group by method having sum(amount) > 0` (today 014:390-398).
- **H1/H2: `update_sale_order`.**
  - Stop deleting `sale_payments` (029:496) and the sale's movements (029:497-498).
  - Append delta movements per product.
  - `p_payments` means new collections only.
  - Raise `'refund first'` if the new net is below the ledger sum.
- **H8: `create_sale_order`.** Do the idempotency lookup first (029:277-286 moved above 267), keyed by `users.store_id` of `auth.uid()` without the active check.
- **Tests:** extend 013 G7 to assert header totals.

### 3.2 `031_per_store_unique.sql`

- Drop the global uniques on `sales.invoice_no` (000:154), `inventory.sku` (000:109), the `lens_types`, `frame_types`, `frame_colors` and `contact_lens_types` names (000:252-270) and `settings.key` (000:280).
- Add per-store unique indexes. Blank sku becomes null.
- This ports ref 011 §1 (minus roles) and ref 012. Without it, ingest holds forever on, for example, a "Single Vision" lens name or invoice 000123 that another store already uses.
- **Client change:** `settings.ts:31` uses `onConflict:'store_id,key'`.

### 3.3 `032_actor_core.sql`

- **Internal impls**, revoked from `public`, `anon` and `authenticated`:
  - `_sale_create`, `_sale_update`, `_sale_header`, `_void_sale`, `_refund_sale`, `_collect_payment`, `_close_shift`, `_set_lab_status`, `_replace_exams`;
  - `_add_inventory_item`, `_inventory_upsert`, `_stock_adjust`, `_receive_purchase`, `_purchase_*`, `_customer_*`, `_supplier_*`, `_metadata_*`;
  - `_note_*`, `_setting_set`, `_store_update`, `_staff_create`, `_set_staff_access`, `_create_staff_role`, `_set_role_permission`, `_set_user_permission`.
- **Common leading parameters:** `(p_store uuid, p_actor uuid, p_at timestamptz, p_mode text, …ids)`.
- **The public RPCs keep their exact signatures** and call the impls with `(auth_store_id(), auth.uid(), now(), 'online')`. The 18 existing SQL test files (365 assertions) are the regression oracle for this refactor.
- **`resolve_can_for(p_code, p_actor, p_store)`.** Internal; it also requires `actor.store_id = p_store`. Revoke `execute` on `resolve_can(text, uuid)` from `authenticated` (014:526; it leaks permissions across tenants). The one-argument path used by `create-user` stays: change it to `resolve_can(code)` wrapping the internal form with `auth.uid()`.
- **Foreign keys:** re-point `sale_payments.recorded_by` (011:52), `sales.voided_by` (013:85) and `shift_closes.closed_by` (023:62) to `public.users(id) on delete set null`. This is safe because `users.id = auth.users.id` for every existing login (015).
- **`effective_actor()`:** returns `nullif(current_setting('lensy.actor', true), '')::uuid` **only if `register_store_id()` is not null**, otherwise `auth.uid()`. `effective_event_at()` works the same way, defaulting to `now()`.
  - `audit_row` (014:88-111) uses them and fills `via_register` and `event_at`.
  - `lab_status_stamp` (019:76-104) uses `effective_event_at()` in place of `now()`.
  - A staff or phone JWT can never benefit from the GUCs. The register JWT cannot set them: `set_config` is not exposed through PostgREST, and the only function that sets them is `register_ingest`.
- **Licence:**
  - add `store_licenses.revoked_at`, set or cleared by `set_license_revoked` (026:187-215);
  - add `license_write_ok_at(p_store, p_at)`: not revoked as of `p_at`, and `starts_at <= p_at < expires_at`;
  - give `close_shift` a licence check.
- **`link_staff_ids`** (015:36-131) skips rows with `password_hash = 'register-local'`, and `staff_id_problems` (015:156-168) excludes them.

### 3.4 `033_register.sql` and Edge Function `supabase/functions/create-register/index.ts`

**Table `store_registers`:**
`store_id pk, register_uid uuid unique, device_id uuid, epoch int, claimed_by uuid, claimed_at, revoked_at, last_seq bigint default 0, last_ingest_at, last_server_contact, pending_reported int, held_seq bigint, held_error text, min_protocol int default 1`

**Table `register_ops`:**
`store_id, seq bigint, op_id uuid unique, kind, actor, occurred_at, received_at default now(), status ('ok'|'flagged'|'skipped'), violations text[], payload jsonb, result jsonb`, primary key `(store_id, seq)`. The payload is kept for audit and could be pruned after a year.

**Functions:**
- `register_store_id()`: `select store_id from store_registers where register_uid = auth.uid() and revoked_at is null`.
- `register_ingest(p_register, p_epoch, p_protocol, p_pending, p_ops) returns jsonb`: as in §2.1. Granted to `authenticated`; the first statement refuses any non-register caller.
- `register_ping(p_register, p_epoch)`: the same piggyback answer with no ops, for idle days.
- `revoke_register(p_store)`: `is_store_admin()` or a platform admin. It sets `revoked_at`. It is the one cloud write left to the owner, and is exempt from `register_only`.
- `register_status()` and `register_flags(p_limit)`: read only, for store members.

**Storage policies on `storage.objects`** for the register principal:
- `insert` and `delete` where `bucket_id = 'prescriptions'` and `name like 'store/' || register_store_id() || '/orders/%'`.
- The existing policy (008:426-459) keys on `auth_store_id()`, which is null for the register.

**`create-register` Edge Function**, modelled on `create-user/index.ts:61-136`:
1. Check the caller with the anon client and the caller's JWT: `is_store_admin()` and `license_write_ok`.
2. With the service role, create the auth user `register-<store8>@<domain>` with a random 32-byte password. **No `public.users` row is created**, so the register uses no `max_staff` seat and `auth_store_id()` is null for it.
3. Upsert `store_registers` with `epoch + 1`, the new uid, `claimed_*` and `revoked_at = null`, and keep `last_seq`.
4. Ban or delete the previous register's auth user.
5. Set `stores.register_only = true`.
6. Return `{email, password, epoch, last_seq}` once.

### 3.5 `034_register_only.sql`

- Add `stores.register_only boolean not null default false`.
- Add `store_write_ok(p_store)` = `license_write_ok(p_store) and (not register_only or is_platform_admin())`.
- Substitute it into:
  - the 008 tenant write policies and the 029 restrictive action policies (029:210-240);
  - the sales PATCH policy (029:794-796);
  - every public write RPC and the staff RPCs (029:101-182);
  - storage writes (008:426-459) for the `authenticated` non-register path.
- `my_permissions()` returns only `.view` codes when `register_only` is set.
- **Orphan sweep support:**
  - RPC `referenced_image_paths(p_store)` returns paths from `sales` and `order_examinations` in SQL, which fixes the 1000-row truncation in `storageCleanup.ts:38-50`;
  - client change: skip files younger than 14 days.

### 3.6 Security analysis

| Threat | Outcome |
|---|---|
| Stolen register token | It can call only `register_ingest`/`register_ping` and write photos in its own store folder. It cannot read any table: with no `users` row, `auth_store_id()` is null and every RLS read fails. It can forge ops as any staff member of that store, but only within time bounds, permission failures are flagged and visible on the phone, every op is kept in `register_ops` with `via_register`, and `revoke_register` from the phone plus the epoch check stop it immediately. It cannot reach other stores (the store comes from `store_registers`) and cannot change RBAC beyond the actor-checked rules. |
| Stolen phone token | Read only, because of `register_only`. |
| Cloned PC or old backup restored after a takeover | Refused by the epoch check. |
| Staff JWT setting `lensy.actor` | Ignored, because `effective_actor` requires `register_store_id()`. |
| Privilege escalation through staff ops | `_staff_create` and `_set_staff_access` evaluate `can_assign_role` and the admin-only and self guards against the **actor** (029:97-98,154,175,177). |
| Licence | The PC enforces expiry locally. The cloud refuses whole batches past grace or when revoked, and flags ops outside the event-time window. |
| GUC precedent | Same pattern as `lensy.money_write` (013:208-245). |
| Existing risk, out of scope | The `prescriptions` bucket is public (`storage.ts:21-23`). Note it for the owner. |
| PC compromise | The register password and refresh token sit in IndexedDB. That is equivalent to having the shop's data anyway, and is mitigated by revocation. |

---

## 4. Bandwidth budget

**Assumptions:** 30 sales a day, 15 of them with 2 photos (30 photos); about 30 lab-status changes and about 10 other ops a day; 26 trading days a month.

| Item | Per unit | Per day | Per month |
|---|---|---|---|
| `sale.create` op (header, 2 lines, 1 exam, 2 tenders) | ≈1.8–2.2 KB JSON | ≈65 KB | ≈1.7 MB |
| Other ops (lab, collect, customer, adjust) | 0.2–0.5 KB | ≈15 KB | ≈0.4 MB |
| Per-push overhead (TLS 1.3 resumption or new handshake ≈3–6 KB, CORS preflight ≈1 KB, headers including JWT ≈2 KB, response ≈0.5 KB) | ≈7–10 KB per push | about 25 pushes ≈ 220 KB | ≈5.7 MB |
| Token refresh, lazy: only when the access token is older than 1 h at push time | ≈4 KB | ≤ 12 ≈ 50 KB | ≈1.3 MB |
| Idle-day `register_ping` (only if nothing was pushed in 24 h) | ≈8 KB | — | <0.3 MB |
| **Data subtotal** | | **≈0.35 MB** | **≈9–10 MB** |
| Photos, uploaded once, never re-downloaded by the PC (rx 1280 px JPEG q≈0.65 ≈ 90 KB; frame 1024 px q≈0.7 ≈ 70 KB; plus ≈8 KB per request) | ≈90 KB | ≈2.7 MB | ≈70 MB |
| App update (register build, prompt only) | ≈300 KB gz per release | — | ≈0.3–1 MB |
| **Total** | | **≈3 MB** | **≈80 MB** (today's estimate is 0.5–1.3 GB) |

**Rules that keep it there:**
- **No timers that touch the network.** Pushes are driven by commits, debounced: send when the oldest unsent op is 90 s old, or there are 50 ops, or someone taps "Sync now". This gives the phone freshness of about 2 minutes.
- **Everything the cloud says comes back in the ingest response:** licence, revocation, server time and minimum protocol. There are no separate licence, staff or heartbeat polls (ref `sync.ts:57-63`, 487-629 removed).
- **The PC never reads from the cloud after setup.** There is no down-sync of staff; the PC is the authority.
- **Photos:**
  - compressed once at capture in `lib/storage.ts:26-42` (change from 1600 px / 0.82);
  - the blob is kept in IndexedDB for local viewing;
  - uploaded once with `upsert:false`, and a 409 counts as success;
  - uploaded **after** the op that references the path has been acked, so the orphan sweep never sees a file before its row;
  - a replaced photo gets an `image.delete` queued after the header op is acked;
  - the PC never lists storage (ref `adoptPhoneImages`, `sync.ts:561-621`, is dropped).
- **A byte counter** in `SyncStatus` (`meta.bytesThisMonth`, counting request and response sizes) shows the month's usage.
- **Initial download, once at setup,** uses the owner's admin session with keyset paging of 1000 rows and explicit `select=` columns, gzip on responses. It reuses `ref:sync.ts:770-818`.
  - Example: 5k customers, 2k products, 20k sales with their items, payments and exams.
  - That is about 25–35 MB raw, or about **6–12 MB gzipped**.
  - The setup screen shows a size estimate from head counts before starting.
  - Photos are **not** downloaded. On the PC an old photo is shown from its public URL only when someone opens it while online.

---

## 5. What is reused, from where

| Component | Source | Verdict |
|---|---|---|
| IndexedDB layer `commit`, `withLock`, BroadcastChannel, `outboxSkipHead`, `replaceStores` guards, `snapshot` | `ref:lib/local/db.ts` | Port with changes: versioned upgrades, ops instead of rows, explicit gapless `seq`, `durability:'strict'` |
| `TableDef` / mirror schema | `ref:lib/local/schema.ts` | Port with changes: drop `conflict`/`optional`; add `sale_payments`, `shift_closes`, the new columns, `stock_qty` |
| Drain algorithm (ordered, isolate the bad op, hold, backoff, clock guard), status store, error classifier, `syncNow`/`startSync`, skip | `ref:lib/local/sync.ts:72-136, 142-215, 344-424, 714-760` | Port with changes: one ingest RPC; remove all timers |
| Row upserts and deletes, column stripping, conflict picking, heartbeat, staff and licence polls, phone-photo adoption | `ref:sync.ts:221-341, 487-629, 988-1011` | **Drop** |
| Setup, link and restore flow with guards | `ref:sync.ts:867-980`, `features/local/SetupPage.tsx` | Port with changes: `create-register`, claim before snapshot, admin from `my_permissions().is_admin` |
| Offline staff sign-in (PBKDF2) | `ref:lib/local/localAuth.ts` | Port; local-first, no online check |
| Backup export and import | `ref:lib/local/backup.ts`, `features/local/BackupPanel.tsx` | Port with changes: new stores, a new version, and an automatic daily backup to a folder via the File System Access API |
| Licence cache | `ref:lib/local/state.ts` | Port; add `pending`, `starts_at` and the clock high-water mark |
| Boot (`storage.persist()`, device marker) | `ref:lib/local/boot.ts` | Port; add the local schema check |
| Build flags and wrong-build guard | `ref:lib/config.ts`, `ref:main.tsx:73-107`, `ref:vite.config.ts` | Port |
| Sync and backup UI | `ref:features/local/SyncStatus.tsx` | Port; add the byte counter, held error and flag count |
| Repository interface and implementations, `repositoryReadOnly` | `ref:lib/repository*.ts` | **Concept only.** Rebuild as `data/backend/*` from main's hooks; read-only is enforced by the server |
| Ref migrations 011 and 012 | ref | Keep only §1 (as 031) and §5 (rewritten as 033). Drop `auth_staff_id`/`auth_uid` (contradicts 014/015/029) |
| `ref:features/pos/wizardStore.ts` | ref | Drop; use main's `posDraft.ts` stored in the IndexedDB `drafts` store |
| Data hooks, query keys, invalidation groups, UI, i18n, `permissionModel.ts`, `payments.ts`, `pricing.ts`, `suggest.ts`, `posDraft.ts`, idempotency-key minting | main | Keep. The hooks become thin wrappers over the backend |
| All SQL money, RBAC, report and licence functions, plus the 18 SQL test files | main | Keep. Refactor into impls, and use as the oracle for the TS ports |
| `create-user` Edge Function | main | Keep, used only for the owner's cloud login |
| `offlineMutations.ts`, `PersistQueryClientProvider`, 15 s polls | main | Not used on the register or phone builds. The cloud build keeps them, with the Phase 0 fixes |
| `ingest`/impl split, `store_registers`, `register_ops`, `create-register`, rules engine, data seam, `register_status`/`register_flags` phone pages, parity tests | — | **New** |

---

## 6. Phased build plan

Effort is in developer-days for one developer.

**Phase 0: money fixes on main (4–6 d)**
- **Deliverables:**
  - migrations 030 and 031;
  - `useCreateSale` sends line discounts (`sales.ts:634-640`) and computes `order_date` and `paid_at` at the Finish click (H5);
  - `loadSale` no longer collapses tenders (`POSContext.tsx:770-773`), and re-checkout shows the ledger read-only, adds collections, and refunds first;
  - `setMutationDefaults` registers the checkout `mutationFn` (H6, `queryClient.ts:26-33`);
  - the "Saved on this device" message only appears when the mutation is actually paused (H7, `POSContext.tsx:661-666`);
  - `from('products')` fixed;
  - `settings` `onConflict` changed.
- **Tests:**
  - SQL `tests/030_money_fixes_test.sql`: header totals after line discounts; void after a partial refund; re-checkout keeps refund rows, `paid_at` and `recorded_by`; re-checkout with a lower net raises "refund first"; an idempotent replay after the cashier is deactivated returns the sale.
  - SQL `tests/031_per_store_unique_test.sql`: two stores with the same invoice, sku, lens name and setting key.
  - vitest: `pricing.test.ts` additions, and a checkout-defaults test that hydrates a paused mutation and resumes it.

**Phase 1: server actor core and register (10–14 d)**
- **Deliverables:** migrations 032, 033 and 034; `create-register` Edge Function with `authz.ts`-style tests; `register_ingest` dispatch for every kind in §2.3.
- **Tests:**
  - All existing 012–029 tests stay green.
  - `tests/032_actor_core_test.sql`: wrappers behave as before; `resolve_can(text, uuid)` is not executable; the FK re-point holds; `lensy.actor` is ignored for a staff JWT; `revoked_at` and `license_write_ok_at` work.
  - `tests/033_register_ingest_test.sql`, impersonating via `request.jwt.claim.sub` (`tests/_shim.sql:54-62`), covering every op kind: `ok`; `dup` on re-send; seq gap; wrong epoch; revoked register; attribution in `user_id`, `recorded_by`, `voided_by`, `closed_by` and `audit_log.actor` with `via_register`; `occurred_at` stored in `order_date`, `paid_at`, `voided_at`, `lab_status_changed_at` and movement `created_at`; flags for permission, price, negative stock, licence and clock; holds for over-refund, over-collection, header arithmetic and invoice collision; close mismatch columns; savepoint rollback leaves earlier ops applied; register cannot select any table or call `create_sale_order`.
  - `tests/034_register_only_test.sql`: a phone admin cannot insert or update customers, call `collect_sale_payment` or write storage; `my_permissions` returns view-only codes; `revoke_register` still works.

**Phase 2: local store and rules engine, no UI (10–14 d)**
- **Deliverables:** `src/lib/register/db.ts` (schema v1 and upgrade ladder), `rules/*.ts` (§1.4), op builders producing payloads that match §2.3, `clock.ts`.
- **Tests:**
  - vitest with `fake-indexeddb`, a new dev dependency: commit atomicity (a failed rule writes nothing and consumes no seq); gapless seq; invoice allocation across two concurrent commits.
  - Rule parity cases mirrored from SQL tests 012, 013, 018, 019, 023 and 028: same inputs and same expected numbers.
  - `resolve_can` truth table from `029_effective_permissions_test.sql`.
  - Licence state machine with clock rollback.
  - Store-day ranges for Africa/Cairo, including DST transitions.

**Phase 3: data seam and register build (12–18 d, the largest)**
- **Deliverables:**
  - `data/backend/{types,cloud/*,local/*}.ts` and the `@backend` alias;
  - every hook ported to the backend;
  - the POSContext direct calls moved behind the backend;
  - register shell: boot, local sign-in, local `PermissionsProvider`, `networkMode:'always'`, no persistence provider;
  - the full POS, history, lab, customers, inventory, suppliers, notes, staff, settings, reports and Z-report working offline.
- **Tests:**
  - vitest per local backend module against fixture data: lists, search, paging, reports equal to the expected values.
  - A test that each `cloud` and `local` module exports the same keys.
  - The existing 260 vitest tests stay green on the cloud build.
  - Manual test: browser offline with Wi-Fi off, cold start, then sign-in, sale, refund, void and close.

**Phase 4: sync engine, setup, backup (8–12 d)**
- **Deliverables:**
  - `src/lib/register/sync.ts` (drain, image queue, piggyback handling, byte counter, held and flag state);
  - SetupPage: admin sign-in, `create-register`, size estimate, snapshot import, seed `invoiceNext`, set staff offline passwords, sign out the admin (scope local);
  - SyncStatus and BackupPanel, including the automatic daily backup;
  - takeover and restore.
- **Tests:**
  - vitest of drain against a fake ingest: ok, dup after a lost response, gap re-send, held stops the queue and selling continues, skip allowed only for skippable kinds, backoff schedule, no network call when queues are empty, images uploaded only after the referencing op is acked, 409 counts as success.
  - Snapshot import, and backup round-trip and refusal rules.
- **Golden parity test:** a vitest scenario script runs a full trading day through the PC rules and writes `web/supabase/tests/035_register_parity_test.sql`. That file feeds the op log into `register_ingest` and asserts that the cloud `z_report`, `report_sales_window` and `customer_balance` equal the PC figures embedded in it. CI fails if the committed file is stale.

**Phase 5: phone build, photos, docs, pilot (5–8 d)**
- **Deliverables:**
  - `VITE_READ_ONLY` UI;
  - freshness banner and Flags page;
  - removal of polling on the phone;
  - new photo compression and the orphan-sweep age and paging fix;
  - `render.yaml` with three sites;
  - a rewrite of `web/OFFLINE.md`; `SETUP.md` steps for 030–034; README migration table; `DEFERRED.md:16` reversed;
  - a one-week pilot measuring `bytesThisMonth`.
- **Tests:** vitest for the phone permission degradation and the banner; `storageOrphans.test.ts` additions for the age threshold and paged references.

**Total: about 49–72 developer-days.**

**Cutover checklist for the existing store:**
1. Make sure no device holds queued checkouts.
2. Apply 030–034.
3. Run setup on the PC. It claims the register, which sets `register_only`, before downloading the snapshot, so nothing can be written in between.
4. Set offline passwords.
5. Do a test sale and confirm it appears on the phone.

---

## 7. Open questions for the owner

1. **Photos:**
   - Are they taken on the PC (webcam, scanner or file), or with a phone through the QR code? QR means the PC must download each phone photo, about 100 KB more per photo, from the shop quota. The default is to take them on the PC only.
   - Is about 90 KB per photo clear enough to read a prescription?
2. **How fresh the phone view must be.** The default is about 2 minutes after a sale. Batching every 15 minutes saves only about 3–4 MB a month.
3. **Where staff and permissions are managed.** The default is only at the shop PC, with the phone strictly view-only apart from "revoke register".
4. **How much history to load onto the PC at setup.** All past sales is about 6–12 MB once. The alternative is the last 2 years plus every open balance.
5. **Daily backup.** Which folder or USB stick the PC writes its automatic daily backup to, and who checks it.
6. **Vendor decision, not the owner's.** May the PC keep selling with no cloud contact for unlimited days? The recommendation is yes: the expiry date is enforced locally, and revocation takes effect at the next contact.
