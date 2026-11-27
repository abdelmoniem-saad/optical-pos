### REPORT: money
# LensyPOS money model on `main` (cf78ca5): how it works and what that means for an offline shop PC

Read-only analysis. Paths are relative to `D:/Projects/optical-pos/optical-pos/web/`. Line numbers are from the files on `main`.

**Migration 029 has the live definitions.** The migrations in the task list are not the latest. `029_effective_permissions.sql` redefines `create_sale_order` and `update_sale_order`, adds `collect_sale_payment`, and revokes direct writes on the money tables. `014_server_rbac.sql` holds the live `void_sale`. Migrations 018 and 019 add `customer_balance`, `receive_purchase` and the lab timestamps that `z_report` reads. All of these are used below, and each citation points at the latest definition.

---

## 0. Live function definitions (the latest `create or replace` wins)

| Function | Live definition | Security | Permission it checks |
|---|---|---|---|
| `create_sale_order(p_sale, p_items, p_exams, p_payments, p_idempotency_key)` | `supabase/029:246-408` | DEFINER | `pos.create` (029:270) |
| `update_sale_order(p_sale_id, p_sale, p_items, p_exams, p_payments)` | `029:410-562` | DEFINER | `pos.edit` or `history.edit` (029:432); `lab.edit` if lab status changes (029:458-459); `history.refund` if paid goes down (029:489) |
| `price_cart(p_items, p_net, p_allow_negative_stock)` (pricing core) | `013:259-357` | INVOKER, called from inside the DEFINER functions | none |
| `collect_sale_payment(p_sale, p_lines)` | `029:800-817` | DEFINER | `history.edit` |
| `refund_sale(p_sale_id, p_amount, p_method, p_reason)` | `028:288-361` | DEFINER | `history.refund` |
| `void_sale(p_sale_id, p_reason, p_restock)` | `014:338-408` | DEFINER | `history.void` |
| `z_report(p_from, p_to)` | `023:112-169` | DEFINER, read-only | none (tenant only) |
| `close_shift(p_from, p_to, p_counted_cash, p_note)` | `024:121-182` | DEFINER | `closing.edit` |
| `next_invoice_no()` | `012:140-166` | INVOKER | none (RLS) |
| `receive_purchase(p_purchase)` | `029:589-675` | DEFINER | `suppliers.edit` |
| `add_inventory_item(p_product, p_initial_stock)` | `029:564-587` | DEFINER | `inventory.create` |
| `delete_purchase`, `delete_purchase_payment` | `029:677-737` | DEFINER | `suppliers.delete`, `suppliers.edit` |
| `set_lab_status` | `029:748-756` | DEFINER | `lab.edit` |
| Reports: `report_sales_window` (`022:272-311`), `report_payment_mix` (`016:123-134`), `report_top_customers`, `report_voided_count` (`016`), `customer_balance` / `customer_debtors` (`018:166-260`), `store_day_range` / `store_time_zone` / `report_window` (`016:170-208`) | | DEFINER, read-only | none |

Every write function also checks the licence (`license_write_ok`) and the store (`auth_store_id()`). Since 029, `auth_store_id()` requires an **active** user whose role belongs to the same store (`029:74-79`).

---

## 1. Tables, invariants and the database machinery around them

### 1.1 Money tables and their rules

**`sales`** (`000_base_schema.sql:152-167`, plus 012, 013 and 022)
- `invoice_no TEXT NOT NULL UNIQUE` is unique across **all stores**, not per store (`000:154`; `baseline/schema_after_012.sql:1341`).
- `idempotency_key uuid` has a unique index on (store_id, idempotency_key) (`012:169-172`).
- Check constraints: `amount_paid >= 0`, `discount >= 0`, `discount <= total_amount`, `net_amount = total_amount - discount` (`012:184-190`).
- Void columns `voided_at`, `voided_by`, `void_reason` (`013:84-86`).
- `kind in ('sale','prescription')` (`022:41-75`).
- Lab timestamps `lab_status_changed_at`, `lab_started_at`, `lab_ready_at` (019).

**`sale_items`**
- `qty > 0`, `unit_price >= 0`, `total_price = qty * unit_price` (`012:184-186`).
- `discount >= 0`, `discount <= total_price`, plus a `discount_reason` column (`013:100-133`).

**`sale_payments`** is the money ledger (`011:125-135`, changed by 013).
- Columns: id, sale_id, amount, method (free text), kind (`payment`/`refund`), note, paid_at, recorded_by (defaults to `auth.uid()`), store_id, created_at.
- `amount <> 0`; negative means money out (`013:61-78`).
- `paid_at` is a timestamptz (`013:58-59`).
- `kind` defaults to `'payment'` (`013:53-54`).

**`stock_movements`** is the stock ledger.
- It has no sale_id column. A sale's movements are found by `type='sale'` and `ref_no=invoice_no` (`029:497-498`).
- `kind` is normalised from `type` by a trigger (`013:174-197`).

**`inventory.stock_qty`** is a cache kept in step with the stock ledger by the `stock_qty_sync` trigger (`012:69-91`).

**`invoice_counter`** holds (store_id, prefix, next_val) (`012:105-133`).

**`shift_closes`** is append-only. It has a unique constraint on (store_id, from_at, to_at) and requires `to_at > from_at` (`023:58-88`).

**Purchases**
- `purchases` has a legacy `amount_paid` column that no trigger maintains.
- `purchase_items.received_at` (`018:37-38`).
- `purchase_payments` has amount and `paid_at` (a **date**), and no sync trigger (`003:16-23`).

### 1.2 Triggers that fire on money tables

| Trigger | Table, timing | Effect |
|---|---|---|
| `tenant_fill_store_id` | BEFORE INSERT on sales, sale_items, stock_movements, purchases*, customers, inventory… (`008:240-266`) and on sale_payments (`011:166-168`) | Fills `store_id` from `auth_store_id()` when it is null |
| `sale_payments_sync` → `sync_sale_amount_paid` | AFTER INS/UPD/DEL on sale_payments (`011:189-192`, body `013:231-247`) | Sets `sales.amount_paid = SUM(ledger)`, with the money-write flag raised |
| `sales_money_guard` → `guard_sale_money` | BEFORE UPDATE on sales (`013:208-227`) | Rejects any change to total_amount, discount, net_amount or amount_paid unless `lensy.money_write='1'` (error 42501) |
| `aa_sale_access` → `guard_sale_access` | BEFORE UPDATE on sales (`029:774-793`) | Runs only when `current_user='authenticated'`. Requires `history.edit`. Rejects edits to a voided sale. Allows only doctor_name, delivery_date, rx_image_path, frame_image_path and the lab columns to change. Changing lab_status requires `lab.edit`. Replacing a photo requires an admin. |
| `lab_status_stamp` | BEFORE UPDATE on sales (`019:76-103`) | Stamps `lab_status_changed_at` / `lab_started_at` / `lab_ready_at` with `now()`. `z_report.lab_delivered` reads these. |
| `stock_qty_sync` | AFTER INS/UPD/DEL on stock_movements (`012:88-91`) | Adjusts `inventory.stock_qty` up or down |
| `stock_movement_kind` | BEFORE INSERT/UPDATE OF type on stock_movements (`013:191-194`) | Sets `kind` from `type` |
| `audit_row_trigger` | AFTER I/U/D on sales, sale_items, sale_payments, stock_movements, purchases, purchase_items, purchase_payments, users, roles… (`014:477-490`) | Writes an `audit_log` row with `actor = auth.uid()` |

### 1.3 What rejects a direct table write today

| Table | INSERT | UPDATE | DELETE |
|---|---|---|---|
| `sales` | **Grant revoked** (`029:740`) | Allowed with `history.edit` (restrictive policy `029:794-796`), but only the whitelisted non-money columns (`029:780-783`). Money columns are also blocked by `guard_sale_money`. | **Revoked** (`029:740`); delete policy dropped (`013:816-826`) |
| `sale_items`, `order_examinations` | **Revoked** (`029:739`) | Revoked | Revoked |
| `sale_payments` | **Revoked** (`029:818`) | Revoked | Revoked |
| `stock_movements` | Allowed only with `inventory.edit` (restrictive, `029:225`), plus tenant and licence policies | Restrictive policy is `false` | Restrictive policy is `false`; policy dropped in 013 |
| `shift_closes` | **Revoked** (`023:103`); only a select policy exists (`023:95-98`) | Revoked | Revoked |
| `invoice_counter` | Tenant and licence RLS only (`012:120-133`), not revoked | Same | Same |
| `purchases`, `purchase_items` | `suppliers.create` (`029:217-218`) | `suppliers.edit` | `false` (use `delete_purchase`) |
| `purchase_payments` | `suppliers.edit` (`029:219`) | `suppliers.edit` | `false` (use `delete_purchase_payment`) |
| `inventory` | `inventory.create` | `inventory.edit` | `false` |
| `customers` | `customers.create` | `customers.edit` | `customers.delete` |

All of these also carry the 008/011 tenant and licence policies. A store in grace or expired can read but not write.

---

## 2. Each money operation in detail

### 2.1 Create sale (POS checkout)

**Client call path**
1. Entering the cart reserves an invoice number. `POSContext.enterAfterCustomer` (`features/pos/POSContext.tsx:344-364`) checks whether the number is taken (direct select on `sales`), then calls `nextInvoiceNo()`, which is the `next_invoice_no` RPC (`data/sales.ts:496-507`). Abandoned carts leave gaps in the sequence (by design, `012:18-22`).
2. Finish runs `finishOrder` (`POSContext.tsx:546-683`):
   - mints the idempotency key once per attempt (`:559-563`, minted by `newIdempotencyKey` at `:70-78`);
   - may create a frame product by direct `inventory` insert (`findOrCreateFrame`, `:431-469`);
   - runs `addMissingOrderMetadata` (`:569`) and `findOrderImages` (storage list, `:591`);
   - computes totals client-side (`features/pos/pricing.ts:25-38`) and clamps tenders to amount_paid (`lib/payments.ts:75-85`);
   - calls `resolveStaffUserId()`, which is a network `auth.getUser()` (`data/staff.ts:26-30`);
   - calls `createSale.mutateAsync` (`:628-634`).
3. `useCreateSale` (`data/sales.ts:571-792`) builds `p_sale`:
   - `order_date: new Date().toISOString()` is computed **inside mutationFn**, so at send time, not at ring-up time (`:619`);
   - `kind`, the photo paths, and `invoice_no`.
   - Items are sent **without** `discount` / `discount_reason` (`:634-640`).
   - Payments are sent as `{method, amount}` only, with **no `paid_at`** (`:597-607`, `:652`).
   - The idempotency key is sent (`:656`).
   - The call is `supabase.rpc('create_sale_order', …)` (`:658`), retried up to 3 times on an invoice-number conflict.
   - A legacy non-atomic fallback with direct inserts follows (`:675-775`). After 029 it would fail, because those grants are revoked. It is dead code on `main`.

**What the server does in `create_sale_order`** (`029:246-408`), in this order:
1. Checks the customer belongs to the store (`:267`).
2. Checks every product belongs to the store (`:268`).
3. Rejects negative payment lines (`:269`).
4. Requires `pos.create` (`:270`).
5. Checks the licence (`:271`).
6. Checks the store (`:272-275`).
7. **Only then** looks up the idempotency key and returns the existing sale if found (`:277-286`).
8. Reads `stores.allow_negative_stock` (`:288-293`).
9. Runs `price_cart` (`013:259-357`):
   - locks inventory rows in id order;
   - `unit_price` must match `inventory.sale_price` within 0.01, or it raises `price changed: <name>`;
   - qty must be > 0;
   - a line discount must be between 0 and the line value;
   - an optional stock guard raises `insufficient stock`;
   - **net is the only client money input that survives.** If net ≤ line_net, then total = catalog sum and discount = line_net − net. Otherwise total = net and discount = 0.
10. Payments may not exceed net (`029:301-310`).
11. `kind = 'prescription'` only when the catalog total is 0 and there are no payments (`:324-331`).
12. Invoice number: uses the client's number unless it already exists **in any store**, in which case it silently takes `next_invoice_no()` instead (`:334-340`).
13. Inserts the header (`:342-354`):
    - `id` comes from the uuid default; a client id is ignored because `id` is not in the column list;
    - **`user_id = auth.uid()`**, so the client's `user_id` is ignored (`:349`);
    - `store_id = v_store`;
    - `order_date = coalesce(client, now())`;
    - money columns come from `price_cart`;
    - `amount_paid` = the header value, then recomputed by the ledger trigger.
    - On `unique_violation` it re-reads by idempotency key (`:355-366`).
14. Inserts lines at catalog prices with the line discounts (`:369-376`).
15. Inserts one `stock_movements` row per line: `qty=-qty`, `type='sale'`, `ref_no=invoice_no`, `created_at=now()` (`:378-382`). The stock cache trigger and the kind trigger fire.
16. Inserts the exams (`:384-392`).
17. Inserts payments (`:394-405`): method is lowercased, `kind` defaults to `payment`, **`paid_at = coalesce(client, now())`**, **`recorded_by = auth.uid()`**. The ledger trigger then recomputes `amount_paid`.

**Idempotency.** The key is `(store_id, idempotency_key)`, backed by a unique index and the re-read in the exception handler. Test `tests/012_integrity_test.sql:253-276` (G4) covers it.

**State a local copy needs to reach the same result**
- the catalog `sale_price` per product at sale time (the server re-validates, so the local price must equal the cloud price when the call is replayed);
- `stock_qty` and `allow_negative_stock`;
- an invoice counter seeded from the store's highest numeric invoice;
- customer and product rows that already exist in the cloud;
- the permission matrix, the user's active flag and the licence state;
- the exact `price_cart` arithmetic (see hazard H3);
- the 0.01 tolerances and 2-decimal rounding.

### 2.2 Standalone prescription

- Client: `useAddStandalonePrescription` calls `useCreateSale` with `items: []`, zero totals and `kind: 'prescription'` (`data/sales.ts:1214-1244`).
- Server: same function. The server derives `kind` (`029:324-331`). It still uses up an invoice number from the counter.
- Replay: same as 2.1.

### 2.3 Re-checkout / edit sale (replace in place)

**Client call path**
- `loadSale` (`POSContext.tsx:692-789`) loads the sale. **All existing tenders are collapsed into one line**: `[{method: legacyMethodKey(sale.payment_method), amount: sale.amount_paid}]` (`:770-773`). `legacyMethodKey` only lowercases, so a header of "Cash + InstaPay" becomes the method string "cash + instapay" (`lib/payments.ts:106-108`).
- `finishOrder` then calls `useUpdateSaleFull` (`data/sales.ts:812-971`).
- That runs `rpc('update_sale_order', {p_sale_id, p_sale{customer_id:null, doctor_name, delivery_date, payment_method, net_amount, amount_paid, lab_status, photos}, p_items (with discount and reason), p_exams, p_payments (method and amount, no paid_at)})` (`:868-874`).
- It has **no idempotency key** and **no offline replay**. Its mutation key is not the checkout key.
- The pre-013 fallback (`:878-961`) is dead after 029.

**What the server does in `update_sale_order`** (`029:410-562`)
- Runs the same customer, product and negative-payment checks and the permission and licence checks (`:429-443`).
- Locks the sale with `FOR UPDATE`. It must exist, belong to the store, and not be voided (`:445-457`).
- Checks the lab and photo-replace rules (`:458-464`).
- Runs `price_cart` and checks paid ≤ net (`:473-488`). If new paid is less than the old `amount_paid`, it requires `history.refund` (`:489`).
- **Deletes all** sale_items, order_examinations and **sale_payments**, and the sale's `type='sale'` stock movements (`:494-498`).
- Raises the money-write flag and updates the header (`:500-516`). `customer_id` keeps the old value when the client sends null. `lab_status` is reset to 'Not Started' when exams are present.
- Re-inserts lines, movements (`created_at=now()`), exams, and payments (`paid_at = coalesce(client, now())`, `recorded_by = auth.uid()`) (`:518-554`).

**Idempotency.** None by key. The final state is the same if replayed (replace semantics), but every replay re-stamps `paid_at`, `created_at` and `recorded_by`. It needs the **server** sale id.

**State a local copy needs:** everything 2.1 needs, plus the target sale's server id, invoice_no, current amount_paid and voided flag.

**Destructive side effects (relevant to sync):** see H1 and H2 in section 4.

### 2.4 Add payment (collect the balance later)

- Client: `SalePayments.record` (`features/history/SalePayments.tsx:74-93`) clamps to the balance and calls `useAddSalePayments` (`data/salesPayments.ts:65-95`), which calls `rpc('collect_sale_payment', {p_sale, p_lines:[{amount, method}]})` (`:80-82`). The client works out `paid_at` (`:73-78`) but **does not send it**. The function returns void.
- Server: `029:800-817`.
  - Requires `history.edit` and an active licence.
  - Locks the sale with `FOR UPDATE`. It must belong to the store and not be voided.
  - Each line must have amount > 0 and a method in the **whitelist** `cash|wallet|instapay|card`.
  - The sum must be ≤ `net_amount - amount_paid`, or it raises `Payment exceeds balance`.
  - Inserts rows with `kind='payment'`, `paid_at=now()`, `recorded_by=auth.uid()`, and `store_id` from the sale. The ledger trigger recomputes `amount_paid`.
- Rejection paths: a direct insert into `sale_payments` is revoked (`029:818`). Test `tests/029_effective_permissions_test.sql:35-38,56`.
- Idempotency: **none**. A replay after a lost response records a second payment if the balance still allows it. The balance check limits the damage to over-collection up to the balance. Only the UI busy flag (`SalePayments.tsx:75`) prevents double-taps.
- State a local copy needs: the sale's `net_amount`, the sum of its ledger rows, its voided flag, and the method whitelist.

### 2.5 Partial refund

- Client: `SalePayments.recordRefund` (`SalePayments.tsx:54-62`).
  - The UI ceiling is the sum of all ledger rows for the chosen method (`:52`).
  - A reason is required.
  - It calls `useRefundSale`, which is `rpc('refund_sale', {p_sale_id, p_amount, p_method, p_reason})` (`data/salesPayments.ts:14-23`).
- Server: `028:288-361`.
  - Requires `history.refund`, a signed-in user, the store, and an active licence.
  - The amount must be > 0.
  - Locks the sale with `FOR UPDATE`; it must not be voided.
  - **Per-tender ceiling:** amount ≤ SUM(sale_payments.amount for this sale and this method) (`:335-343`, errcode 22023). The method comparison is case-sensitive.
  - Inserts one row: `amount=-p_amount`, `kind='refund'`, `note='Refund <inv>[: reason]'`, `paid_at=now()`, `recorded_by=auth.uid()`. The ledger trigger recomputes `amount_paid`. The sale is **not** voided.
- Tests: `tests/028_partial_refund_test.sql:123-191`.
- Idempotency: **none**. A double replay refunds twice, limited only by the per-tender ceiling.
- State a local copy needs: the ledger rows per method for the sale, and its voided flag.

### 2.6 Void

- Client: `useVoidSale` calls `rpc('void_sale', {p_sale_id, p_reason, p_restock})` (`data/sales.ts:1166-1200`). On success it deletes the order photos from storage, best-effort (`:1195-1197`).
- Server: `014:338-408`.
  - Requires `history.void`, a signed-in user, the store and the licence.
  - Locks the sale with `FOR UPDATE`; it must not already be voided (otherwise it raises `sale is already voided`).
  - If `p_restock`, inserts one `stock_movements` row per line: `qty=+qty`, `type='return'` (normalised to kind `void_restock`), `ref_no=invoice_no`, `created_at=now()`.
  - Mirrors **every row with kind='payment' and amount > 0** as a negative refund row on the same method (`paid_at=now()`, `recorded_by=auth.uid()`).
  - Sets `voided_at=now()`, `voided_by=auth.uid()` and `void_reason`. Header money columns stay as they were for the audit trail. Reports exclude voided sales by `voided_at is null`.
- Tests: `tests/013_void_refunds_test.sql:277-325`.
- Idempotency: a second call raises `sale is already voided`, so it is safe to replay if the caller treats that error as success.
- State a local copy needs: the sale's payment rows and items, and its voided flag. Watch for H4.

### 2.7 Z report (read) and close shift (write)

**Reading the day's figures**
- Client: `useZReport(day)` (`data/zreport.ts:113-152`).
  - It first calls `store_day_range(p_day)` (`data/sales.ts:227-229`, `016:184-194`) for the store's local-midnight bounds.
  - The time zone comes from the store setting `time_zone`, then `stores.time_zone` (default `Africa/Cairo`), then UTC (`016:165-179`).
  - It then calls `rpc('z_report', {p_from, p_to})`.
- Server `z_report` (`023:112-169`):
  - money comes from `sale_payments` where `paid_at` is in [from, to):
    - `expected_total` = SUM(amount);
    - `expected_cash` = SUM where method = 'cash';
    - `expected_by_tender` = SUM per method;
    - `refund_total` = minus the SUM of negative rows;
  - counts come from `sales` where `order_date` is in the window: orders (kind 'sale'), prescriptions, and voids (`voided_at` not null);
  - `lab_delivered` counts sales with `lab_status='Received'` whose `lab_status_changed_at` is in the window.
  - Voids are not filtered out of the money. Their negative mirror rows cancel the original payments in the sum.

**Recording the close**
- Client: `CloseShiftPage.submit` (`features/closing/CloseShiftPage.tsx:79-107`) calls `useCloseShift`, which is `rpc('close_shift', {p_from, p_to, p_counted_cash, p_note})` (`data/zreport.ts:194-220`).
- Server `close_shift` (`024:121-182`):
  - requires `closing.edit`;
  - the window must run forwards and counted cash must not be null;
  - refuses a window that is already closed (plus the unique constraint, `023:84`);
  - **recomputes `z_report` from the cloud ledger at call time**;
  - inserts the close row with `closed_at` (default `now()`), `closed_by=auth.uid()`, and `variance = round(counted - expected_cash, 2)` computed on the server. Expected values are frozen into the row.
- A direct insert is revoked (`023:103`). Tests: `tests/023_z_report_test.sql:214-305`.
- Idempotency: a duplicate window raises an error, so replay is safe if that error is treated as success. **However, the stored expected figures and variance are only correct if every ledger write for the window reached the cloud first, with its original `paid_at`.**
- State a local copy needs:
  - the full ledger with true `paid_at`;
  - sales `order_date`, `kind` and `voided_at`;
  - `lab_status_changed_at`;
  - the store time zone and setting;
  - the existing closes, for the duplicate check.

### 2.8 Other reads that depend on money

None of these write anything. All of them can be computed locally from the replicated tables.
- `report_sales_window` (`022:272-311`): revenue = SUM(net_amount) and paid = SUM(amount_paid) over live sales by `order_date`; `order_count` counts kind 'sale'.
- `report_payment_mix` (`016:123-134`): ledger summed by `paid_at`.
- `report_voided_count` (`016:141-151`).
- `customer_balance` / `customer_debtors` (`018:166-260`): balance = SUM(net) of live sales minus ledger or `amount_paid`.

### 2.9 Purchases and stock (money only through cost and stock)

**Purchases**
- `useAddPurchase` inserts directly into `purchases` (`data/suppliers.ts:142-152`).
- `useAddPurchaseWithItems` inserts directly into `purchase_items`, then calls `receive_purchase` (`:233-258`).
- `receive_purchase` (`029:589-675`):
  - for every line with `received_at` null it inserts a `stock_movements` row (`+qty`, `type='purchase'`, `ref_no=purchase id`, `created_at=now()`);
  - it re-averages `inventory.cost_price` using the **current** `stock_qty`, so the result depends on the order operations arrive in;
  - it stamps `received_at=now()`.
  - Lines already stamped are skipped, so replay is idempotent and safe.

**Purchase payments**
- `useAddPurchasePayment` inserts directly into `purchase_payments` (`:298-315`). There is no trigger and no ceiling, so this can be a plain row upsert.
- Deletes go through `delete_purchase` / `delete_purchase_payment`. A replay raises "not found", which can be treated as success.

**Stock adjustments and new products**
- `useAdjustStock` inserts directly into `stock_movements` and needs `inventory.edit` (`data/inventory.ts:199-224`). The row can carry a client id. The stock cache trigger adds `qty`. **Never upsert `inventory.stock_qty` alongside movements**, or stock is double-counted.
- `add_inventory_item` (`data/inventory.ts:150-176`; server `029:564-587`) ignores any client `id`, so the server generates it. It is not idempotent.
- `findOrCreateFrame` does a **direct** `inventory` insert (`POSContext.tsx:455-458`), so it could carry a client id.

---

## 3. Values the server decides for itself (the local copy cannot dictate these through today's API)

| Value | Where it is decided | Can the client control it? |
|---|---|---|
| `sales.id`, `sale_items.id`, `sale_payments.id`, `stock_movements.id`, `order_examinations.id` | uuid defaults inside the RPC inserts (`029:343-405`) | **No**: column lists exclude id |
| `invoice_no` | client number if free **in any store**, otherwise `next_invoice_no()` (`029:334-340`) | Partly: it can be silently renumbered |
| `invoice_counter.next_val` | only `next_invoice_no()` advances it; client-supplied numbers do **not** | n/a |
| `total_amount`, `discount`, `net_amount` | `price_cart` (`013:259-357`) | Only `net`, and only through re-pricing |
| `amount_paid` | ledger trigger (`013:231-247`) | No |
| `kind` (sale or prescription) | `029:324-331` | Claim only |
| `store_id` | `auth_store_id()` | No |
| `sales.user_id` | **`auth.uid()`** (`029:349`) | **No** |
| `sale_payments.recorded_by` | **`auth.uid()`** (`029:403,552,815`; `028:355`; `014:394`) | **No** |
| `voided_by`, `closed_by`, `audit_log.actor` | `auth.uid()` | No |
| `order_date` | `coalesce(client, now())` | **Yes**, but the client computes it at send time (`sales.ts:619`) |
| `sale_payments.paid_at` | `coalesce(client, now())` in create/update; **`now()` only** in collect, refund and void | Create/update: yes (the client never sends it). Others: **no** |
| `stock_movements.created_at` | `now()` in every RPC | No |
| `voided_at`, `shift_closes.closed_at`, `received_at`, the lab timestamps | `now()` | No |
| `shift_closes` expected figures and variance | `z_report` at call time | No |
| Stock movements for sale, return and purchase | written by the RPCs | No |

---

## 4. Defects and hazards on `main` that bear directly on offline sync

**H1. Re-checkout silently changes past money.**
- `update_sale_order` deletes every `sale_payments` row for the sale, including refund rows and later collections (`029:496`).
- It re-inserts only what the client sends, and the client sends one collapsed line (`POSContext.tsx:770-773`).
- It cannot re-insert refunds, because negative lines are refused (`029:431`).
- Effects:
  - split tenders become one method string ("cash + instapay"), which cannot be refunded per tender through `refund_sale` and does not count as `cash` in `z_report`;
  - all `paid_at` values become `now()`, which moves the original day's money into today's Z report;
  - `recorded_by` becomes whoever edited the sale;
  - refund history is erased (net amount_paid is preserved, but as a fresh positive payment).

**H2. Re-checkout re-dates the sale's stock movements** to `now()`, by delete and re-insert (`029:497-498,527-531`).

**H3. Line discounts sent through re-checkout leave a phantom balance (likely, not tested).**
- In `price_cart`, when line discounts are present: `v_line_net = items - Σline_disc`, `v_discount = line_net - net`, and `v_net = total - discount = net + Σline_disc` (`013:342-354`).
- Example: items 1000, line discount 100, client net 900. The server stores total 1000, discount 0, net 1000. Paid is 900, so 100 shows as owed.
- First checkout avoids this only because `useCreateSale` strips line discounts (`sales.ts:634-640`), which also loses the discount reasons. Re-checkout sends them (`sales.ts:858-866`).
- Test G7 (`tests/013_void_refunds_test.sql:372-381`) does not check the header.

**H4. Voiding after a partial refund fails (likely, not tested).**
- `void_sale` mirrors every **payment** row but ignores existing refunds (`014:390-398`).
- Example: 300 cash and 400 wallet paid, then a 100 cash refund. The void adds −300 and −400, so the ledger sums to −100.
- The trigger then sets `amount_paid = -100`, which breaks `sales_amount_paid_nonneg` (`012:187`), and the void aborts.
- Test 028 G-R7 sets `voided_at` by hand, so it does not exercise this (`tests/028_partial_refund_test.sql:181-191`).

**H5. A replayed checkout gets the wrong date in reports.** `order_date` is computed inside mutationFn (`sales.ts:619`), and a paused TanStack mutation runs mutationFn only once it is resumed online. So a sale rung up offline is dated at **sync time**. Its payments are also stamped `now()` at sync (`029:401`). Both Z reports and revenue reports misattribute the sale.

**H6. The offline queue cannot replay after a page reload.**
- `setMutationDefaults(CHECKOUT_MUTATION_KEY, …)` sets no `mutationFn` (`lib/queryClient.ts:26-33`).
- A paused mutation restored from localStorage (`main.tsx:18-36`) therefore has no function to run, and TanStack v5 rejects it with "No mutationFn found".
- The queued sale is effectively lost, even though the cashier was told it was saved.
- The queue lives only in `localStorage` under `lensy-query-cache`, along with the query cache, with `maxAge` 24h (`queryClient.ts:37-42`).

**H7. "Saved on this device" can appear when nothing was queued.**
- In `finishOrder`, several network calls run **before** `createSale.mutateAsync`: `resolveStaffUserId()` (which calls `auth.getUser()`) at `POSContext.tsx:627`, `addMissingOrderMetadata` at `:569`, and `findOrderImages` at `:591`.
- If any of them throws while offline, the catch block sees `isQueuedOffline()` and tells the cashier "Saved on this device. It will sync…" (`:661-666`).
- No mutation was ever created, so the sale is lost while the cashier is told it was saved.
- Also, entering the cart needs `next_invoice_no` online (`:361`). Offline, a new sale cannot reach the cart.

**H8. The idempotency check runs too late.** In `create_sale_order`, the checks for permission, licence, customer, product and store run **before** the idempotency lookup (`029:267-286`). Replaying a checkout that already succeeded fails when:
- the cashier was later deactivated or lost `pos.create`;
- the licence lapsed;
- the customer or product was removed.

**H9. A replay is re-priced and re-checked for stock.** If the price of a product changes on the PC after an offline sale but before sync, the replay is rejected with `price changed` (`013:317-320`), unless the outbox delivers strictly in order and the price-change row lands after the sale. With `allow_negative_stock=false`, a stock adjustment that reaches the cloud first can make the replay fail with `insufficient stock`.

**H10. Attribution is forced to whoever is signed in when syncing.** `user_id` and `recorded_by` are always `auth.uid()` (section 3). If one sync identity replays everything, every sale, payment, refund and void is credited to that identity, not to the cashier who did it.

**H11. Server ids differ from local ids.** Server-generated ids mean any later operation on an offline-created sale (collect, refund, void, re-checkout, `set_lab_status`, photo update) needs the **server** sale id. That id can only be recovered by looking up `(store_id, idempotency_key)` or invoice_no. The same applies to `add_inventory_item` (server id). Direct `inventory` and `customers` inserts can carry client ids.

**H12. Invoice numbers are unique across all stores, and a taken number is silently replaced** (`029:334-340`). A number the PC minted can be renumbered in the cloud, so the printed receipt and the cloud invoice disagree. Also, `invoice_counter` is never advanced by client-supplied numbers. Any later `next_invoice_no()` call (for example from a second device) hands out a number that may already exist, which the client then has to retry around (`sales.ts:661-664`).

**H13. The licence blocks the whole outbox.** Every write function and policy requires `license_write_ok`. A store in grace or expired keeps selling on the PC, but nothing syncs until the licence is renewed.

**H14. Payment method rules differ between functions.** `collect_sale_payment` accepts only `cash|wallet|instapay|card` (`029:809`). Create and update accept any text. `refund_sale` matches the method exactly (`028:338`). A local copy must normalise methods exactly the same way.

---

## 5. Conclusion: what can be a plain row upsert, and what must be replayed as a function call

### 5.1 Under the current schema and grants (no new migration)

**Can be plain row upserts from the PC** (they need the matching permission and an active licence):
- `customers` (client id allowed)
- `inventory` metadata, through direct insert or update with a client id. **Exclude `stock_qty`**: it is a trigger cache.
- `purchases`, `purchase_items` (insert or update only; deletes go through the RPC)
- `purchase_payments` (insert or update). There is no ledger trigger and no ceiling. `paid_at` is a date and is client-controlled.
- `stock_movements` for manual adjustments, as **insert only**, with a client id and client `created_at`. Update and delete are blocked. Each insert adds `qty` to `stock_qty` through the trigger.
- Non-money header fields on `sales` (doctor_name, delivery_date, photo paths) through UPDATE with `history.edit`. `lab_status` updates are re-stamped with `now()` by the trigger.

**Must be function calls, because direct writes are revoked or guarded:**

| Operation | Function and arguments | Safe to replay? |
|---|---|---|
| Create sale or prescription | `create_sale_order(p_sale{invoice_no, customer_id, order_date, delivery_date, doctor_name, lab_status, photo paths, net_amount, amount_paid, payment_method, kind}, p_items[{product_id, qty, unit_price, total_price, name, discount?, discount_reason?}], p_exams[...], p_payments[{method, amount, kind:'payment', note?, paid_at}], p_idempotency_key)` | **Yes, by key**, but see H8 and H9. Must send the original `order_date` and each payment's `paid_at` (both are accepted). `user_id` / `recorded_by` / ids / movement `created_at` will still differ from the local copy. |
| Re-checkout | `update_sale_order(server_sale_id, p_sale, p_items, p_exams, p_payments[...with paid_at])` | Same end state on replay, but no key. Destroys refunds and later payments (H1). Re-dates movements (H2). Must not be replayed out of order with collect, refund or void on the same sale. |
| Add payment | `collect_sale_payment(server_sale_id, [{amount, method}])` | **No.** No key. Each replay adds money, limited only by the balance. `paid_at = now()` (cannot be backdated). |
| Partial refund | `refund_sale(server_sale_id, amount, method, reason)` | **No.** No key. Each replay refunds again, limited only by the per-tender ceiling. `paid_at = now()`. |
| Void | `void_sale(server_sale_id, reason, restock)` | **Yes, if the error is treated as success** ("already voided"). `voided_at` and the refund rows use `now()`. Fails after a partial refund (H4). |
| Close shift | `close_shift(from, to, counted_cash, note)` | **Yes, if the error is treated as success** (duplicate window). Expected figures are **recomputed from the cloud** at call time, so the close must be replayed after every ledger write for the window, with true `paid_at`. Otherwise the stored variance differs from what the cashier saw. |
| Receive purchase | `receive_purchase(purchase_id)` | **Yes** (lines already received are skipped). The cost average depends on the current `stock_qty`, so order matters. |
| Add product with opening stock | `add_inventory_item(p_product, n)` | **No** (server id, no key). Prefer a direct insert with a client id plus an `initial` movement row. |
| Delete purchase or purchase payment | `delete_purchase(id)`, `delete_purchase_payment(id)` | Yes ("not found" on a second call). |
| Lab status | `set_lab_status(server_sale_id, status)` | Same end state; the trigger re-stamps `now()`, which affects `z_report.lab_delivered`. |

**Local-only or read operations (never sent):** `z_report`, `store_day_range`, every `report_*`, `customer_balance` / `customer_debtors`, and `next_invoice_no`. A local engine must reproduce them from its own copy of the tables, including the store time-zone rule (setting `time_zone`, then `stores.time_zone`, then UTC), the [from, to) windows, `kind`/`voided_at` filtering, and void mirror rows that cancel in the sum.

### 5.2 Why replaying the RPCs is a poor fit for "the PC is the source of truth"

1. The RPCs **re-decide** values the PC has already decided: ids, invoice numbers (H12), pricing (H9), `user_id` / `recorded_by` (H10), every `now()` timestamp (H5, section 3), and the close's expected figures. So the cloud copy would not match the PC on exactly the fields the owner's phone shows.
2. Three of the operations (collect, refund, re-checkout) are not idempotent by key, and two (void, close) are idempotent only by matching error messages.
3. Every follow-up operation needs the cloud id of the sale, which differs from the local one (H11).

### 5.3 What a design needs to settle (input for the designer)

- **Option A: replay RPCs (smallest server change).** Requires:
  - a client-generated sale id (or an idempotency key) on every money RPC;
  - idempotency keys on `collect_sale_payment`, `refund_sale`, `void_sale` and `close_shift`;
  - optional `paid_at`, `voided_at`, `closed_at` and actor parameters, trusted only from a dedicated sync identity;
  - moving the idempotency lookup before the permission and licence checks (H8);
  - accepting the PC's invoice number verbatim, made unique per store (H12);
  - a strictly ordered outbox per sale;
  - a decision on whether the cloud should re-price at all.
- **Option B: one server ingest function (closest to "one-way replica").** A new SECURITY DEFINER function, for example `ingest_batch(jsonb)`, that accepts PC-authored rows verbatim with client ids, timestamps and actors, and checks only the database invariants:
  - `net = total - discount`, discount ≤ total, ledger sum ≥ 0, `total_price = qty * unit_price`, the kind whitelist;
  - it raises `lensy.money_write` to get past the guard triggers;
  - it avoids double-counting `stock_qty` (insert movements and let the trigger compute the cache);
  - it inserts `shift_closes` as the PC computed them;
  - it is idempotent through `on conflict (id) do nothing/update`.
  - The per-row cost is the same as an RPC call, so bandwidth is no worse.
  - The RPC permission checks (`resolve_can`) and price checks then run **on the PC**, which must hold the permission matrix, licence state and catalog locally.
- **Either way, fix first:** H1, H3, H4 (money-correctness bugs that exist on `main` today), and H5, H6, H7 (the current checkout-only offline replay can lose sales or mis-date them).

### 5.4 Minimum state the shop PC must hold to compute what the server computes today

- Catalog `sale_price` and `stock_qty` per product, and `stores.allow_negative_stock`.
- An invoice counter per store, seeded as the highest numeric invoice_no + 1, 6-digit zero-padded below 1,000,000 (`012:151-165`).
- The full `sale_payments` ledger with `method`, `kind`, `amount` and `paid_at`. From it the PC derives `amount_paid`, the balance (net − Σledger), the per-tender refund ceiling (Σledger by method), and the Z-report tender totals.
- Sales headers with `net_amount`, `total_amount`, `discount`, `voided_at`, `kind`, `order_date`, `lab_status_changed_at`.
- `sale_items`, needed for restock-on-void and for re-checkout stock netting.
- `stock_movements`, the stock ledger.
- `shift_closes`, for the duplicate-window check and history.
- The store time zone (setting, then column, then UTC).
- Users, roles, `role_permissions` and `user_permissions`, with `resolve_can` semantics (`029:52-71`: an explicit override wins, an admin or owner role bypasses, and every action also needs its `.view` code).
- Licence state, from `license_write_ok` and `my_license_state` (026).


### REPORT: rbac
# RBAC / Auth / Store Resolution on `main` (cf78ca5): map, and what one register login does to it

Scope: read-only analysis of `main`. All paths are relative to `D:/Projects/optical-pos/optical-pos`. Where a function was redefined, the line cited is the **latest** definition.

---

## 1. TL;DR for the designer

1. **Identity is `auth.uid()` and nothing else.** A login resolves to a `public.users` row only by `users.id = auth.uid()`. That row must be active and have a role in the same store (`web/supabase/029_effective_permissions.sql:74-79`). The store is `users.store_id`. The old username fallback is gone (`014_server_rbac.sql:306-312`, then 029).
2. **Every privileged server function checks the CALLER.** `require_perm(code)` calls `resolve_can(code)`, which defaults `p_user` to `auth.uid()` (`014:162-168`, `029:52-71`). The restrictive RLS action policies also call `resolve_can(code)` with no user, so they mean the caller too (`029:210-240`).
3. **Attribution is server-side from `auth.uid()`.** It is never taken from the client on main. `sales.user_id`, `sale_payments.recorded_by`, `sales.voided_by`, `shift_closes.closed_by` and `audit_log.actor` are all `auth.uid()`. The client still sends `user_id`, but `create_sale_order` ignores it (`029:349`; client `web/src/data/sales.ts:613`, `web/src/features/pos/POSContext.tsx:627`).
4. **Event times are mostly server `now()`.** Exceptions: checkout `order_date` and `paid_at` honour client values (`029:352,401`). Void, refund, payment collection, close, lab status and stock movements use `now()`. A replay hours later lands in the wrong Z-report window.
5. **Consequence of one device login replaying everyone's work:**
   - Every sale, payment, refund, void and close is attributed to the device account.
   - Every permission check is evaluated as the device account. If that is a store admin, it is an all-pass bypass (`029:62`).
   - The admin-only and "not on yourself" guards protect or check the wrong person.
   - The device account uses up a `max_staff` seat.
   - A cashier with `staff.edit` on the PC could assign Owner/Admin through the device (`029:97-98,177`).
6. **Direct table writes to the money tables are revoked** (`029:739-740,818`; `013:816-827` drops DELETE). The reference branch's row replication cannot work on main for sales, items, payments, exams or voids. Sync must replay **commands (RPCs)**, not rows.
7. **Fix shape:**
   - A dedicated **register principal** (not a staff admin).
   - A single **`register_apply` envelope RPC** with op-id idempotency, a sequence number, `p_actor` and `p_occurred_at`.
   - Internal actor-aware variants of each money/workflow function.
   - Licence evaluated at event time (needs a new `revoked_at`).
   - Attribution FKs re-pointed from `auth.users` to `public.users`, so cashiers do not need cloud logins.
   - A store flag that makes the cloud write-only-via-register, so the owner's phone is read-only by enforcement, not just by build.

---

## 2. How a login becomes a staff row and a store

### 2.1 Client
- **Sign-in:** username to email `<username>@${VITE_AUTH_EMAIL_DOMAIN ?? 'lensypos.local'}` (`web/src/lib/auth.tsx:20-26`), then `supabase.auth.signInWithPassword` (`auth.tsx:54-58`). This always needs the network; there is no offline path on main.
- **Sign-out:** clears the POS draft, the query cache and `localStorage['lensy-query-cache']` (`auth.tsx:60-70`).
- **Staff row:** `users.select('*, roles(*)').eq('id', uid)`, keyed only by auth UUID (`web/src/data/staff.ts:16-20`).
  - `useCurrentUser` polls it every **15 s** (`staff.ts:21-25`).
  - `resolveStaffUserId()` (`staff.ts:26-30`) is used for client attribution, which the server now ignores.
- **Store:**
  - `useStoreId()` calls RPC `auth_store_id` with `staleTime: Infinity` (`web/src/lib/licensing.ts:58-69`).
  - `useMyLicense()` calls `my_license_state` with `staleTime: 60 s` (`licensing.ts:44-55`).
  - `useIsPlatformAdminQuery()` calls `is_platform_admin` (`licensing.ts:77-88`).
  - All three are gated on a hydrated session (`licensing.ts:29-32`), so an anon call cannot cache "no store".
- **App gates** (`web/src/components/AppLayout.tsx`):
  - Inactive or unassigned shows the "No position / Inactive" screen (`:39-42`).
  - `license.data === null` shows "not linked to a store" (`:54`).
  - `expired` or `none` blocks the app (`:84`).
  - `grace` shows a read-only banner (`:170-172`).
  - **`pending` (licence starts in the future, from 026) is not blocked by the UI.** The server refuses writes because `license_write_ok` checks `starts_at`.

### 2.2 Server
- **`auth_store_id()`** (`029:74-79`) returns `users.store_id` where `users.id = auth.uid()`, `is_active`, and the role exists **in the same store**.
  - Deactivating a user, or removing their role, cuts every RLS policy immediately, even with a still-valid JWT. Test: `web/supabase/tests/029_effective_permissions_test.sql:56`.
- **`is_platform_admin()`** checks for a row in `platform_admins` (`008:211-214`). Vendors have no `users` row because `store_id` is NOT NULL (`021:256-270`). The first vendor comes from `bootstrap_platform_admin` (`021:221-273`, not executable by clients, `:278`).
- **`link_staff_ids()`** (`015:36-131`) repaired legacy rows so that `users.id = auth.users.id`. That equality is now an invariant: `create-user` inserts `users.id = data.user.id` (`supabase/functions/create-user/index.ts:128-136`).
- **`staff_id_problems` view** is granted to `authenticated` (`015:156-168`). It reads `auth.users` counts. This is a minor leak to note.
- **`tenant_fill_store_id` trigger** fills `store_id` from `auth_store_id()` on insert (`008:240-247`, attached to about 20 tables at `008:253-266`).

---

## 3. The RBAC model

### 3.1 Rules (client mirror and server)
- **Catalogue:**
  - Server: `supported_permissions()` (`029:9-21`).
  - Client: `RESOURCES` (`web/src/data/permissionModel.ts:2-14`). Codes are `pos.{view,create,edit}`, `customers.*`, `inventory.{view,create,edit}`, `lab.{view,edit}`, `history.{view,edit,void,refund}`, `reports.view`, `closing.{view,edit}`, `suppliers.*`, `notes.*`, `staff.*`, `settings.{view,edit}`.
  - Server maps `purchases.*` to `suppliers.*` (`029:54`).
- **`resolve_can(code, p_user default auth.uid())`** (`029:52-71`):
  1. Unknown code: false.
  2. `p_user = auth.uid()` and platform admin: true.
  3. User must be active with a role in the same store, otherwise false.
  4. `is_store_admin(p_user)`: true. That means role name `admin` or `owner`, case-insensitive and trimmed (`029:44-50`). Note: the 014 `superadmin`-username bypass is gone in 029.
  5. A per-user override (`user_permissions.allow`) wins; otherwise the role grant decides.
  6. Non-`.view` codes also require `<resource>.view`.
- **Client `resolveCan`** has the same override/role/view logic (`permissionModel.ts:25-29`). The bypass names are `admin` and `owner` (`:17`).
- **UI authority is the server:**
  - `PermissionsProvider` calls RPC `my_permissions()` and polls every **15 s**, with `refetchOnWindowFocus: 'always'` (`web/src/data/permissions.tsx:57-87`, rpc `:63`, interval `:68`).
  - `my_permissions()` returns `{is_admin, active, assigned, codes[]}` (`029:81-89`).
- **`require_perm(code)`** raises 42501 `insufficient permission: <code>` (`014:162-168`).
- **`resolve_can(text, uuid)` is granted to `authenticated`** (`014:526`, preserved by 029's create-or-replace). Any signed-in user can probe **any** user's permissions in any store, because there is no store check on `p_user`. The actor-aware design must use a **non-granted internal variant**.

### 3.2 Staff and RBAC management (server-checked, as the caller)
These RPCs replace direct writes. Direct INSERT/UPDATE/DELETE on `roles`, `users`, `role_permissions` and `user_permissions` is revoked (`029:186`); platform-only insert is kept (`029:188-194`).

| RPC | Checks | Self / admin guards keyed on `auth.uid()` |
|---|---|---|
| `require_staff_editor(store)` `029:101-109` | `staff.edit` + same store + `license_write_ok` | — |
| `create_staff_role(name)` `029:111-123` | `staff_editor`; reserved names admin/owner/superadmin | — |
| `set_role_permission` `029:125-145` | `staff_editor`; admin/owner roles immutable | cannot drop `staff.view` / `staff.edit` from **the caller's own** role (`:135-137`) |
| `set_user_permission` `029:147-164` | `staff_editor`; target cannot be an admin or platform admin | `p_user = auth.uid()` refused (`:154`) |
| `set_staff_access(user, role, active)` `029:166-182` | `staff_editor`; `can_assign_role`; `staff.delete` to change active | self refused (`:175`); only an admin may change an admin (`:177`); store row lock (`:171`) |
| `can_assign_role(role, store)` `029:93-99` | `staff.edit` + same store + licence; admin/owner roles only if **caller** `is_store_admin()` | — |

**`create-user` Edge Function** (`supabase/functions/create-user/index.ts`, rules in `authz.ts`):
- It asks the database **as the caller** using an anon client plus the caller's JWT: `auth_uid`, `auth_store_id`, `is_platform_admin`, `resolve_can('staff.create')`, `resolve_can('staff.edit')`, `license_write_ok` (`index.ts:62-76`).
- **Seat count:** `my_store_license().max_staff` against `count(users where store_id)` (`:91-98`, `authz.ts:137-149`).
- `can_assign_role` is checked as the caller (`:106-108`).
- The service role is used only to `auth.admin.createUser` and insert the mirror row with the **pinned** store (`:111-136`).
- Rules in `authz.ts`: `superadmin` username reserved (`authz.ts:92`), password at least 6 characters (`:63,96`), a non-platform caller cannot name another store (`:108-127`).
- Client entry point: `StaffPage.tsx:31-33`.
- Tests: `web/src/lib/createUserAuthz.test.ts`.
- **Needs internet and Supabase Auth.** Staff cannot be created offline on main.

---

## 4. Inventory of server write paths: what is checked, and for whom

"Caller" below means `auth.uid()`. Every row is evaluated against the JWT holder.

| Function (latest def) | Permission check | Licence | Attribution written | Time written | Idempotent on replay? |
|---|---|---|---|---|---|
| `create_sale_order` `029:246-408` | `pos.create` (`:270`); customer and products must be in the caller's store (`:267-268`) | `license_write_ok` (`:271`) | `sales.user_id = auth.uid()` (`:349`), `sale_payments.recorded_by = auth.uid()` (`:403`) | `order_date = coalesce(client, now())` (`:352`); `paid_at = coalesce(client, now())` (`:401`); stock movement `now()` (`:381`) | **Yes**: `idempotency_key` (`:278-286,355-365`; unique index `012:169-172`). Client invoice number kept only if free, otherwise renumbered silently (`:334-340`) |
| `update_sale_order` `029:410-562` | `pos.edit` OR `history.edit` (`:432`); `lab.edit` if lab status changes (`:458-459`); **`is_store_admin()`** to replace rx/frame images (`:460-464`); `history.refund` if paid decreases (`:489`) | yes (`:433,441`) | `recorded_by = auth.uid()` (`:552`); delete-and-reinsert of payments loses the original recorders (`:496`) | stock `now()` | No key (full replace, so effectively idempotent but last-writer-wins) |
| `void_sale` `014:338-408` (not redefined later) | `history.void` (`:348`) | yes (`:356`) | `voided_by = auth.uid()` (`:402`), refund rows `recorded_by = auth.uid()` (`:394`) | `voided_at = now()`, refund `paid_at = now()`, stock `now()` (`:383,393,401`) | Second call raises "already voided" (`:370`): an error, not a no-op |
| `refund_sale` `028:96-169` | `history.refund` (`:108`) | yes (`:116`) | `recorded_by = auth.uid()` (`:163`) | `paid_at = now()` (`:163`) | **No.** A replay refunds twice (bounded only by the per-tender ceiling `:143-151`) |
| `collect_sale_payment` `029:800-817` | `history.edit` (`:804`) | `license_write_ok` with no platform bypass (`:805`) | `recorded_by = auth.uid()` (`:815`) | `paid_at = now()` | **No.** A replay collects twice (bounded by balance `:813`) |
| `close_shift` `024:121-182` | `closing.edit` (`:142`) | **none** (no licence check) | `closed_by = auth.uid()` (`:174`) | `closed_at` default `now()` (`023:61`) | Duplicate window raises (`:157-163`, unique `023:89-91`). **`expected_*` is recomputed from the cloud ledger at call time** via `z_report` (`:167`) |
| `z_report` `023:112-163` (read) | none (reads are not permission-gated, by design `014:44-48`) | — | — | windows on `paid_at` / `order_date` / `lab_status_changed_at` | — |
| `set_lab_status` `029:748-756` | `lab.edit` | yes (`:752`) | none; `lab_started_by` exists but nothing writes it (`019:42`) | `lab_status_changed_at` via trigger `now()` (`019:76-104`) | effectively yes |
| `replace_order_examinations` `029:758-770` | `history.edit` | yes | — | — | yes (replace) |
| `add_inventory_item` `029:564-587` | `inventory.create` | yes | audit only | — | **No** (new row each call) |
| `receive_purchase` `029:589-675` | `suppliers.edit` | yes | audit only | `now()` | yes (`received_at` stamp + row lock) |
| `delete_purchase` / `delete_purchase_payment` `029:677-737` | `suppliers.delete` / `suppliers.edit` (+ the `purchases.*` alias) | yes | audit only | — | yes-ish (raises "not found" on replay) |
| Staff/RBAC RPCs (§3.2) | `staff.edit` / `staff.delete` as caller | yes | audit only | — | mostly idempotent |

**Direct table writes still allowed, all checked as the caller through RLS:**
- The tenant + licence policies (`008:287-341`).
- RESTRICTIVE action policies with `resolve_can('<code>')` (`029:210-240`) on: customers, inventory, suppliers, purchases, purchase_items, purchase_payments, notes, settings, lens_types, frame_colors, frame_types, stock_movements. stock_movements is insert-only; update/delete are `false`.
- **`sales` PATCH:** RLS `history.edit` (`029:794-796`) plus the trigger `guard_sale_access` (`029:774-793`):
  - Only header fields can change.
  - `lab.edit` is required for a status change.
  - **`is_store_admin()`** is required to replace images.
  - The trigger skips when `current_user <> 'authenticated'`, i.e. inside SECURITY DEFINER functions (`:777`).
- **`notes`:**
  - Visibility: `notes.view` and (`user_id is null` or `= auth.uid()`) (`029:821-823`).
  - Insert: **`created_by = auth.uid()`** and (`user_id null` or `= auth.uid()`) (`029:824-826`).
  - Update: own only (`:827-829`). Delete: own or admin (`:830-832`).
  - The client sends `created_by` from `resolveStaffUserId()` (`web/src/data/notes.ts:52-56`).
- **`note_seen`:** the client supplies `user_id` freely (`notes.ts:104-108`). There is no actor policy beyond tenancy.
- **Revoked outright:**
  - INSERT/UPDATE/DELETE on `sale_items` and `order_examinations`; INSERT/DELETE on `sales` (`029:739-740`).
  - INSERT/UPDATE/DELETE on `sale_payments` (`029:818`).
  - DELETE on the money tables (`013:816-827`).
  - Sales money columns are guarded by the transaction-local GUC `lensy.money_write` (`013:208-245`; `029:500,556`). This is **existing precedent for a transaction-local flag set only inside definer functions.**

**Audit trail:**
- `audit_row()` writes `actor = auth.uid()` (`014:88-111`, actor at `:104`).
- It is attached to: sales, sale_items, sale_payments, stock_movements, purchases, purchase_items, purchase_payments, role_permissions, user_permissions, users, roles (`014:480-484`), and store_licenses (`026:225-227`).
- Customers, inventory, suppliers, notes and settings have **no** audit and **no** actor column.

**Attribution FK targets (important for "staff without cloud logins"):**
- `sales.user_id` references **`public.users(id)`** (`000_base_schema.sql:156`).
- `sale_payments.recorded_by` references **`auth.users(id)`**, default `auth.uid()` (`011_sale_payments.sql:52`).
- `sales.voided_by` references **`auth.users(id)`** (`013_void_refunds.sql:85`).
- `shift_closes.closed_by` references **`auth.users(id)`** (`023_z_report.sql:62`).
- `notes.created_by` references `public.users(id)` (`004_rbac_notes.sql:45`).

---

## 5. Licence and plan features

- **One licence per store** (`store_licenses.store_id` UNIQUE, `008:37-50`). Fields: `plan`, `max_staff`, `is_revoked`, `features jsonb`, `starts_at`, `expires_at`.
- **`license_read_ok`:** not revoked, `starts_at <= now()`, and `expires_at` null or `> now() - 30 days` (`026:42-51`).
- **`license_write_ok`:** the same but `expires_at > now()` (`026:54-63`). All checks use **server `now()`**.
- **`my_license_state()`** returns state `none|expired|pending|active|grace`, plus plan, starts_at, expires_at, store_name (`026:82-103`).
- **Vendor-only setters:** `set_license_window` takes store-local dates; expiry is the exclusive end of the day in the store's time zone (`026:112-182`). `set_license_revoked` is a boolean only, **with no timestamp** (`026:187-215`).
- **`license_feature(name)`:** reads the caller's store `features`. Only exact `'true'` or `'false'` counts; absent or malformed means **allowed** (`027_plan_features.sql:54-65`). The only enforcement is `platform_report_window` (`027:106-108`). No per-screen feature gating exists yet.
- **`max_staff`** is enforced only in `create-user` (`index.ts:89-99`). It counts **all** `users` rows of the store, so a device account with a `users` row consumes a seat.
- **Schema version gate:** client `EXPECTED_SCHEMA_VERSION = 29` against RPC `schema_version`, read once per session (`web/src/lib/schemaVersion.ts:10,54`).

---

## 6. KEY QUESTION: one device login replays all staff actions. What breaks?

This assumes the reference-branch model: a store-admin "device account" (`origin/offline-first:web/src/lib/local/sync.ts:19-21`; `claim_register` requires an admin, `origin/offline-first:web/supabase/011_multistore_hardening.sql:286-314`). Staff sign in locally with PBKDF2 verifiers (`origin/offline-first:web/src/lib/local/localAuth.ts:1-15,113-140`).

### 6.1 Mis-attribution (every row says "device")
- Who sold: `sales.user_id` (`029:349`). Who took or refunded money: `sale_payments.recorded_by` (`029:403,552,815`; `028:163`; `014:394`).
- Who voided: `sales.voided_by` (`014:402`). Who closed the till: `shift_closes.closed_by` (`024:174`).
- The whole audit trail: `audit_log.actor` (`014:104`).
- Notes cannot be inserted as another author at all (policy `029:825-826`). Private notes (`user_id` = a cashier) can be neither inserted nor read by the device (`029:822-826`).
- `update_sale_order` deletes and reinserts payments, rewriting every historical `recorded_by` to the device (`029:496,543-554`).
- Per-cashier reporting and Z-report accountability ("who was short") become meaningless.

### 6.2 Permission checks run as the device, not the cashier
- If the device is Admin/Owner, `resolve_can` returns true for everything (`029:62`). Every server check becomes a no-op:
  - `pos.create`, `history.void`, `history.refund`, `history.edit`, `closing.edit`, `lab.edit`, `inventory.*`, `suppliers.*`, `staff.*`.
  - The admin-only guards also pass: image replacement (`029:460-464`, `029:785-789`), changing an admin (`029:177`), and assigning Owner/Admin (`029:97-98`).
  - **Privilege escalation path:** if staff management is done on the PC and replayed by the device, a cashier who holds `staff.edit` locally can assign the Owner role, and the cloud cannot tell.
- If the device is not an admin, actions the cashier was allowed to do may be **refused** in the cloud, and the queue stalls.
- **Self-guards protect the wrong person.** "Ask another administrator to change your own access" (`029:154,175`) and the own-role `staff.edit` lock (`029:135-137`) key on `auth.uid()`. The device's row is protected; the real actor can edit himself.
- **`my_permissions()` returns the device's perms** (`029:81-89`). The PC UI must not use it for the person at the keyboard. `useIsAdmin` / `useCurrentUser` (`staff.ts:21-34`) would likewise describe the device.
- **Closing permission specifically:** `close_shift` requires `closing.edit` **of the caller** (`024:142`), so any cashier passes through an admin device. The figures are recomputed from the cloud at replay time (`024:167`), not what the cashier counted against. Because void, refund and collect stamp `paid_at = now()` at replay (`014:393`, `028:163`, `029:815`), money from a day synced late lands in the **sync day's** window:
  - the cloud `expected_cash` and `variance` differ from the PC's;
  - the next day's close double-counts it.

### 6.3 Store / licence / lifecycle coupling
- The device must stay an active user with a role in the store, or `auth_store_id()` becomes null and every RPC fails (`029:74-79`). Deactivating or demoting the device row from anywhere silently halts sync.
- The device row counts against `max_staff` (`index.ts:93-96`).
- **Licence is evaluated at replay time.** Work done offline while licensed, then synced after expiry or revocation, is refused (`license_write_ok`, `026:54-63`). The reverse also happens: work done after expiry on a PC with a wrong clock is accepted if synced early. `close_shift` has **no** licence check at all.
- **Permissions are evaluated at replay time.** A grant revoked between the action and the sync makes a legitimate past action fail. Test `029_effective_permissions_test.sql:56`: "revocation takes effect with same JWT".
- **Replays are not uniformly idempotent:**
  - `refund_sale` and `collect_sale_payment` duplicate money.
  - `void_sale` and `close_shift` raise errors on replay.
  - Only `create_sale_order` has a key.
- **Invoice numbers:** the cloud renumbers silently if the PC's number is taken (`029:334-340`), so the printed receipt and the cloud row can diverge. `next_invoice_no()` is a cloud counter (`012:140-166`) and the PC must allocate offline.
- **Staff creation offline is impossible:** the Edge Function plus Supabase Auth (`index.ts`). Direct `users` insert is revoked (`029:186`).

### 6.4 Security of the device credential
- A stolen device JWT or refresh token from the shop PC is a full **store-admin** cloud session. That covers RBAC edits, voids and refunds, all attributed to "device". There is no remote kill other than deactivating the device user, which also stops sync.
- `resolve_can(code, any_user)` is callable by anyone (`014:526`), which leaks the permission matrix across tenants.

### 6.5 Phone read-only
- On main, the owner's phone is a normal admin session. Nothing on the server prevents writes from it (only a build flag on the reference branch, `repositoryReadOnly.ts` / `VITE_READ_ONLY`).
- Any write from the phone forks the cloud from the PC, because sync is one-way and the PC never learns about it. Server-side enforcement is needed.

---

## 7. Server changes for "a trusted register acts on behalf of a named staff member"

These are ordered as a migration plan (030+). They keep every existing check; they change **whose** identity the checks use.

### 7.1 A register principal, distinct from staff
- **Table** `store_registers(store_id pk, device_id uuid, register_uid uuid unique references auth.users, claimed_by uuid, claimed_at, revoked_at timestamptz, last_seq bigint default 0, last_seen_at, last_license_check_at)`.
- **Credential:** created by an Edge Function `create-register`, modelled on `create-user`.
  - Authorisation as the caller: `is_store_admin()` + `license_write_ok`.
  - The service role creates an auth user with a random secret kept on the PC.
  - The function writes **no `public.users` row**. As a result:
    - `auth_store_id()` is null for it, so **every** ordinary RPC and RLS write refuses it. The device can do nothing except the register RPCs.
    - It does not consume a `max_staff` seat.
    - A stolen token can only submit actor-checked, audited ops.
- **`register_store_id()`:** the store where `register_uid = auth.uid()` and `revoked_at is null`.
- **Kill switch:** `revoke_register(store)` callable by `is_store_admin()` from the phone. This is the one cloud write the phone keeps.

### 7.2 Actor-aware core (minimal diff using existing precedent)
- **Internal, not granted** `resolve_can_for(code, actor, store)`: like `resolve_can` but **also** requires `actor.store_id = store`. Fix the grant of the public 2-arg form while here.
- **`effective_actor()`:**
  - Returns `nullif(current_setting('lensy.actor', true), '')::uuid` **only when** `register_store_id() is not null`; otherwise `auth.uid()`.
  - The GUC is set transaction-locally only inside `register_apply`, mirroring `lensy.money_write` (`013:208-245`).
  - PostgREST clients cannot set arbitrary GUCs, and the register check prevents a staff JWT from benefiting even if one were set.
  - The alternative is to refactor the internals to take an explicit `p_actor`. That is safer but a larger diff; recommend it for the money functions.
- **`effective_store()`:** `coalesce(register_store_id(), auth_store_id())`.
- **Replace `auth.uid()` / `auth_store_id()` with these at:**
  - `require_perm` (`014:162-168`) and `is_store_admin()` default arg (`029:44-50`).
  - `create_sale_order` `:349,403`; `update_sale_order` `:432,459-464,489,552`; `void_sale` `014:348,394,402`; `refund_sale` `028:108,163`.
  - `collect_sale_payment` `029:804,815`; `close_shift` `024:142,174`; `set_lab_status`; `replace_order_examinations`; `add_inventory_item`; `receive_purchase`; the purchase deletes.
  - `audit_row` `014:104`: add an `audit_log.via_register uuid` column.
  - `tenant_fill_store_id` `008:240-247`.
  - The notes policies `029:821-832`, or route notes through an op.
- **Self/admin guards must use the actor:** `029:135-137,154,175,177`, `can_assign_role` `029:97-98`.
- **Staff management:** keep it actor-checked and **ordered with the money ops.** Also refuse admin/owner assignment unless `is_store_admin(actor)`. That closes the escalation path in §6.2.

### 7.3 One envelope RPC: `register_apply`
```sql
register_apply(p_ops jsonb)  -- array of {op_id uuid, seq bigint, actor uuid, occurred_at timestamptz, kind text, args jsonb}
returns jsonb                -- compact per-op {op_id, status: ok|dup|rejected|flagged, ref, err}
```
- **Ledger** `register_ops(store_id, op_id pk, seq, actor, kind, occurred_at, received_at, status, result jsonb, violation text)`. A re-sent op returns the stored result, which gives **universal idempotency**, including refund, collect, void and close.
- **`seq` must be `last_seq + 1`.** A gap is refused, so the PC re-sends from the gap. This makes the cloud a strict replay of the PC's log, and is compact (one request per batch, small JSON).
- **Strict per-op validation (reject):**
  - caller is the register;
  - actor exists in **this** store and was a valid user;
  - args are well-formed;
  - store tenancy;
  - money invariants (ceilings, balance, no negative payments).
- **Policy checks:** `resolve_can_for(code, actor)`. Because staff/RBAC changes travel in the same ordered log, the cloud's RBAC state at op N equals the PC's state when op N happened. So **evaluating at replay is equivalent to evaluating at event time**, provided nothing else writes RBAC. That is the reason for §7.5.
  - For **money facts** (a sale, payment, refund, void or close that physically happened), recommend **accept-and-flag** (`status = 'flagged'`, `violation = 'insufficient permission: history.refund'`) rather than reject. Rejecting a cash event that already happened stalls the queue and loses the truth.
  - For **management ops**, reject.
- **Event time:**
  - Pass `occurred_at` into `order_date`, `paid_at`, `voided_at`, `closed_at`, `lab_status_changed_at` and `stock_movements.created_at`.
  - Bound it: `occurred_at <= received_at + skew` and `>= register claimed_at`. Ops must also be monotonic in seq, or at least not earlier than the previous op minus skew.
  - The `lab_status_stamp` trigger (`019`) needs an override GUC so it honours `occurred_at`.
- **Licence at event time:**
  - Add `store_licenses.revoked_at timestamptz`, set by `set_license_revoked` (`026:187-215`).
  - New `license_write_ok_at(store, ts)`: not revoked as of `ts`, `starts_at <= ts < expires_at`.
  - Add a cap so a tampered PC clock cannot backdate: `ts >= store_registers.last_license_check_at - offline_allowance`.
  - Give `close_shift` a licence check too.
- **Close:**
  - The op carries the PC's `counted_cash` **and** the PC's computed `expected_cash` / `expected_by_tender`.
  - The server recomputes `z_report` over the now event-timed ledger and stores both, with a `mismatch` flag.
  - The unique window (`023:89-91`) stays.
- **Invoice numbers:** the PC owns allocation, for example a per-register prefix. `create_sale_order` should **refuse** rather than renumber when called via the register, since a collision means divergence.

### 7.4 Let cashiers exist without cloud logins
- Re-point `sale_payments.recorded_by`, `sales.voided_by` and `shift_closes.closed_by` from `auth.users(id)` to **`public.users(id)`** (`011:52`, `013:85`, `023:62`). `sales.user_id` already targets `public.users`.
  - This is safe because `users.id = auth.users.id` for every existing login (015).
- Add an op `staff.create`: actor needs `staff.create` (plus `staff.edit` if a role is given); `max_staff` counted in SQL; reserved-name and admin-role rules from `authz.ts` and `029:117`.
  - It inserts a `public.users` row with a PC-generated UUID and **no** auth user.
  - Only people who need a cloud login (the owner's phone) go through `create-user`.
  - `auth_store_id()` is unaffected, because cashiers never call the cloud.
- Passwords for cashiers then live only on the PC (PBKDF2 verifiers, reference `localAuth.ts:113-140`). Drop the reference branch's online re-verification path (`localAuth.ts:166-189`) for staff who have no cloud account.

### 7.5 Make the cloud a read-only mirror except for the register
- Add a store flag `stores.register_only boolean`.
- New helper `direct_write_ok(store)`: `not register_only or register_store_id() = store or is_platform_admin()`.
- AND it into:
  - `license_write_ok` callers, or into each RESTRICTIVE action policy (`029:210-240`);
  - the sales PATCH policy (`029:794-796`);
  - every public write RPC, and the staff/RBAC RPCs (`029:101-182`).
- Exempt the vendor licence RPCs and `revoke_register`.
- Result: the owner's phone **cannot** write, regardless of build. RBAC state changes only through the ordered register log, which is what makes §7.3 sound.
- **Phone `my_permissions`:** when `register_only`, return only `*.view` codes, so the UI degrades naturally.

### 7.6 Tests to add (the pattern in `web/supabase/tests`; the shim impersonates via `request.jwt.claim.sub`, `tests/_shim.sql:54-62`)
- The register cannot call ordinary RPCs or tables; a staff JWT cannot benefit from `lensy.actor`.
- Actor attribution lands in `user_id`, `recorded_by`, `voided_by`, `closed_by` and `audit_log.actor`, with `via_register` set.
- Actor from another store is rejected; inactive actor is rejected or flagged.
- Duplicate `op_id` returns the stored result; a seq gap is refused.
- `occurred_at` is honoured and bounded.
- Licence at event time: before and after `revoked_at`.
- `register_only` blocks phone writes.
- An escalation attempt via `staff` ops by a non-admin actor is refused.

---

## 8. What the PC must cache to enforce RBAC and licence offline

**Identity and RBAC** (replicated from the cloud at setup, then maintained locally as the source of truth):
- `users`: id, username, full_name, role_id, store_id, is_active. Exclude the register principal.
- `roles`: id, name, store_id.
- `role_permissions` as role_id to code.
- `user_permissions` as user_id to {code, allow}.
- The catalogue: `supported_permissions` / `RESOURCES` (`029:9-21`, `permissionModel.ts:2-14`). Pin it to the app build and check it against the server version.
- **Rule engine identical to the server:** inactive or no role in the same store means deny (`029:58-61`); admin/owner bypass (`029:44-50,62`); override then role grant; `.view` prerequisite (`029:63-70`). Note the UI "openAccess" state means "No position" and is a deny screen (`AppLayout.tsx:39`).
- **Staff-management guards** (§3.2): `029:117,132-137,154-157,171-181`, `can_assign_role` `029:93-99`; `authz.ts:92` (superadmin reserved), `:96` (password at least 6), `:137-149` (`max_staff`).
- **Local credentials:** salted PBKDF2 verifiers per staff (reference `localAuth.ts:113-140`). Never replicate or export them.
- **The current keyboard user per window**, as the reference does (`localAuth.ts:67-77`). Every outbox op carries that `actor`.

**Store / licence / features:**
- Store: name, time zone (used by `set_license_window`; `store_time_zone_for`, `026:148`), `allow_negative_stock` (`029:288-293`), and the settings row.
- Licence: plan, `max_staff`, `starts_at`, `expires_at`, `is_revoked` (plus `revoked_at` once added), `features` jsonb. Also the **server time** of the last successful check, and the monotonic local clock high-water mark.
- Evaluate the state machine locally (`026:86-95`): pending, active, grace (30 days, `026:47`), expired.
  - Writes are allowed only in `active`. Reads are allowed in active and grace.
  - Refuse if the local clock is earlier than the last server time minus skew.
  - Apply an offline allowance after the last check. Choose a value, for example N days; this is what lets the cloud accept ops at event time (§7.3).
- `license_feature` semantics: absent or malformed means allowed (`027:54-65`).

**Register:**
- `device_id`, register credential, `last_seq` acked, `register_only` flag, schema version (29) and the server's last reported version.
- Invoice allocator state, if the PC owns numbering.

---

## 9. Bandwidth notes tied to auth/RBAC (quota)

- On main, each open window polls **`my_permissions` every 15 s** (`permissions.tsx:68`) and **`users?id=` every 15 s** (`staff.ts:24`). It also refetches on every focus (`permissions.tsx:67`).
- Estimate, assuming about 1-2 KB per request/response including headers: 2 × 5,760 req/day ≈ 11.5k req/day, roughly **350-700 MB/month per window** just for this. Both must go on the PC, since RBAC is local.
- The phone should fetch permissions once per session, plus on focus at most.
- The register should piggyback the licence, revocation and server time on the `register_apply` response (one small JSON) instead of separate polls. The reference polled licence and staff every 10 min and heartbeat every 5 min (`origin/offline-first:web/src/lib/local/sync.ts:57-63`).

---

## 10. Reference branch (`origin/offline-first`): what transfers and what does not

**Reusable:**
- `localAuth.ts` PBKDF2 offline sign-in and per-window session (`:67-140`).
- Web Locks single replicator.
- Device id plus a register claim concept (`011_multistore_hardening.sql:276-324`).
- Outbox ordering and hold-on-data-error.
- Image isolation.

**Incompatible with main:**
- Row upserts of `sales`, `sale_items`, `sale_payments`, `order_examinations` and void columns. Direct writes are revoked (`029:739-740,818`) and money columns are guarded (`013:208-245`).
- `auth_staff_id()` with username/email fallback and a `users.auth_uid` column (`011_multistore_hardening.sql:100-126`). Main deliberately removed name-based resolution (`014:283-312`). Do not reintroduce it.
- `claim_register` treating "no position" as admin (`011_ms:300-303`). Main denies unassigned users (`029:61`).
- The device account as a store admin (`sync.ts:19-21`). Replace it with the non-staff register principal (§7.1).

---

## 11. Open points to verify or decide

1. Accept-and-flag versus reject for money ops that fail the actor permission check at replay. Recommendation: flag for money facts, reject for management ops.
2. The offline licence allowance (days), and whether `close_shift` should also require a writable licence.
3. Invoice numbering ownership: a per-register prefix, versus the cloud counter seeded from the PC.
4. Whether the owner may still manage staff from the phone. Recommendation: no, under `register_only`. Otherwise RBAC edits from the phone must travel to the PC first, which breaks one-way sync.
5. Whether Supabase `auth.admin.createUser` accepts a caller-chosen `id`. This only matters if cashiers keep cloud logins; §7.4 avoids needing it.
6. **`update_sale_order` rewrites `recorded_by` on all payments** (`029:496,543-554`). With actors this becomes "last editor took all the money". It needs to keep the original recorders, or the ledger should become append-only for edits.


### REPORT: data
# LensyPOS main (cf78ca5): the data layer outside sales and Z-report

Scope: every file in `web/src/data/` (sales.ts and zreport.ts only briefly), `web/src/lib/{database.types,storage,storageOrphans,suggest,queryClient,licensing}.ts`, the feature files that call Supabase directly, and migrations 003–029 where they touch these features. All paths are relative to `D:/Projects/optical-pos/optical-pos/web/`. Every write is checked by RLS. "tenant" means the 008 policies `store_id = auth_store_id()` plus `license_read_ok`/`license_write_ok` (008_multi_tenancy.sql:298-337). "action" means the 029 restrictive `resolve_can(code)` policies (029_effective_permissions.sql:210-240).

---

## 0. Cross-cutting facts the mirror has to copy

### Identity
- **Store resolution.** `auth_store_id()` (029:74-79) returns `users.store_id` only when `users.id = auth.uid()`, the user is active, and the role belongs to the same store. Every tenant policy, every insert trigger and every RPC uses it.
- **`tenant_fill_store_id` trigger.** It is a BEFORE INSERT trigger (008:240-266) that fills `store_id` from `auth_store_id()`. It is attached to customers, sales, sale_items, order_examinations, prescriptions, inventory, stock_movements, suppliers, purchases, purchase_items, purchase_payments, notes, note_seen, users, roles, settings, warehouses, lens_types, frame_colors and frame_types. sale_payments gets it in 011:86-88.
- **015_link_staff_ids.** `link_staff_ids()` (015:36-131) swaps a staff row so its id matches the Supabase Auth id. It re-points `sales.user_id`, `notes.created_by`/`user_id`, `note_seen.user_id`, `licenses.created_by`, `user_permissions.user_id` and `audit_log.actor` (015:85-91). The view `staff_id_problems` (015:156-168) is not used by the app. Consequence: every staff FK in the data is an auth uid, so offline staff identities on the PC must reuse the same uuids.
- **Audit trigger.** `audit_row_trigger` (014:477-490) is an AFTER insert/update/delete trigger on sales, sale_items, sale_payments, stock_movements, purchases, purchase_items, purchase_payments, role_permissions, user_permissions, users and roles. It writes `audit_log` with `actor = auth.uid()` and `store_id` (014:88-111). Row replication will create one audit row per replicated row, with the actor set to the sync identity.

### Licence
- `license_read_ok` and `license_write_ok` depend on `now()` (008:186-209; redefined 026:42-66). An expired licence makes every tenant write fail, and reads stop 30 days later.
- `my_license_state` (026:82) and `my_store_license` (014:513) are read through `lib/licensing.ts:44-69` (`my_license_state`, `auth_store_id`, `is_platform_admin` RPCs).

### Global UNIQUE constraints (never made per-store; only `roles` was, in 029:6-7)
- `sales.invoice_no` (000:154)
- `inventory.sku` (000:109)
- `lens_types.name`, `frame_colors.name`, `frame_types.name` (000:252/258/264)
- `settings.key` (000:280). `useSetSetting` upserts with `onConflict:'key'` (settings.ts:29-31).

### Polling and caching that cost bandwidth (relevant to the data quota)
- `my_permissions` is polled every 15 s, with `staleTime:0` and refetch on mount and on focus "always" (permissions.tsx:60-69).
- `current-user` (the users row) is polled every 15 s and refetched on focus (staff.ts:21-25).
- Together that is about 11.5k requests a day while the app is open. Both must stop calling the network on the PC.
- Query defaults: `staleTime` 30 s, `refetchOnWindowFocus` false, `gcTime` 24 h. The whole cache is persisted to localStorage under `lensy-query-cache` (lib/queryClient.ts:9-42).
- Only checkout has offline replay (`CHECKOUT_MUTATION_KEY`, queryClient.ts:26-33). Every other mutation fails while offline.

### Reads with no limit (the PostgREST max-rows cap, 1000 on a default Supabase project, silently truncates them)
- `useCustomers` (customers.ts:9-22), used by Reports
- `useSalesSummary`, which downloads every sale header (sales.ts:244-259; Reports)
- `useInventory` (inventory.ts:44-68)
- `useSuppliers` (suppliers.ts:52-65)
- `usePurchases` (suppliers.ts:129-140)
- `useAllPurchasePayments` (suppliers.ts:262-276)
- notes (notes.ts:11-43)
- `useCustomerOrders` (sales.ts:396-411)
- `usePaymentsRange` (salesPayments.ts:116-132)
- the `referencedPaths` step of the orphan sweep (storageCleanup.ts:38-50); see §9

---

## 1. Customers (`data/customers.ts`, `data/customerLedger.ts`)

### Reads
| Hook | Query | Cite |
|---|---|---|
| `useCustomers` | `customers.select(*)`, ordered by name, no limit | customers.ts:9-22 (ReportsPage) |
| `useCustomer(id)` | `eq id`, `maybeSingle` | :25-39 (CustomerDetailPage, OrderReceiptDialog) |
| `useCustomerSearch(term ≥2)` | `ilike name %t%`, limit 10 | :42-58 (CustomerStep) |
| `useCustomerSearchExtended` | in parallel: customers `or(name/city/phone ilike)` ordered by name, limit 50; plus `sales.select(customer_id, doctor_name).ilike(doctor_name)` limit 50; then `customers.in(id, missing)`. The term has `,()` stripped. Merge and sort happen on the client. | :68-124 (CustomersPage) |
| `useInfiniteCustomers` | `select(*, count:'exact')`, ordered by name, `range(offset, +59)` | :127-147 |
| `useCustomerBalance` | RPC `customer_balance(p_customer)`. Returns a set, unwrapped with `oneRow`. | customerLedger.ts:68-84; SQL 018:166-207 |
| `useCustomerDebtors(to)` | RPC `customer_debtors(p_from:null, p_to, p_limit:50)` | customerLedger.ts:92-113; SQL 018:218-260 |

Server aggregates:
- `customer_balance` uses live (unvoided) sales of that customer in the caller's store. `balance_due = max(Σnet − Σsale_payments.amount, 0)`. It also returns `lifetime = Σnet`, `invoice_count` and `last_activity = max(order_date)`. Its scope is `is_platform_admin() OR c.store_id = auth_store_id()`.
- `customer_debtors` uses `report_window`. It sums `net − amount_paid` (the header columns, not the ledger), keeps rows with due > 0.01, sorts descending, and clamps the limit to 1–200.

### Writes
All are direct table writes. RLS requires tenant plus `customers.create`, `customers.edit` or `customers.delete` (029:214).
- `useAddCustomer`: insert, then `.select().single()` (customers.ts:149-163).
- `useUpdateCustomer`: update by id, `.select('id').single()`, so a write denied by RLS raises an error (:165-180).
- `useDeleteCustomer`: delete by id. On a foreign-key error (23503) it runs `countRelated` (two head counts, on sales and prescriptions) and throws `CustomerHasRelatedRecordsError` (:197-242).
  - `sales.customer_id` has no ON DELETE action (000:155), so a customer with sales cannot be deleted.
  - `prescriptions.customer_id` is ON DELETE CASCADE (000:207), so the prescription count shown in the error is misleading.

### Triggers and time
- Only `tenant_fill_store_id` fires. `created_at` defaults to `now()`.
- `search_text` sorts customers by `created_at` (016:276).

---

## 2. Inventory and stock (`data/inventory.ts`, plus `POSContext.tsx`)

### Reads
- `useInventory(category?)`: `inventory.select(*)`, optionally `eq category`, ordered by name, no limit (inventory.ts:44-68).
  - Before that, a one-time probe `select stock_qty limit 1` per session decides whether the 012 `stock_qty` column exists (:22-36). Pre-012 databases fall back to downloading every `stock_movements(product_id, qty)` row and summing them.
  - Call sites, each cached separately: InventoryPage:143, ReportsPage:62, SuppliersPage:228, ExamSection:39 (`'Frame'`), AdditionalItemsStep:14, EditOrderForm:43.
- `useProductStock(id)`: `inventory.select(stock_qty).eq id` (inventory.ts:117-140). The pre-012 path sums movements instead.
- `ensureFrameProduct(name)` (inventory.ts:76-113) and its duplicate `findOrCreateFrame` (POSContext.tsx:431-470):
  1. strip `" (…)"` from the name;
  2. look for `category = Frame` with `ilike name` (exact, case-insensitive), limit 1;
  3. otherwise look in any category with `ilike name`;
  4. otherwise **insert** `{name, category:'Frame', sale_price:0, cost_price:0}`.
  The POS version checks `inventory.create` first (POSContext:455). It runs at checkout for exams with `frame_status = 'New'` (POSContext:473-491, 565).
- `quickAdd` in POS: `ilike sku = term` limit 1, then `ilike name %term%` limit 1 (POSContext.tsx:494-512).
- **Bug: POSContext.tsx:736-741 reads `.from('products')`, and that table does not exist** (no migration creates it). The category lookup in `loadSale` always returns null, so `inferLoadedCategory` falls back to `hasExams`.

### Writes
- `useAddProduct`:
  - Normal path: RPC `add_inventory_item(p_product jsonb, p_initial_stock)` (inventory.ts:142-180). In 029:564-587 it is SECURITY DEFINER and runs `require_perm('inventory.create')`, then the licence check. It inserts into inventory (name, sku, barcode, category, brand, frame_type, frame_color, cost_price, sale_price). If initial stock is above 0 it also inserts `stock_movements(type 'initial')`, all in one transaction.
  - Fallback when the RPC is missing: a direct insert, plus a direct movement insert with `created_at` set to the client's `new Date()` (inventory.ts:161-175).
- `useUpdateProduct`: direct update with `.select('id').single()` (inventory.ts:182-197). Needs `inventory.edit`.
- `useAdjustStock`: direct **insert into stock_movements** `{product_id, qty, type, ref_no, note, created_at: client now}` (inventory.ts:200-231).
  - The 029 action policy requires `inventory.edit` to insert into stock_movements. Update and delete are `false` for every role (029:225), and 013 already removed DELETE (013:816-826).
- Inventory DELETE is `false` under 029 (029:215, where the delete rule is null and so becomes `false`). The `syncExamReferences` delete in metadata.ts:251 therefore silently removes 0 rows; see §5.

### Triggers on stock_movements
- `stock_movement_kind`: BEFORE INSERT, or UPDATE of `type`. It sets `kind` from `type` (013:174-194). For example, `'adjustment'` becomes `'adjustment'`, and `'return'`, `'void'` or `'restock'` become `'void_restock'`. `kind` is a foreign key to `stock_movement_kinds` (013:143-172).
- `stock_qty_sync`: AFTER INSERT/UPDATE/DELETE. It adds or subtracts `qty` on `inventory.stock_qty` (012:69-91). **`stock_qty` is a cache owned by the trigger.** If the mirror replicates both movements and `inventory.stock_qty`, the server counts the stock twice unless `stock_qty` is excluded from the replicated inventory columns.
- Also `tenant_fill_store_id` and `audit_row_trigger`.

### Other stock writers
- `create_sale_order` and `update_sale_order` write `−qty, 'sale', ref_no = invoice_no, created_at = now()` (029 lines 378-381 and 527-530 in the file).
- `update_sale_order` deletes earlier sale movements by `ref_no = invoice_no` (file line 497-498).
- `void_sale` restocks.
- `receive_purchase` adds stock (§4).
- The checkout guard uses `stores.allow_negative_stock` (012:47-48).

---

## 3. Lab status and dwell (migration 019, sales.ts)

### Schema
019:35-45 adds four columns to sales: `lab_status_changed_at`, `lab_started_at`, `lab_started_by` (never written by anything), and `lab_ready_at`. The backfill is at 019:57-68.

### Trigger `lab_status_stamp`
BEFORE UPDATE on sales (019:76-104). It fires **only when `lab_status` actually changes**, and then:
- sets `lab_status_changed_at = now()`;
- sets `lab_started_at = coalesce(old, now())` when the new status is not 'Not Started';
- sets `lab_ready_at = coalesce(old, now())` when the new status is in ('Ready', 'Received').

It does not fire on INSERT, so a new sale has null stamps and `lab_queue` falls back to `order_date`. **The stamps use server time.** If a status change made offline is replayed or replicated later, it gets the sync time, unless the replicated row carries the stamps and the trigger is changed to keep client-supplied values.

### Write
- `useUpdateLabStatus` calls RPC `set_lab_status(p_sale, p_status)` (sales.ts:972-981; 029:748-756).
- The RPC requires `lab.edit` and a valid licence. The status must be one of 'Not Started', 'In Lab', 'Ready', 'Received'.
- It updates only rows in the caller's store that are not voided and have a non-null `lab_status`.
- The UI vocabulary is in `LAB_STATUSES` (sales.ts:1012). Older values such as 'In Progress' and 'Delivered' remain in the data; reports and the lab filters still accept 'In Progress'.

### Reads
- `useLabQueue(status)` calls RPC `lab_queue(p_status)` (sales.ts:1041-1064; 019:117-148).
  - Scope: the caller's store, not voided, `lab_status` not null, limit 200.
  - Sorted by `coalesce(lab_status_changed_at, order_date)` ascending.
  - Computes `hours_in_status` and `hours_total` from **server `now()`** and the stamps.
  - Joins `customers.name`.
- `useInfiniteLabSales`: sales where `lab_status` is not null and `voided_at` is null, ordered by `order_date` desc, offset paging of 50 with an exact count. 'Pending' expands to the set ('Not Started', 'In Lab', 'In Progress') (sales.ts:364-392).

### Other consumers of the stamps
- `z_report` counts "lab delivered" by `lab_status = 'Received'` with `lab_status_changed_at` inside the window (023:155-165). A late stamp therefore moves the delivery into the wrong Z-report day.
- `report_sales_window` counts pending and ready lab jobs (016:65-70; redefined in 022:272).

### Header guard trigger `aa_sale_access`
BEFORE UPDATE on sales (029:774-793):
- When `current_user` is `authenticated`, it requires `history.edit`.
- It refuses edits to a voided invoice.
- It allows changes only to `doctor_name`, `delivery_date`, `rx_image_path`, `frame_image_path`, `lab_status` and the four lab stamp columns.
- A change to `lab_status` also requires `lab.edit`.
- Replacing an image path that was already set requires a store admin.

There is also a restrictive UPDATE policy `history.edit` on sales (029:794-796), and `sales_money_guard` (013:208-227), which refuses changes to `total_amount`, `discount`, `net_amount` or `amount_paid` unless the session setting `lensy.money_write = '1'`.

---

## 4. Suppliers and purchases (`data/suppliers.ts`, migration 018)

### Reads
| Hook | Query | Cite |
|---|---|---|
| `useSuppliers` | `select *`, ordered by name | :52-65 |
| `usePurchases(supplierId?)` | `select *`, optional `eq supplier_id`, ordered by `purchase_date` desc | :129-140 |
| `usePurchaseItems(id)` | `purchase_items eq purchase_id`, ordered by `created_at` asc | :175-190 |
| `useAllPurchasePayments` | `purchase_payments select *`, ordered by `paid_at` desc, no limit | :262-276 (SuppliersPage:400, used for outstanding badges) |
| `usePurchasePayments(id)` | `eq purchase_id`, ordered by `paid_at`, `created_at` | :279-296 |

Outstanding balance is computed on the client as `total_amount − Σpayments` (described in 003:4-9).

### Writes
- `useAddSupplier`: direct insert (`suppliers.create`). `useUpdateSupplier`: direct update with no `.single()`, so a write denied by RLS is a silent no-op (:79-88).
- `useDeleteSupplier` (:96-126):
  1. select purchase ids for the supplier;
  2. RPC `delete_purchase(p_purchase)` for each one (029:677; 013:747-776). The function deletes purchase_items, then purchase_payments, then the purchase. It checks the store and licence, and since 029 it also checks a permission;
  3. direct delete of the supplier (`suppliers.delete`).
  `purchases.supplier_id` has no ON DELETE action (000:229).
- `useAddPurchase`: direct insert into purchases. The client supplies `{supplier_id, total_amount, amount_paid, purchase_date}`. The policy is `suppliers.create`.
- `useAddPurchaseWithItems` (:233-257): insert the purchase, then a direct insert into `purchase_items` (`suppliers.create`), then RPC `receive_purchase`. This is three calls and is not atomic. Receiving is idempotent.
- `useReceivePurchase` calls RPC `receive_purchase(p_purchase)` (:200-224). The 029:589 version requires `suppliers.edit` (the 018:55-139 body is otherwise the same). For each line where `received_at is null`, `product_id` is not null and qty > 0, locked with FOR UPDATE, it:
  1. inserts `stock_movements(qty +, type 'purchase', kind 'purchase', ref_no = purchase id, created_at now())`;
  2. updates `inventory.cost_price` to a **weighted average**, `(stock_qty·cost + qty·unit_cost)/(stock_qty+qty)` rounded to 2 places, or to `unit_cost` if stock is 0 or less;
  3. sets `purchase_items.received_at = now()`.
  It returns the number of lines received. **It is server-side business logic that depends on server time**, so the PC needs a local equivalent.
- `useAddPurchasePayment`: direct insert into purchase_payments (`suppliers.edit`). `paid_at` is a **DATE** column (003:16-23; never widened), and `created_at` defaults to `now()`.
- `useDeletePurchasePayment` calls RPC `delete_purchase_payment(p_payment)` (013:778-807; 029:708). Direct DELETE on purchases, purchase_items and purchase_payments was revoked (013:816-826; 029 sets the purchases delete rule to `false`).

### Triggers
- `tenant_fill_store_id` and `audit_row_trigger` on purchases, purchase_items and purchase_payments.
- Movements written by `receive_purchase` go through the stock triggers in §2.

---

## 5. Metadata: lens types, frame colours, roles (`data/metadata.ts`, migration 010)

### Reads
`useNamedTable(table, order)` (metadata.ts:12-28):
- `lens_types` and `frame_colors` use the 'custom' order: `sort_order` asc with nulls last, then `created_at` (:30-31).
- `roles` is ordered by name (:32).
- There is no limit. These lists are small.

Type-ahead filtering happens on the client in `lib/suggest.ts:26-41`: case-insensitive, starts-with matches first, then contains matches, keeping the list's own order. It needs no I/O, so it works offline as-is.

### Writes
All are direct. RLS requires `inventory.edit` for insert, update and delete on lens_types, frame_colors and frame_types (029:222-224).
- `useAddMetadata`: insert `{name, sort_order?}` (:36-58).
- `useReorderMetadata`: **one UPDATE per row**, `sort_order = i+1`, run with `Promise.all`, and errors are ignored (:61-73). The number of requests grows with the list.
- `useDeleteMetadata`: delete by id (:76-85).
- `addMissingOrderMetadata(exams)` runs at checkout when the user has `inventory.edit` (POSContext:569; EditOrderForm:98). For each distinct lens_info and frame_color value it does one `ilike name` lookup with limit 1, then one bulk insert of the missing names (:110-134). These are sequential round trips. The lens and colour names are globally UNIQUE (000:252/264), so a duplicate raises an error.
- `syncExamReferences({oldRows, newRows})` (:153-255) runs after a confirmed order is edited:
  - **Lens types and frame colours:** adds new values. For each value that was removed, it checks `order_examinations ilike field = v` with limit 1. If no other order uses the value, it looks up the metadata row by `ilike name` and deletes it.
  - **Frames:** calls `ensureFrameProduct` for each new frame. For each removed frame it checks:
    1. whether any `order_examinations.frame_info` still uses it;
    2. finds the inventory product (`category = Frame`, `ilike name`);
    3. whether any sale_items row references that product id;
    4. sums the product's stock_movements qty, and stops if the sum is above 0;
    5. **deletes the inventory row.** Under 029 this DELETE is denied by RLS, so it removes 0 rows and raises no error.

The value check, `ilike` with no wildcards, is a case-insensitive exact match.

### Triggers and time
`tenant_fill_store_id` only. `created_at` defaults to `now()`, and the 'custom' order uses it as the tie-break.

---

## 6. Examinations (`data/examinations.ts`)

### Reads
- `useOrderExaminations(saleId)`: `order_examinations eq sale_id` (:7-21). Used by ExamView, LabPage, OrderReceiptDialog and EditOrderForm.
- `usePastExaminations(customerId)` (:55-89):
  1. sales for the customer (`id, order_date, invoice_no, doctor_name`), ordered by `order_date` desc, limit 20;
  2. `order_examinations in(sale_id)`;
  3. join and sort on the client, keep the first 10.
  Used by POS ExamSection.
- Embedded reads: `useCustomerOrders` selects `*, sale_items(*), order_examinations(*)` (sales.ts:396-411), and POS `loadSale` reads them by `sale_id` (POSContext.tsx:702-705).
- metadata.ts does usage checks with `ilike` on lens_info, frame_color and frame_info.

### Writes
- `useReplaceOrderExaminations` calls RPC `replace_order_examinations(p_sale, p_exams jsonb)` (:31-48; 029:758-770).
  - It requires `history.edit` and a valid licence, locks an unvoided sale in the caller's store FOR UPDATE, deletes all of that sale's exams, then inserts them again from the JSON.
  - Columns: exam_type, sphere/cylinder/axis for OD and OS, ipd, lens_info, frame_info, frame_color, frame_status, doctor_name, image_path.
  - **Exam row ids change on every edit.** The mirror cannot rely on stable exam ids and should treat a sale's exams as one replaceable set.
- Checkout and re-checkout insert exams inside `create_sale_order` and `update_sale_order`.
- order_examinations is **not** in the 029 action-policy list, so a direct write needs only the tenant and licence checks. The app writes it directly only in the pre-002 fallback (sales.ts:753, 925).

### Types and triggers
- database.types.ts:193-209. The TS type is missing `doctor_name`, which the base table has (000:196).
- `tenant_fill_store_id` only.

---

## 7. Notes (`data/notes.ts`, migrations 004, 005, 006, 029)

### Reads
- `useEveryoneNotes`: `user_id is null`, ordered by `created_at` desc (:11-25).
- `useMyNotes(userId)`: `eq user_id`, ordered by `created_at` desc (:28-43).
- `useNoteSeen(ids)`: `note_seen.select(note_id, user_id).in(note_id, ids)` (:82-97).
- NotesPage also calls `useUsers` to show names.

### Writes
- `useAddNote` (:45-62): first calls `resolveStaffUserId()`, which makes two network calls: `supabase.auth.getUser()` and `users eq id` (staff.ts:26-30). It then inserts `{body, user_id, created_by}`.
- `useUpdateNote`: sets `{body, updated_at: client new Date()}` (:64-77). The column comes from 005.
- `useDeleteNote`: delete by id (:115-124).
- `useMarkNoteSeen`: upsert `note_seen {note_id, user_id}` with `onConflict 'note_id,user_id'` (:99-113). `seen_at` defaults to `now()` (006:9-17).

### RLS (029:820-832)
- SELECT requires `notes.view` and `(user_id is null or user_id = auth.uid())`.
- INSERT requires `created_by = auth.uid()` and `(user_id is null or user_id = auth.uid())`.
- UPDATE requires `created_by = auth.uid()`.
- DELETE requires `created_by = auth.uid()` or a store admin.
- The action policies `notes.create`, `notes.edit` and `notes.delete` also apply.

So notes depend on **`auth.uid()` for authorship and visibility.** A replicating sync identity cannot insert a note on behalf of a staff member under the current policies. `note_seen` has only the tenant policies.

### Foreign keys
- `notes.user_id` references users ON DELETE CASCADE; `notes.created_by` references users (004:41-48).
- `note_seen.note_id` references notes ON DELETE CASCADE.

---

## 8. Search (`data/search.ts`, migration 016)

`useGlobalSearch(term ≥ 2)` (:40-71):
1. RPC `search_text(p_term, p_limit 18)`. The server clamps the limit to 1–25 (016:264-295). It is a UNION over:
   - customers, matching name or phone with `ilike %t%`;
   - inventory, matching name or sku;
   - sales, matching invoice_no;
   all scoped to `auth_store_id()`, sorted by `created_at`/`order_date` desc. It uses trigram GIN indexes (016:243-258). Note that `p_term` is not escaped for `%` or `_`, despite the comment at 016:260-263.
2. Then three hydration reads with `.in('id', ids)` on customers, inventory and sales.

The fallback when `search_text` is missing uses `or(ilike)` with a limit of 6 per table (:62-68).

Other search paths:
- `useCustomerSearchExtended` (§1).
- `useInfiniteSales` term search: customers `ilike name` limit 50, then sales `or(invoice_no.ilike, customer_id.in(...))`, with a cursor on `(order_date, id)` and pages of 50 (sales.ts:290-361).
- `useTodaySales` and the 'today' and 'month' ranges use the **browser's local date** formatted without a timezone, e.g. `gte order_date 'YYYY-MM-DDT00:00:00'` (sales.ts:25-40, 262-265, 317-318). Postgres reads that in the session timezone, not the store's.

For an IndexedDB mirror, all of this has to become local indexes: lower-case name, phone, city, sku and invoice_no, plus doctor_name on sales, with substring matching.

---

## 9. Order images and storage (`lib/storage.ts`, `data/storageCleanup.ts`, `lib/storageOrphans.ts`, migrations 007 and 008)

### Model
- Bucket `prescriptions` is **public**. `prescriptionImageUrl` uses `getPublicUrl`, so reads bypass RLS (storage.ts:21-23).
- `sales.rx_image_path` and `sales.frame_image_path` (007:10-13) hold the paths.
- Legacy fields: `order_examinations.image_path` and `prescriptions.image_path`. ExamView.tsx:43 and 75 still render the exam one.

### Upload: `uploadOrderImage(file, invoiceNo, slot, storeId)` (storage.ts:50-67)
- Downscales on the client to a 1600 px maximum edge, JPEG quality 0.82 (:26-42).
- Path: `store/<storeId>/orders/<invoice_no sanitized>-<rx|frame>-<Date.now base36>.jpg`.
- `upsert:false`, `cacheControl 3600`.
- The path embeds the invoice number, so an offline sale whose number is not final yet affects the path.
- Storage RLS (008:426-459): read and write require folder `store/<auth_store_id>` plus `license_read_ok` or `license_write_ok`. A platform admin can access everything.

Call sites:
- POS ExamSection:373 uploads, then `setOrderImage` puts the path into POS state. The path is written by checkout through `create_sale_order`.
- HistoryPage:247-248 uploads, then `useSetOrderImage`.
- The mobile page MUploadPage:60-66 uploads. If the sale exists it links it with `useSetOrderImage`; otherwise the file waits in storage for checkout to adopt it. It looks up `sales eq invoice_no` (MUploadPage:34-46).

`useSetOrderImage` is a **direct UPDATE on sales** of `rx_image_path` or `frame_image_path` (sales.ts:987-1006). It is governed by `aa_sale_access`: replacing a path that is already set requires an admin.

`findOrderImages(storeId, invoiceNo)` lists `store/<id>/orders` with `search '<inv>-'`, limit 30, and picks the newest file per slot (storage.ts:80-99). Checkout calls it to adopt photos taken on the phone (POSContext.tsx:590-594). It needs the network; on error it returns `{}` silently.

`uploadPrescriptionImage`, which writes to the bucket root (storage.ts:9-18), is unused.

### Removal
- `removeOrderImage(path)` is called **only** after a successful void, best-effort, for both slots (sales.ts:1192-1197).
- Replacing a photo does **not** delete the old file, even though the header comment in storageCleanup.ts:13-14 says it does. Each replacement leaves an orphan.

### Orphan sweep: what it deletes
- It is a manual operator action for the **platform admin only**. `useOrphanScan` is enabled only when `is_platform_admin` is true (storageCleanup.ts:95-113). Deletion is a separate button, `useDeleteOrphans`, which calls `storage.remove(paths)` (:123-136). Nothing schedules it.
- **Referenced set:** `sales.select(rx_image_path, frame_image_path)` across every store visible to the platform admin. It is **a single request with no range or order**, so it is capped by PostgREST max-rows (1000 on a default Supabase project). Any references after the cap are missing from the set (storageCleanup.ts:38-50).
- **Files considered:** a paginated list of `store/<store_id>/orders` for each store, pages of 100 (:57-92). It does not recurse. Legacy root and `store/<id>/` files are not considered.
- **Rule:** a file is an orphan if neither its full path nor its bare name is in the referenced set. `.emptyFolderPlaceholder` is skipped (storageOrphans.ts:54-79).
- **There is no age or grace threshold,** and nothing checks `order_examinations.image_path`.

### Would it delete photos the PC uploaded before their row synced?
**Yes.** Any file in `store/<id>/orders/` with no sales row pointing at it when the sweep runs is listed as an orphan and deleted when the operator confirms. That covers:
1. a photo the PC uploaded before its sales row (or the update to `rx_image_path`/`frame_image_path`) reached Supabase;
2. a photo uploaded from the phone before checkout, which today lives only in storage until checkout adopts it;
3. a photo whose checkout is still in the offline replay queue.

Separately, on any project with more than about 1000 sales, the truncated referenced set can mark photos of **real, synced** sales as orphans.

The fixes the design needs:
- upload a photo only after its row has synced, or upload the row first with the path;
- give the sweep a minimum file age, for example skip files younger than N days using the `created_at` that `list()` returns;
- page through `referencedPaths`, or move the reference check into SQL;
- include pending paths from the PC outbox.

### Sales timestamps the server sets (summary only; sales.ts and zreport.ts are covered by other workers)
- Checkout and re-checkout go through `create_sale_order` and `update_sale_order` (029:246-562). Inside them:
  - `order_date = coalesce(client order_date, now())`. The client sends `new Date()` (sales.ts:619).
  - `sales.user_id = auth.uid()` and `recorded_by = auth.uid()`.
  - Payment `paid_at = coalesce(line.paid_at, now())`.
  - Stock movements use `now()`.
  - The invoice number comes from `next_invoice_no()`, an RPC with a row-locked per-store counter (012:105-166).
- `void_sale` sets `voided_at = now()` and `voided_by = auth.uid()`, and writes refund rows with `paid_at = now()` (014:338-412).
- `refund_sale` uses `now()` and `auth.uid()` (028:96-170).
- `collect_sale_payment` uses `paid_at = now()` and `recorded_by = auth.uid()`, and refuses any method outside cash, wallet, instapay, card and any payment above the balance (029:800-817). The client stamps `paid_at` but sends only amount and method, so its stamp is discarded (salesPayments.ts:73-82).
- Direct `sale_payments` insert, update and delete are revoked (029:818), and sales INSERT and DELETE are revoked (029:740). `replaceSalePayments` (salesPayments.ts:140-155) is therefore dead code under 029.
- `sync_sale_amount_paid` is a trigger on sale_payments that recomputes `sales.amount_paid` under the money flag (013:231-247).
- Z-report: `store_day_range` (016:184-194) and `z_report` (023:112) work in the store timezone (`stores.time_zone`, or the `time_zone` setting, 016:165-179) using server `now()`. `close_shift` writes `shift_closes` with `closed_at` defaulting to `now()` and `closed_by = auth.uid()` (023:58-61, 229). `useShiftCloses` reads the latest 20 (zreport.ts:177-190).

---

## 10. Settings, staff and permissions (brief)

- **Settings:** `useSettings` reads `select *` into a key/value map (settings.ts:8-22). `useSetSetting` upserts with `onConflict 'key'` (:25-36); `settings.edit` is required for every operation (029:221). The `time_zone` key feeds `store_time_zone()`.
- **Staff:** `useUsers` reads `users.select('*, roles(*)')` ordered by username. `useCurrentUser` reads by id and polls every 15 s (staff.ts:8-25). `useUpdateUserRole` calls RPC `set_staff_access` (029:166).
- **Users, roles, role_permissions, user_permissions:** direct insert, update and delete are revoked (029:186), except the platform insert path.
- **Permissions:** `useRoleGrants` reads `role_permissions` embedding `permissions(code)`. `useUserOverrides` reads `user_permissions` with `allow` and `permissions(code)`. Writes go through RPCs `set_role_permission` and `set_user_permission` (permissions.tsx:10-51). Effective access is RPC `my_permissions()` (029:81-89), which returns `{is_admin, active, assigned, codes}` and is mirrored on the client by `resolveCan` (permissionModel.ts:25-38). StaffPage:114 calls `create_staff_role`.
- **Platform (vendor only):** PlatformPage reads and writes `stores`, `store_licenses`, `permissions`, `roles` and `role_permissions`, and calls `set_license_window`. Platform reports use RPC `platform_report_window(p_day)` (platformReports.ts:21-35). The orphan sweep is described in §9.
- **Schema version:** RPC `schema_version` (lib/schemaVersion.ts:54).
- **Cache invalidation groups** (refresh.ts:4-18):
  - `SALE_READS`: sales, sale, sale_payments, customers, customer-orders, customer-balance, customer-debtors, lab-queue, report-totals, z-report, platform-report, order_examinations, past_examinations, global-search, m-order, inventory, stock.
  - `ACCESS_READS`: my-permissions, current-user, users, roles, role_permissions, user_permissions, my-store-id, my-license, is-platform-admin.
  - `invalidatePurchases`: suppliers, purchases, purchase-items, purchase_payments, inventory, stock, report-totals.

---

## 11. Every table and RPC the app uses, for planning the IndexedDB mirror

R = read, W = direct table write, RPC = written through a server function. "Server logic to port" is what the PC must do locally once the server stops doing it.

### Tables

| Table | Read shapes | Writes | Triggers / server logic to port | Server time or auth.uid() | Permission gate (029) |
|---|---|---|---|---|---|
| customers | all by name; by id; `ilike` name/city/phone (limit 10/50); paged with exact count; `in(ids)`; head counts | W insert, update, delete | tenant_fill; FK from sales blocks delete; prescriptions cascade | created_at default now(); search_text order | customers.create/edit/delete |
| sales | many (sales.ts); doctor `ilike`; `customer_id` for past exams; `invoice_no` equality (POS, mobile); `in(ids)`; image paths (sweep); cursor and offset paging; `useSalesSummary` reads all headers | RPC create_sale_order, update_sale_order, void_sale, refund_sale, set_lab_status, collect_sale_payment; **W update** of header fields (useUpdateSale, useSetOrderImage) only | tenant_fill, sales_money_guard, **lab_status_stamp**, **aa_sale_access**, audit_row; global UNIQUE invoice_no; idempotency unique on (store_id, idempotency_key) (012:169-172) | order_date coalesce(client, now()); user_id/voided_by = auth.uid(); voided_at and lab stamps = now() | insert/delete revoked; update needs history.edit (+ lab.edit for status; admin to replace an image) |
| sale_items | embedded in customer-orders; by sale_id (loadSale); exists check by product_id (metadata) | RPC only | tenant_fill, audit; checks qty>0 and total = qty·unit_price, discount ≤ total (012, 013) | – | via RPC |
| order_examinations | by sale_id; `in(sale_ids)`; `ilike` on lens_info/frame_color/frame_info; embedded | RPC replace_order_examinations, create/update_sale_order | tenant_fill; ids are regenerated on every replace | – | RPC needs history.edit; direct writes only tenant-gated |
| sale_payments | by sale_id ordered by paid_at, created_at; range on paid_at (Reports cash-up) | RPC only (direct writes revoked) | sale_payments_sync → sales.amount_paid; tenant_fill; audit; check amount ≠ 0 | paid_at now(); recorded_by auth.uid() | via RPC |
| inventory | all or by category, by name; by id (stock_qty); `ilike` name (frame lookup); `ilike` sku/name (quickAdd); `in(ids)`; probe of stock_qty | RPC add_inventory_item; W insert (auto-created frames), W update; delete is denied (silent no-op) | stock_qty maintained by trigger; cost_price weighted average in receive_purchase; tenant_fill; global UNIQUE sku | created_at now() | inventory.create/edit; delete = false |
| stock_movements | only the pre-012 fallback and a per-product sum in metadata | **W insert** (useAdjustStock, client created_at); RPCs (sale, void, receive, initial) | stock_movement_kind (BEFORE), stock_qty_sync (AFTER), tenant_fill, audit | created_at client time (adjust) or now() (RPCs) | insert needs inventory.edit; update/delete = false |
| suppliers | all by name | W insert, update, delete | tenant_fill | – | suppliers.create/edit/delete |
| purchases | all or by supplier, by purchase_date desc; ids by supplier | W insert; RPC delete_purchase | tenant_fill, audit | purchase_date from client | suppliers.create/edit; delete = false |
| purchase_items | by purchase_id, by created_at | W insert; received_at set by RPC receive_purchase | tenant_fill, audit | received_at now() | suppliers.create/edit |
| purchase_payments | all by paid_at desc; by purchase | W insert; RPC delete_purchase_payment | tenant_fill, audit; paid_at is a DATE | created_at now() | suppliers.edit |
| lens_types, frame_colors | all by sort_order, created_at; `ilike` name exists | W insert, update (sort_order, one call per row), delete | tenant_fill; global UNIQUE name | created_at now() (tie-break) | inventory.edit |
| frame_types | not read by the app | – | – | – | inventory.edit |
| notes | `user_id is null`; `eq user_id`; by created_at desc | W insert, update, delete | tenant_fill; RLS visibility and authorship via auth.uid() | created_at now(); updated_at client time | notes.* plus created_by = auth.uid() |
| note_seen | `in(note_id)` | W upsert on (note_id, user_id) | tenant_fill | seen_at now() | tenant only |
| settings | all | W upsert on key | tenant_fill; global UNIQUE key | – | settings.edit |
| users (+roles embed) | all by username; by id (polled every 15 s) | RPC set_staff_access | audit | auth.uid() is the identity | revoked; RPC only |
| roles | all by name | RPC create_staff_role (platform: direct insert) | audit; UNIQUE (store_id, name) | – | – |
| role_permissions, user_permissions (+permissions) | by role or user, embedding the code | RPC set_role_permission / set_user_permission | audit | – | – |
| shift_closes | latest 20 | RPC close_shift | – | closed_at now(); auth.uid() | closing.* |
| stores, store_licenses | platform page; orphan scan (id, name) | platform direct writes; RPC set_license_window | audit on store_licenses (026:225) | – | platform only |
| products | **does not exist**; bug at POSContext.tsx:737 | – | – | – | – |
| storage `prescriptions/store/<id>/orders/*` | public URL GET; `list` with search (findOrderImages); paginated list (sweep) | upload (upsert:false); remove (void, sweep) | – | – | folder = auth_store_id plus licence |

### RPCs

| RPC | Kind | Source of definition | Depends on server time / auth.uid() |
|---|---|---|---|
| customer_balance | read, aggregate | 018:166 | auth_store_id |
| customer_debtors | read, aggregate | 018:218 | report_window (store timezone) |
| search_text | read | 016:264 | auth_store_id |
| lab_queue | read, aggregate | 019:117 | now() |
| set_lab_status | write | 029:748 | trigger now(); lab.edit |
| replace_order_examinations | write | 029:758 | history.edit |
| add_inventory_item | write | 029:564 | inventory.create |
| receive_purchase | write | 029:589 (logic as 018:55) | now(); suppliers.edit |
| delete_purchase, delete_purchase_payment | write | 029:677, 029:708 (013:747/778) | auth.uid() not null |
| collect_sale_payment | write | 029:800 | now(), auth.uid() |
| refund_sale | write | 028:96 | now(), auth.uid() |
| void_sale | write | 014:338 | now(), auth.uid() |
| create_sale_order, update_sale_order | write | 029:246, 029:410 | now(), auth.uid(), next_invoice_no |
| next_invoice_no | write (counter) | 012:140 | auth_store_id |
| report_sales_window, report_top_customers, report_voided_count | read | 016, 022:272 | store timezone |
| store_day_range | read | 016:184 | now(), store timezone |
| z_report | read | 023:112 | lab_status_changed_at, paid_at |
| close_shift | write | 024:121 | now(), auth.uid() |
| platform_report_window | read | 027:84 | platform admin only |
| my_permissions | read, polled every 15 s | 029:81 | auth.uid() |
| set_role_permission, set_user_permission, set_staff_access, create_staff_role | write | 029:125-180 | – |
| my_license_state, auth_store_id, is_platform_admin, schema_version | read | 026:82, 029:74, 008:211, 017:53 | – |
| set_license_window | platform write | 026:112 | – |

Defined on the server but not called by the app: `report_payment_mix` (016:123), `available_stock` (012:94), `price_cart` (internal to the checkout RPCs), `link_staff_ids`, the `staff_id_problems` view, and `store_time_zone` (internal).

---

## 12. Design consequences

1. **Server-side logic the PC must reproduce locally.** It has to run the same rules as the server, the same functions in the same transaction scope:
   - the stock_qty cache and movement `kind` normalisation (012:69, 013:174);
   - amount_paid as the sum of payments (013:231);
   - lab dwell stamps (019:76);
   - weighted-average `cost_price` and `received_at` from receive_purchase;
   - checkout and re-checkout pricing and validation (price_cart);
   - void and refund rows;
   - the invoice counter;
   - exam replacement;
   - customer balance, debtors, lab_queue, search, report windows and the Z-report, all in the store timezone (`stores.time_zone`, or the `time_zone` setting; default Africa/Cairo).
2. **One-way row replication collides with the current server guards.** Under 029 these will refuse rows replicated by an `authenticated` identity:
   - sales INSERT is revoked (029:740) and sale_payments writes are revoked (029:818);
   - `sales_money_guard` blocks money columns;
   - `aa_sale_access` allows only a whitelist of header columns;
   - stock_movements UPDATE and DELETE are `false`; inventory DELETE is `false`;
   - notes require `created_by = auth.uid()`.

   The sync target needs either a dedicated SECURITY DEFINER ingest RPC, or a sync role exempt from these checks.
3. **Server-time triggers would overwrite timestamps taken on the PC:**
   - `lab_status_stamp`, which feeds Z-report delivered counts and lab dwell;
   - `now()` defaults on created_at, seen_at and closed_at;
   - `paid_at` / `voided_at` set to `now()` by the RPCs.

   Replication has to carry the local timestamps, and the server must keep values supplied by the client.
4. **Two server caches would double-count:** `stock_qty_sync` and `sync_sale_amount_paid` recompute `inventory.stock_qty` and `sales.amount_paid`. Replicate the ledger rows (movements, payments) and leave those two columns for the server, or turn the triggers off for the sync role. Do not send both.
5. **Exam ids are not stable across edits** (replace_order_examinations deletes and re-inserts). Sync per sale: delete that sale's exams, then insert the set.
6. **Images:**
   - compress once (today: 1600 px, JPEG 0.82);
   - upload after the row, or make the orphan sweep tolerate files that are pending or young;
   - fix the sweep's truncation at max-rows;
   - delete the old file when a photo is replaced;
   - the phone QR upload page writes directly, which conflicts with a read-only phone.
7. **Bandwidth:**
   - remove the 15 s polling of my_permissions and current-user;
   - replace `useSalesSummary` (every header), `useCustomers` (every customer) and `useAllPurchasePayments` with local reads;
   - the checkout metadata helpers (`addMissingOrderMetadata`, `syncExamReferences`, `ensureFrameProduct`) and `useReorderMetadata` make one request per value or per row; they must become local operations.
8. **Global UNIQUE columns** (invoice_no, sku, lens and frame-colour names, settings.key) must be enforced in the local store too, or a later sync will fail.
9. **Existing bugs to fix along the way:**
   - `from('products')` (POSContext.tsx:737);
   - the `syncExamReferences` inventory delete is a silent no-op under 029 (metadata.ts:251);
   - `useReorderMetadata` and `useUpdateSupplier` ignore write errors;
   - the 'today' filters use the browser's local date without a timezone, not the store day;
   - `search_text` does not escape `%` and `_`.


### REPORT: infra
# LensyPOS main (cf78ca5): app infrastructure map for the offline-first redesign

Read-only analysis. Paths are relative to `D:/Projects/optical-pos/optical-pos`, and `web/...` paths are under `web/`. Library behaviour was checked against the installed `node_modules`.

**Bottom line for the designer:**
- **Main is online-first.** Every read and write goes from the browser to Supabase (PostgREST, RPC, Storage, Auth, Edge Function).
- **Offline support is limited** to three things:
  - a localStorage copy of the read cache that expires after 24h;
  - a checkout replay queue that only lives in memory;
  - a sessionStorage New Sale draft.
- **The offline checkout path has defects that lose or misreport sales** (section 3.4).
- **Cold-starting offline locks the app** (section 6).
- **The biggest bandwidth cost is a permission poll every 15 seconds** (section 7).

---

## 1. Boot and provider stack

**`web/src/main.tsx`**
- Order of providers: `LanguageProvider`, then `PersistQueryClientProvider`, then `AuthProvider`, then `FeedbackProvider`, then `OfflineBanner`, `SchemaBanner` and `AppRouter` (main.tsx:15-48).
- Persistence options (main.tsx:20-24):
  - persister: `persister`
  - `maxAge: PERSIST_MAX_AGE` (24h)
  - `buster: 'access-029'`
  - `shouldDehydrateQuery` leaves out every key in `ACCESS_READS` (main.tsx:24)
- `ACCESS_READS` = `my-permissions, current-user, users, roles, role_permissions, user_permissions, my-store-id, my-license, is-platform-admin` (web/src/data/refresh.ts:10). These are never persisted.
- `onSuccess`, after the cache is restored, calls `queryClient.resumePausedMutations()` (main.tsx:33-36).

**`web/src/lib/queryClient.ts`**
- Query defaults (queryClient.ts:9-18):
  - `staleTime: 30_000`
  - `gcTime: 24h`
  - `retry: 1`
  - `refetchOnWindowFocus: false`
  - `refetchOnMount` keeps the library default (true), so any query older than 30s refetches when its screen mounts.
- Checkout mutation defaults (queryClient.ts:26-33): `setMutationDefaults(CHECKOUT_MUTATION_KEY, { networkMode:'online', gcTime: 7d, retry: 3 })`. There is **no `mutationFn`** here (see bug B1).
- Persister (queryClient.ts:37-40): `createSyncStoragePersister({ storage: window.localStorage, key: 'lensy-query-cache' })`.
  - No `retry` option is set.
  - The library's default throttle is 1s (query-sync-storage-persister index.js:7).
- `PERSIST_MAX_AGE = 24h` (queryClient.ts:42).

**`web/src/lib/supabase.ts`**
- Throws at module load if `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing (supabase.ts:6-11). The app cannot boot without cloud config.
- One client with `persistSession: true, autoRefreshToken: true` (supabase.ts:15-20).
- No Realtime channels are used anywhere. A grep for `.channel(` and `realtime` in src/ finds nothing, so there is no websocket.

**`web/src/lib/auth.tsx`**
- Hydrates with `supabase.auth.getSession()` and subscribes with `onAuthStateChange` (auth.tsx:43-52).
- `signIn` calls `signInWithPassword`, mapping a username to `<username>@VITE_AUTH_EMAIL_DOMAIN` (auth.tsx:23-26, 54-58).
- `signOut` (auth.tsx:60-70):
  - calls `supabase.auth.signOut()`
  - runs `clearPosDraft()`
  - runs `queryClient.clear()`
  - removes `lensy-query-cache` from localStorage

This last step means **signing out also discards any persisted paused checkout**, because queries and mutations share the same storage key.

**`web/src/routes/AppRouter.tsx`**
- `createBrowserRouter`. Every screen is lazy-loaded (AppRouter.tsx:16-36).
- `RequirePermission` shows "Loading…" while `perms.loading` (AppRouter.tsx:40-54, specifically :45). `IndexGate` does the same (:59-73, :62).
- `/m-upload` is a standalone phone upload page (:78).
- `/platform` is the vendor licence admin page (:173-176).

**`web/src/components/AppLayout.tsx`** (gates in order)
1. Auth loading shows "Loading…" (:30-36). No user redirects to `/login` (:37).
2. Inactive or unassigned position (:39-45).
3. Not linked to a store, i.e. `license.data === null` (:54-79).
4. Licence `expired` or `none` blocks the whole app (:84-106). `grace` shows a read-only banner (:170-174).

Gates 3 and 4 only fire when `license.data` exists. When the licence query has not resolved (offline), nothing is enforced on the client.

**Permissions** (`web/src/data/permissions.tsx:60-74`)
- `my-permissions` query settings:
  - `staleTime: 0`
  - `refetchOnMount: 'always'`
  - `refetchOnWindowFocus: 'always'`
  - `refetchInterval: 15_000`
  - `retry: false`
- An effect invalidates `my-license` and `my-store-id` whenever the permissions data changes (:70-74). Structural sharing keeps the reference stable, so in practice this fires only on a real change.
- `loading = !!user && access.isPending` (:80).
- `useCurrentUser` also polls every 15s with `refetchOnWindowFocus: true` (web/src/data/staff.ts:21-24). It is mounted on the Notes page (NotesPage.tsx:170) and the Staff page (StaffPage.tsx:74, :177).
- IMPLEMENTATION_PLAN.md:37-39 documents this as intentional: "refresh every 15 seconds/focus, and are excluded from persisted query caches".

**Licensing** (`web/src/lib/licensing.ts`)

| Query | RPC | staleTime | Line |
|---|---|---|---|
| `my-license` | `my_license_state` | 60s | :44-55 |
| `my-store-id` | `auth_store_id` | Infinity | :57-68 |
| `is-platform-admin` | `is_platform_admin` | Infinity | :77-88 |

All three wait for a session. Grace and expiry are enforced on the server through RLS `license_write_ok()` (README.md:153-159).

---

## 2. Schema version gate

**What the database side does**
- `017_schema_version.sql` (web/supabase/017_schema_version.sql):
  - creates the ledger table `lensy_schema_versions(version pk, applied_at, note)`, with RLS on and no client access (:36-43);
  - `schema_version()` is `security definer` and returns `coalesce(max(version),0)`; it is granted to anon and authenticated (:53-58, :80);
  - `record_schema_version(p_version, p_note)` uses `on conflict do nothing`, with execute revoked from clients (:70-78);
  - it stamps itself as 17 (:85).
- `020_version_gate.sql`:
  - backfills 18 and 19 (:116-117);
  - adds `assert_versions_recorded(text[])`, which **raises** if the ledger is missing any numbered migration from 017 up, or if `max(version)` is below the highest file (:132-181);
  - stamps 20 (:190).
- `assert_versions_recorded` is called only by the pgTAP test (`web/supabase/tests/020_version_gate_test.sql:51-113`). No migration calls it.
- A static file check, `web/scripts/check-migrations-stamp.sh`, requires every migration from 017 on to contain `select public.record_schema_version(` (:42-67). 018 and 019 are grandfathered (:44).

**What the client side does** (`web/src/lib/schemaVersion.ts`)
- `EXPECTED_SCHEMA_VERSION = 29` (:11).
- `toState` (:24-36):
  - null, undefined, empty or non-numeric gives `unknown`;
  - `version < 29` gives `behind`;
  - otherwise (equal **or newer**) gives `ok`.
- `useSchemaVersion` (:46-62):
  - queryKey `['schema-version']`, `staleTime: Infinity`, `retry: false`;
  - a missing RPC (PGRST202 and similar, detected by `isMissingRpc` in web/src/data/rpc.ts:15-27) gives `unknown`;
  - any other error throws, so the query errors and has no data.
- `SchemaBanner` renders only when the state is `behind` (SchemaBanner.tsx:16-19). It is a fixed red strip and **never blocks** anything.
- The `schema-version` key is not in `ACCESS_READS`, so its result is persisted to localStorage for up to 24h. It is asked once per page load (once per 24h when restored from cache, because of `staleTime: Infinity`).

**Answers for an offline PC**
- **Locked out or frozen? No.** The gate is advisory. Offline, the RPC fails with a network error, the query errors, there is no data, and no banner shows. A previously persisted answer may still display for up to 24h. Nothing awaits this query, so it cannot hang the UI.
- **When the cloud schema moves ahead:** `toState` reports `ok` for any database version of 29 or higher. A PC running an old build **never learns it is too old**.
  - There is no minimum-client-version, no protocol version, and no build ID compared against the cloud.
  - Real breakage happens silently at the RPC call site instead. Example: 026 dropped and recreated `my_license_state` with a new return type (web/supabase/SETUP.md, Step 23).
  - **Design consequence:** sync needs a `sync_protocol_version` and a cloud-side `min_client_version`. The PC checks both before pushing. While incompatible, the PC keeps selling and holds its outbox.
- **Process risk:** migrations are pasted by hand into the Supabase SQL editor (DEFERRED.md:49-51; RELEASE_029.md:10-23). DEFERRED.md:54-55 says adding a migration requires bumping `EXPECTED_SCHEMA_VERSION`.
- **The PC will need the same mechanism.** A local database needs its own migration ledger (the same idea as `lensy_schema_versions`) and a check between the local schema and the app build.

---

## 3. How offline replay and the draft work today

### 3.1 Checkout replay (`web/src/lib/offlineMutations.ts`)
- `CHECKOUT_MUTATION_KEY = ['sale-checkout']` (:34). Only checkout is replayable. The reasoning is at :21-30.
- `isQueuedOffline()` returns `!onlineManager.isOnline()` (:69-71). It reads the browser online flag, **not** whether a mutation is actually paused.
- `useCreateSale` (web/src/data/sales.ts:571-791):
  - uses `mutationKey: CHECKOUT_MUTATION_KEY` (:574);
  - loops up to 3 times on invoice-number conflicts (:577);
  - checks the invoice number exists, or calls `nextInvoiceNo()` (:579-591);
  - preferred path: `create_sale_order` RPC with `p_sale, p_items, p_exams, p_payments, p_idempotency_key` (:640-674);
  - fallback: non-atomic client-side inserts (:676-782);
  - `onSuccess` runs `invalidateSales` plus `['sales']` and `['inventory']` (:786-790).
- Idempotency key:
  - minted once per checkout in POSContext (web/src/features/pos/POSContext.tsx:67-76 `newIdempotencyKey`, :558-563);
  - held in `idemRef` and in the draft (:243, :277);
  - cleared after a successful save (`clearPosDraft` at :796).
- Pause and resume:
  - TanStack pauses `networkMode:'online'` mutations while offline;
  - `QueryClient.mount` subscribes to `onlineManager` and calls `resumePausedMutations` on reconnect (query-core queryClient.js:38-44, 205-207);
  - paused mutations are dehydrated into the same `lensy-query-cache` localStorage blob.

### 3.2 Draft (`web/src/lib/posDraft.ts`)
- sessionStorage key `lensy-pos-draft-v1` (:13). It is namespaced by `{userId, storeId}` (:22-35, :37-43, :45-51). Every read and write is wrapped in try/catch.
- POSContext:
  - hydrates once `user` is known and `storeLoading` is false (:267-279);
  - writes on every state change (:282-285);
  - also keeps a module-level memory snapshot.
- sessionStorage survives a reload of the same tab. It does **not** survive closing the tab or browser, or a PC reboot. The idempotency key and invoice number of a half-finished sale are lost with it.

### 3.3 What the offline banner claims
- `OfflineBanner` reads `onlineManager` (OfflineBanner.tsx:15-19) and shows "Offline - showing saved data. New sales cannot be saved until you reconnect." (:23).
- The POS catch block tells the cashier the opposite: "Saved on this device. It will sync to the shop when you reconnect." (POSContext.tsx:661-667).
- SETUP.md Step 14 (web/supabase/SETUP.md:376-398) describes the queue and says to test it by going to airplane mode, checking out, and **reloading**.

### 3.4 Defects in the offline path

**B1. A queued sale is lost if the page reloads.**
- The hydrated paused mutation gets its options from `setMutationDefaults`, which has no `mutationFn` (queryClient.ts:26-33).
- On resume, query-core rejects with `"No mutationFn found"` (node_modules/@tanstack/query-core/build/modern/mutation.js:71-72).
- Nothing surfaces the error, and failed mutations are not persisted, so the sale disappears.
- The SETUP.md "check it worked" test is exactly this failing case. There is no `offlineMutations` unit test.

**B2. False "Saved on this device".** `finishOrder` makes several network calls **before** `createSale.mutateAsync`:
- `addNewFramesFromExams` (POSContext.tsx:565)
- `addMissingOrderMetadata` (:569)
- `findOrderImages`, a storage list (:588)
- `resolveStaffUserId()`, which does `auth.getUser()` plus a `users` select (:627; web/src/data/staff.ts:26-30)

Offline, these throw. The catch at :661 sees `isQueuedOffline()` is true and reports the sale as saved on the device, when **nothing was queued**. The cashier is told money is safe when it is not.

**B3. Offline checkout is barely reachable.**
- The customer step needs the network: `addCustomer` or `updateCustomer` mutations (POSContext.tsx ~:393-401).
- Entering the cart awaits `nextInvoiceNo()`, the server `next_invoice_no` RPC (POSContext.tsx:344-363, :361; sales.ts:496-507).
- So a sale cannot start offline. The queue only helps if the connection drops between the customer step and Finish, and B2 usually fires first.

**B4. A full localStorage quota silently drops paused checkouts.**
- The persister catches a quota error and, with no `retry` configured, simply gives up (query-sync-storage-persister index.js:12-33).
- Queries and paused mutations are one blob, so the whole save is lost, including queued sales.
- Large lists make this likely: full inventory, all sales, all customers, and nested sales for customer orders (section 7).

**B5. Signing out wipes the queue** (auth.tsx:60-70).

**B6. Overnight offline loses the cache.** `PERSIST_MAX_AGE` is 24h, after which the restored cache is thrown away.

---

## 4. Tests

**Unit tests (vitest)**
- Run with `npm test`, which is `vitest run` (web/package.json:11). Watch mode is `test:watch` (:12).
- `web/vitest.config.ts` is standalone and does not load the PWA or Tailwind plugins. It includes `src/**/*.test.{ts,tsx}` and defaults to the `node` environment; jsdom is opted into per file with `// @vitest-environment jsdom` (4 files, e.g. posDraft.test.ts:1).
- 23 test files:
  - lib: posDraft, schemaVersion, payments, storageOrphans, createUserAuthz, database.types, platformReportShape, suggest
  - data: permissions, refresh, sales, reportRpc, zreport, customerLedger, labWait
  - features/pos: pricing, receipt, enterNav, types
  - other: inventoryTabs, computeReport, i18n translations, SearchableSelect
- IMPLEMENTATION_PLAN.md:45 and RELEASE_029.md:59 report 260 tests passing.
- **No test covers offline replay, the persister, or resuming after a reload.**
- Fixture mode: `web/qa/vite.config.ts` swaps `lib/supabase` for an in-memory fake (`web/qa/supabase.ts`) through a `resolveId` plugin (qa/vite.config.ts:8-10). Run with `npm run dev -- --config qa/vite.config.ts`. This already works as a module seam for replacing the data backend.

**SQL tests (pgTAP)**
- `npm run test:db` runs `bash scripts/test-db.sh` (package.json:13). The script (web/scripts/test-db.sh:23-82):
  1. applies `tests/_shim.sql` (roles and the `auth`/`storage` schemas faked on plain Postgres, plus pgtap);
  2. runs `check-migrations-stamp.sh`;
  3. applies every `supabase/[0-9][0-9][0-9]_*.sql` in order to an **empty** database;
  4. runs every `tests/*_test.sql`, each a transaction that rolls back, and parses the TAP output (`^not ok`, `^1..N`).
- 18 test files cover 012-029. RELEASE_029.md:59 reports 365 assertions.
- Running locally on Windows:
  - `npm run db:local` runs `scripts/local-db-setup.ps1`: `@embedded-postgres/windows-x64` from npm, pgTAP 1.3.4 copied in, `shared_buffers` 16MB, and data in `web/.local-db`;
  - `npm run test:db:local` runs `scripts/test-db-local.sh`, which drops and recreates the `lensy` database, puts the shim on PATH, and calls test-db.sh;
  - `scripts/psql-shim.js` is a minimal `psql` built on the node `pg` driver (`pg` is a devDependency at package.json:39).
- Schema fingerprint: `npm run db:fingerprint` runs `scripts/schema-fingerprint.sh`, which hashes a normalised `pg_dump --schema-only --no-comments` with `\restrict` lines stripped (:62-71). The baseline is `web/supabase/schema.fingerprint`.
- Benchmark: `npm run bench:db` (supabase/bench/seed_50k.sql, bench_queries.sql).

**CI** (`.github/workflows/ci.yml`)
- Job `web` (:10-38): `npm ci`, oxlint, `tsc -b`, vitest, `vite build`, on Node 24.
- Job `db` (:40-105): Docker `postgres:16` plus `postgresql-16-pgtap`, then test-db.sh, with failures turned into annotations.
- Fingerprint step (:116-184): computes the hash twice and requires them to match, then compares with the committed baseline.
- `.github/workflows/schema-baseline.yml` is a manual workflow that captures the live schema.

---

## 5. Deployment today

**Web app**
- `render.yaml` defines a Render static site `lensy-web`:
  - rootDir `web`, `buildCommand: npm install && npm run build` (render.yaml:18), publish `dist`;
  - environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set in the dashboard;
  - `VITE_AUTH_EMAIL_DOMAIN=lensypos.local`;
  - SPA rewrite `/* → /index.html`.
- README.md:175 says `npm ci`, which does not match render.yaml.

**PWA** (`web/vite.config.ts:11-41`)
- `vite-plugin-pwa` with `registerType: 'autoUpdate'` and `injectRegister: 'auto'`.
- Workbox precaches `**/*.{js,css,html,svg,png,woff2}` with `navigateFallback: '/index.html'`.
- **There is no runtime caching.** All Supabase API and Storage requests go to the network; reads come from the TanStack cache.
- `autoUpdate` means a new deploy silently activates on the next load. The client version can therefore change under a PC without anyone choosing to update it, which matters once a local database schema is tied to the build.

**Dev server**
- Port from `PORT`, default 5173; `host: true` exposes it on the LAN for tablets (vite.config.ts:43-47).
- `.claude/launch.json` runs `npm --prefix web run dev`.

**Backend** (Supabase project; RELEASE_029.md:35 names the project ref)
- Postgres with RLS. Migrations 000-029 are pasted by hand into the SQL editor.
- Storage: public bucket `prescriptions` (SETUP.md:52-59).
- Edge Function `create-user` (`supabase/functions/create-user/{index.ts,authz.ts}`) is called through `supabase.functions.invoke` (StaffPage.tsx:31, PlatformPage.tsx:115). It creates Supabase Auth users with the service-role key.

**Local leftovers (gitignored)**
- `web/dist` is stale from the offline-first branch build: it contains `SetupPage-*.js` and `localAuth-*.js`, and main has no `features/local`.
- `web/.env.fakecloud.local` and `web/.env.fakephone.local` exist; their contents were not read.
- `.junie/` is untracked.

**Stale docs**
- README.md:61 and web/README.md:60 say "migrations 000–010".
- README.md's migration table stops at 020 (:108-130).
- web/supabase/SETUP.md:607-611 says the app expects 25; the code expects 29.

---

## 6. Every place the app assumes it is online

**Auth**
- **Sign-in:** `signInWithPassword` needs the network (auth.tsx:54-58). There is no local credential.
- **Session after a cold start:** `getSession()` with an access token older than about an hour tries a refresh. On a network error it returns `session: null` while keeping the token in storage (auth-js GoTrueClient.js ~2483-2503, version 2.108.2). The app then redirects to `/login` (AppLayout.tsx:37), and logging in is impossible offline.
- **Token refresh:** `autoRefreshToken` refreshes about once an hour while the app is open.

**Permissions and licence**
- **Permissions:** `my_permissions` RPC, not persisted. On an offline cold start the query stays paused and pending, so `perms.loading` stays true and every route shows "Loading…" forever (AppRouter.tsx:45, :62).
- **Store ID:** `auth_store_id` RPC, not persisted.
  - The POS draft never hydrates offline because `storeLoading` stays true (POSContext.tsx:273).
  - `uploadOrderImage` throws `no-store` (storage.ts:56).
- **Licence:** `my_license_state`, not persisted. Offline means the licence is not enforced at all on the client (AppLayout.tsx:54, :84). Enforcement exists only through server RLS.
- **Platform admin:** `is_platform_admin` RPC.
- **Staff creation:** the Edge Function, cloud only.
- **Current-user row:** polled every 15s (staff.ts:24).
- **Staff ID for checkout:** `resolveStaffUserId` does `auth.getUser()` (network) plus a `users` select (staff.ts:26-30, POSContext.tsx:627).

**Money flow**
- **Invoice numbers:** server sequence `next_invoice_no` (sales.ts:496-507), called when entering the cart (POSContext.tsx:361). An existence check on `sales.invoice_no` runs at POSContext.tsx:348-352 and sales.ts:582-587. The PC cannot mint invoice numbers offline.
- **Checkout:** `create_sale_order` RPC. Offline it is queued only in memory (see 3.4).
- **Edit sale / re-checkout:** `update_sale_order`, not queued.
- **Void, refund, collect payment, close shift:** `void_sale`, `refund_sale`, `collect_sale_payment`, `close_shift` / `z_report`. None are queued; all fail offline.
- **Customer create and update:** mutations, not queued. They are required before a sale can start.
- **Purchases and receiving:** `receive_purchase`, `delete_purchase`, `delete_purchase_payment`, plus table writes in suppliers.ts.
- **Inventory and metadata writes:** `add_inventory_item` and table writes. `addNewFramesFromExams` and `addMissingOrderMetadata` run at checkout.
- **Lab:** `set_lab_status`, `replace_order_examinations`, `lab_queue`.
- **Reports:** `report_sales_window`, `report_top_customers`, `report_voided_count`, `store_day_range`, `customer_balance`, `customer_debtors`, `platform_report_window`. All are server-computed, so a Z-report or report cannot be produced offline unless it was cached.

**Search, photos and the phone**
- **Search:** `search_text` RPC, fired per keystroke once 2 or more characters are typed, with no debounce (web/src/data/search.ts:40-46). Cached per term.
- **Photos:**
  - `uploadOrderImage` uploads directly to Storage (storage.ts:50-67);
  - display uses public cloud URLs from `prescriptionImageUrl`, with full-size images used as `<img>` thumbnails (CustomerDetailPage.tsx:169, :184; HistoryPage.tsx:264; MUploadPage.tsx:135);
  - `findOrderImages` lists Storage at checkout (storage.ts:80-98);
  - the orphan sweep (storageOrphans.ts, data/storageCleanup.ts) also uses Storage.
- **Phone upload flow:** the QR code encodes `${window.location.origin}/m-upload?inv=…` (ExamSection.tsx:317, HistoryPage.tsx:220). The phone uploads to the cloud, and the PC finds the photo by listing Storage. If the PC serves from localhost, the QR origin is unusable from a phone.

**Remaining online assumptions**
- **Schema version:** RPC, silent when offline (section 2).
- **Cache lifetime:** 24h, localStorage only, about 5MB quota. ACCESS_READS are excluded.
- **Persistence model:** there is no IndexedDB, no outbox beyond checkout, and no local database.
- **Supabase coupling:** 24 modules import the client directly (16 in `data/` plus POSContext, StaffPage, PlatformPage, MUploadPage, auth, licensing, schemaVersion, storage). That is about 34 `.rpc(` call sites and about 118 `.from('…')` call sites.
- **No repository seam on main.** The reference branch's `repository*.ts` is absent. The qa `resolveId` alias is the only substitution point.

---

## 7. Network traffic estimate for the current app

**Assumptions** (all estimates; nothing was measured):
- one register PC, open 12h a day with the tab visible, 26 trading days a month;
- 30 sales a day, 15 of them with 2 photos;
- about 150 screen changes a day, Reports opened 3 times a day;
- HTTP/2 over TLS to supabase.co. Small requests cost about 2.5-4 KB on the wire each (JWT plus apikey headers, about 0.6-0.8 KB of response headers, framing; HPACK compresses repeated headers);
- JSON bodies are gzip-compressed by Supabase;
- hosted Supabase's default API cap of 1000 rows (a dashboard setting, not configured in this repo) limits the unbounded lists.

| Source | Mechanism (citation) | Per day | Per month (26d) |
|---|---|---|---|
| Permission poll | `my_permissions` every 15s plus on focus (permissions.tsx:67-68); about 50 codes, about 1-1.5 KB body; 2,880 calls in 12h; runs even when idle; pauses only when the tab is hidden | **7-12 MB** | **180-310 MB** |
| Current-user poll | every 15s while Notes or Staff is mounted (staff.ts:24) | 0-5 MB | 0-130 MB |
| Token refresh | about hourly | <0.1 MB | <3 MB |
| Schema version | once per page load or per 24h | negligible | negligible |
| Checkout chain, per sale | invoice check plus `next_invoice_no`; customer insert or search; frame and metadata lookups; Storage list; `auth.getUser`; users select; `create_sale_order` (3-6 KB); then `invalidateSales` marks 17 keys stale and refetches the active ones (refresh.ts:4-9), including the full Frame inventory list `select *` (inventory.ts:44-67, used by ExamSection.tsx:39), about 20-80 KB gzipped | 1.2-3.6 MB (40-120 KB per sale) | 30-95 MB |
| Photo uploads | downscaled to a 1600px edge, JPEG quality 0.82 (storage.ts:26-42), about 200-450 KB each; 30 a day; uploaded once, but a retake uploads again and replacing a photo calls remove plus upload | 6-13 MB | 155-340 MB |
| Photo views | full-size image used as a thumbnail; `cacheControl: '3600'` (storage.ts:62) means revalidation (a cheap 304) after 1h, but a full download on first view per device | 2-10 MB | 50-260 MB |
| Screen refetches | 30s `staleTime` plus `refetchOnMount`; about 150 changes at 10-60 KB each (customer orders `select *, sale_items(*), order_examinations(*)` sales.ts:398-412; History pages of 50; lab queue) | 1.5-9 MB | 40-235 MB |
| Reports page | `useSalesSummary` fetches **every** sale with 12 columns (sales.ts ~245-262), `useCustomers` fetches every customer `select *` (customers.ts:9-21), full inventory, plus report RPCs; 100-300 KB gzipped per open | 0.3-0.9 MB | 8-25 MB |
| App shell | SW precache about 1 MB raw (about 300 KB gzipped) per deploy, on each device; `sw.js` checks are tiny | per deploy | about 0.3-1 MB per release |
| **Total** | | **~20-50 MB** | **~0.5-1.3 GB** |

**What drives the cost**
1. The **15s permission poll** is a fixed 7-12 MB a day even when nobody uses the till. It is the single biggest change to make.
2. **Photos** cost 8-23 MB a day across upload and viewing. The fixes are smaller images (for example a 1280px edge, quality 0.7, or WebP, about 100-150 KB), upload once, and local thumbnails.
3. **Refetch after invalidation** pulls whole lists again (full inventory, all sales, all customers) instead of deltas.
4. `search_text` per keystroke and screen-mount refetches add smaller amounts.

**For comparison:** a one-way delta sync of sale, item, payment and audit rows is about 2-5 KB gzipped per sale, so 30 sales is about 0.15 MB a day. Add each photo once at about 120 KB (about 3.6 MB a day for 30 photos), a heartbeat or licence check every few hours, and no polling. That totals roughly **4-5 MB a day (about 100-130 MB a month), mostly photos**.

---

## 8. What the design must change in this infrastructure

1. **Remove the cloud from the PC's critical path.** That means auth (local staff sign-in), permissions, store ID, licence (a signed window cached locally), invoice numbering (a local sequence), and every money RPC (local equivalents of `create_sale_order`, `void_sale`, `refund_sale`, `collect_sale_payment`, `close_shift`/`z_report`, and the reports).
2. **Replace the localStorage persister and the in-memory checkout queue** with a durable local store and outbox. B1 to B5 must not survive the redesign. Persist the POS draft durably (not sessionStorage), keyed by its idempotency key.
3. **Version gate:** keep a local migration ledger. Add `sync_protocol_version` and a cloud-side `min_client_version`, checked only by the sync worker, never by the selling UI. Disable PWA `autoUpdate` for the PC, or gate the update on local migrations having run.
4. **Bandwidth:** remove the 15s polls (permissions only matter locally on the PC), push deltas only, gzip batches, upload each photo once and smaller, and never re-download full lists.
5. **Phone:** a separate read-only build against the cloud. The QR `/m-upload` origin must point at the cloud URL, not the PC's origin.
6. **Fix the copy:** OfflineBanner.tsx:23 and POSContext.tsx:664 contradict each other, and SETUP.md Step 14 describes behaviour that does not work.


### REPORT: reuse
# Reuse assessment: closed `origin/offline-first` branch vs `main` (cf78ca5)

Citation conventions:
- `ref:` means the file as it is on `origin/offline-first`. Read it with `git -c safe.directory=D:/Projects/optical-pos/optical-pos show origin/offline-first:<path>`.
- `main:` means the working tree on `offline-first-v2`, which equals `origin/main`.
- `file:N` or `file:N-M` gives line numbers.

---

## 0. Bottom line

- **Worth keeping: the local infrastructure.** This means:
  - the IndexedDB layer that writes the mirror and the outbox in one transaction;
  - the ordered outbox drain, including batching, isolating the one rejected entry, holding the queue and letting an admin skip;
  - Web Locks so only one window writes;
  - offline staff sign-in with a PBKDF2 verifier;
  - backup export and import;
  - the restore guards;
  - the register-claim idea;
  - the setup, sync and backup screens.
- **Unusable as written: the replication model.** Each local write becomes a row upsert or delete sent to Supabase as an "admin device account". Main now refuses almost every one of those writes, and it re-derives money, actor and time on the server.
  - A rebuild needs a new server-side intake path, for example a single `SECURITY DEFINER` RPC that takes a batch of events from the registered PC.
  - It also needs the money rules (pricing, payment ledger, void, refund, Z-report) to run on the PC, so they work offline.
- **Unusable: the data layer.** `repository*.ts` was cut against the old data layer at 09d248c. Main's `data/*.ts` was rewritten after that: about 33 RPCs, a payment ledger, void and refund, Z-report, lab queue, effective permissions and checked staff admin. The seam idea is still useful. The interface and both implementations must be rebuilt from main's hooks.
- **Bad for the data quota: the ref sync loop is chatty.**
  - It lists storage every 2 minutes.
  - It downloads the whole staff and roles tables every 10 minutes.
  - It writes a heartbeat every 5 minutes.
  - It calls the licence and register RPCs every 10 minutes.
  - All of this must be replaced with event-driven, delta-only traffic.

---

## 1. Facts on main that make the branch's assumptions false

| # | Assumption in the ref branch | Where it is assumed | What main does now (evidence) | Effect |
|---|---|---|---|---|
| A1 | A sale is created by upserting rows into `sales`, `sale_items`, `order_examinations` and `stock_movements`, using the PC's own invoice number | ref:web/src/lib/repositoryLocal.ts:437-468, 394-430; ref:web/OFFLINE.md:143-144 (the PC never calls `create_sale_order`) | `revoke insert,update,delete on sale_items, order_examinations` and `revoke insert,delete on sales` from authenticated (main:web/supabase/029_effective_permissions.sql:739-740). A Postgres upsert needs INSERT privilege, so even an upsert of an existing row is refused. | Sale replication by rows is impossible. |
| A2 | The client writes money columns such as `total_amount`, `discount`, `net_amount` and `amount_paid` on the sale header | ref:repositoryLocal.ts:449-452 and 486-492 | The `sales_money_guard` trigger refuses money changes unless `lensy.money_write` is set (main:013_void_refunds.sql:208-228). `amount_paid` is recomputed from `sale_payments` (013:231-251). `create_sale_order` re-prices the cart with `price_cart` and raises `price changed` or `insufficient stock` (013:259-337; 029:295-298). | The PC's totals are not accepted. Pricing must run on the PC, or the server must accept the PC's totals through a trusted path. |
| A3 | There is no payment ledger: payment is just `sales.amount_paid` | ref:web/src/lib/local/schema.ts:25-68 has no `sale_payments` table | `sale_payments` is the source of truth (main:011_sale_payments.sql:45-60). Direct insert, update and delete are revoked (029:818). Money comes in only through `create_sale_order`, `update_sale_order`, `collect_sale_payment` (029:800-817), `refund_sale` (028:96-169) or `void_sale` (014:338-406). | The ref schema cannot represent split tenders, refunds, voids or the Z-report. |
| A4 | `user_id` and `created_by` come from the client | ref:repositoryLocal.ts:448 (`user_id: input.userId`) and :819-823 (notes `created_by`) | `create_sale_order` stores `user_id = auth.uid()` (029:349) and `recorded_by = auth.uid()` (029:403). `void_sale` stores `voided_by = auth.uid()` (014:400-404). `refund_sale` stores `recorded_by = auth.uid()` (028:163). `close_shift` stores `closed_by = auth.uid()` (023:229). The notes insert policy requires `created_by = auth.uid()` (029:825-829). `audit_log.actor = auth.uid()` (014:93-101). | If you replay main's RPCs as one "device account", every sale, payment, void, refund, close and note is credited to that account. Per-staff history and attribution would be lost. |
| A5 | The client writes stock movements and deletes them on re-checkout | ref:repositoryLocal.ts:412-421, 507/513, 649-669, 800-803 | Delete policies on `stock_movements`, `sales`, `sale_items`, `sale_payments`, `purchases`, `purchase_items` and `purchase_payments` are dropped (013:810-830). Action policies on `stock_movements`: insert needs `inventory.edit`, update and delete are `false` (029:225-238). Sales movements are written only inside the RPCs (029:378-382, 527-531). | Deletes of movements, sale items or exams cannot replicate. Re-checkout must go through `update_sale_order`-equivalent semantics. |
| A6 | Stock is the sum of every movement, and `stock_qty` is a computed property to strip | ref:repositoryLocal.ts:153-165; ref:schema.ts:86 (`stock_qty` in `NON_COLUMN_PROPS`) | `inventory.stock_qty` is a real cache column kept by the `stock_qty_sync` trigger on every movement (main:012_integrity.sql:69-91). `available_stock()` reads it (012:94-97). | The PC should keep `stock_qty` in the same transaction as the movement. Upload movements only and let the server trigger rebuild `stock_qty`; do not upload `stock_qty` as well. |
| A7 | A header edit is a full-row upsert of the sale | ref:repositoryLocal.ts:519-532 | `guard_sale_access` allows only `doctor_name`, `delivery_date`, `rx_image_path`, `frame_image_path` and the `lab_*` fields to change, and needs `history.edit`. A lab change also needs `lab.edit`. Replacing a photo needs an admin (029:774-796). `set_lab_status` is the lab path (029:748-756). | Every column outside that whitelist is refused. |
| A8 | A customer delete can cascade to their sales | ref:repositoryLocal.ts:260-277 | Sales deletes are revoked (029:740). Main deletes only the customer row and turns a foreign-key error into `CustomerHasRelatedRecordsError` (main:web/src/data/customers.ts:216-241). | Drop the cascade. |
| A9 | Staff, roles and grants are written as rows | ref:repositoryLocal.ts:889-913, 959-970 | `revoke insert,update,delete on roles, users, role_permissions, user_permissions` (029:186). Changes go through `create_staff_role`, `set_role_permission`, `set_user_permission` and `set_staff_access` (029:111-182). | The intake path must accept RBAC events and re-check them, or RBAC edits stay online-only. |
| A10 | Login-to-staff resolution uses own id, the `auth_uid` link or `username@domain`; an account with no position counts as admin | ref:web/supabase/011_multistore_hardening.sql:99-134, 296-303; ref:sync.ts:852-864 and 881; ref:localAuth.ts:187-189 | 014 removed the username fallback (014:296-302). 015 re-pointed every staff row so that `users.id = auth.uid()` (015:39-118). 029: `auth_store_id()` needs `is_active` and a role in the same store (029:74-79). `is_store_admin()` is admin or owner role only; a null role or the `superadmin` username is not admin (029:44-50). | The `auth_staff_id` and `auth_uid` column and the email matching contradict main. Staff identity is `users.id` = auth id, and nothing else. |
| A11 | Standalone prescriptions get a `PRESC-<base36>` invoice number | ref:repositoryLocal.ts:534-549 | Uses the normal counter and `kind='prescription'`, which the server re-derives from the cart (main:web/src/data/sales.ts:1202-1235; 029:312-331). | Drop `PRESC-`. Add the `kind` column. |
| A12 | The licence is `active`, `grace`, `expired` or `none`, with a 30-day grace | ref:web/src/lib/local/state.ts:7, 67-85 | `my_license_state` adds `pending` and returns `starts_at` (026:82-103). Read is allowed for 30 days after expiry; write only inside `[starts_at, expires_at)` (026:42-60). Main's own TS type also lacks `pending` (main:web/src/lib/licensing.ts:34-41). | Add `pending` and the `starts_at` window to the cached licence. |
| A13 | Event times are the PC's | ref commit stamps `nowIso()` locally | Server functions stamp `now()`: `void_sale` `voided_at` and movement `created_at` (014:383, 400-404); `refund_sale` `paid_at` (028:163); `collect_sale_payment` (029:815); `close_shift` `closed_at` (023:61); sale movements (029:381). The `lab_status_stamp` trigger overwrites `lab_status_changed_at`, `lab_started_at` and `lab_ready_at` with `now()` (019:76-97). | Replaying commands after hours or days offline moves money events into the wrong Z-report or store-day window and corrupts lab dwell times. Event time has to travel with the event, and the triggers must honour it on intake. |
| A14 | Invoice numbers are the PC's | ref:repositoryLocal.ts:373-386 | `create_sale_order` keeps the client's number only if no sale in any store has it, and otherwise silently takes `next_invoice_no()` (029:333-340). `invoice_no` is globally UNIQUE (000_base_schema.sql:154). The counter is per store (012:105-150). | Replaying through `create_sale_order` can renumber a sale in the cloud, so the paper receipt and the cloud disagree. |
| A15 | Replaying the same request twice is harmless because it is an upsert by primary key | ref:sync.ts:7-9 | Idempotent: only `create_sale_order`, through `idempotency_key` (012:170-172; 029:277-286). `void_sale` raises `already voided` and `close_shift` raises `already closed` (detectable). `refund_sale` and `collect_sale_payment` have no key: a replay after a lost response pays out twice. | Any command-replay design needs idempotency keys on every money RPC. |
| A16 | One global `settings.key`; ref 011 added per-store uniqueness | ref:schema.ts:48-49 | Still a global `UNIQUE(key)` (000:280). Main's client upserts `onConflict:'key'` (main:web/src/data/settings.ts:31). | The heartbeat key `pc_last_sync` (ref:sync.ts:625-629) clashes across stores in this multi-store project. |
| A17 | The cloud schema may drift, so the client strips unknown columns and tries other conflict targets | ref:sync.ts:221-284 | Main has `schema_version()` and a version gate (017, 020; main:web/src/lib/schemaVersion.ts:11 `EXPECTED_SCHEMA_VERSION = 29`). | Silently stripping columns loses data. Replace it with an explicit version handshake. |
| A18 | Permissions are evaluated client-side from mirrored rows | ref:repositoryLocal.ts:856-913 | The UI authority is the `my_permissions()` RPC (029:81-89; main:web/src/data/permissions.tsx:57-89). The server rule is `resolve_can` (029:52-71): override, else the role grant, plus the `.view` prerequisite, the admin/owner bypass, and an active user with a role. Main's TS `resolveCan` (main:web/src/data/permissionModel.ts:25-29) has no admin bypass and no active check. | The PC needs a TS port of the 029 `resolve_can` and `is_store_admin`, not of the old rules. |
| A19 | Staff can be created offline and set a local password | ref StaffPage diff | `create-user` is an Edge Function with authz checked as the caller and a seat limit (main:supabase/functions/create-user/index.ts:61-108). | Staff creation stays online-only. The PC should insert the returned row locally, so no later "pull new staff" is needed. |

---

## 2. Component verdicts

Verdicts are: **Port as-is**, **Port with changes**, **Replace by main's version**, **Drop**, **Concept only** or **Build new**.

### 2.1 `web/src/lib/local/db.ts` — **Port with changes**

Keep:
- `commit()`: one transaction for the mirror, the outbox and the `commitSeq` bump (ref:db.ts:240-300).
- `withLock` using Web Locks (194-205).
- The BroadcastChannel cross-window invalidation (174-186).
- `outboxUpdateIfPresent` (346-355) and `outboxSkipHead` (362-383), which are race-safe.
- `replaceStores` with `expectCommitSeq` plus the outbox-empty guard (430-487).
- `snapshot` (490-500).

Change:
1. `openDb` only creates missing stores (ref:db.ts:74-88). It has no versioned upgrades, so it cannot add indexes to existing stores. Add a real migration ladder keyed on `oldVersion` and a local schema-version constant, the counterpart of main's `EXPECTED_SCHEMA_VERSION`.
2. Outbox entries today are `{table, op, key, rows}` holding full rows (ref:db.ts:28-42). Change them to domain events, for example `{id, type: 'sale.create' | 'payment.collect' | 'sale.void' | 'sale.refund' | 'lab.set' | 'stock.adjust' | 'customer.upsert' | 'shift.close' | …, actor_id, at, payload}`. Keep the "apply locally and enqueue in one transaction" rule.
3. Add stores for what main has:
   - `sale_payments`;
   - `shift_closes`;
   - store and licence data (time zone, `allow_negative_stock`, name);
   - `purchase_items` with `received_at`;
   - the new sales columns: `voided_at`, `voided_by`, `void_reason`, `idempotency_key`, `kind`, `lab_status_changed_at`, `lab_started_at`, `lab_ready_at`;
   - `sale_items.discount` and `sale_items.discount_reason`;
   - `stock_movements.kind`;
   - `inventory.stock_qty`.

### 2.2 `web/src/lib/local/schema.ts` — **Port with changes**

- The `TableDef` idea (key, indexes, `storeScoped`) is useful for the local mirror and for setup or restore downloads.
- Drop `conflict` and `optional` (ref:schema.ts:16-22, 48-49). They exist only for schema drift.
- Remove `stock_qty` from `NON_COLUMN_PROPS` (ref:schema.ts:86). It is a real column on main.
- Add the tables and columns listed in 2.1.

### 2.3 `web/src/lib/local/sync.ts` — **Port with changes (heavy)**

Item by item:

| Part | Lines | Verdict |
|---|---|---|
| Status store (`SyncStatus`, `useSyncStatus`) | 72-136 | Port as-is. Add `bytesSentThisMonth` and `lastSuccessfulIngestAt`. |
| Error classes, `classify`, `friendly` | 142-215 | Port with changes. Reuse main's `isMissingRpc` (main:web/src/data/rpc.ts:15-27). Map the new server messages: `price changed`, `insufficient stock`, `insufficient permission: …`, `Store licence does not allow writes`, version mismatch. |
| `strippedColumns` and `conflictPick` | 221-284 | **Drop.** Replace with a version handshake (A17). |
| `pushUpsert`, `pushDelete`, `assertCanWrite` (direct table writes) | 286-341 | **Drop.** Main refuses them (A1–A9). Replace with one call per batch to a new intake RPC. |
| `nextGroup`, `pushGroup`, `drainOutbox` (ordered, batched, isolate the rejected entry, hold) | 344-424 | Port with changes. Keep the algorithm. A "group" becomes one RPC payload capped by bytes, not by row count. Keep the backoff (375) and the clock-change guard (394). |
| `uploadImages` (isolation, 409 or "exists" counted as success, never blocks rows) | 430-481 | Port as-is. Check compression in 2.12. |
| `refreshLicense` every 10 minutes | 487-504 | Port with changes. Add `pending` and `starts_at`. Fetch once per sync session, or return the licence inside the intake response, instead of on a timer. |
| `claimRegister` and `checkRegister` | 506-552 | Port with changes. Needs a new migration (see section 3). Call it at setup. Fold "is current" into the intake RPC's answer so it costs no extra request. Today it is called every 10 minutes and before every push (539). |
| `refreshStaff` and `pullNewStaff` (whole users and roles tables every 10 minutes) | 554-559, 988-1011 | **Replace.** The PC creates staff online through `create-user` and can store the returned row. For cloud-side deactivation or a vendor change, return a small `staff_rev` or changed-staff delta in the intake response, or pull on a manual "Refresh staff" action. |
| `adoptPhoneImages` (lists 100 storage objects every 2 minutes) | 561-621 | **Drop or replace.** It is the largest quota cost; see section 4. If the QR phone upload is kept, use a small table such as `phone_photo_inbox (store_id, invoice_no, slot, path, created_at)` and query it with a `created_at > cursor` filter only when an order screen asks for it, or on a manual button. Keep the safety rules: `photoTime` and "never adopt a photo older than the order" (562-577, 602-607). |
| `heartbeat` writing `settings.pc_last_sync` every 5 minutes | 623-629 | **Replace.** Have the intake RPC stamp `store_registers.last_sync_at`, so no extra request or settings write is needed and A16 is avoided. The phone reads it. |
| `cycle`, `cloudSession`, AuthError then one refresh then `needsLink` | 638-712 | Port with changes. Remove the periodic network tasks. Keep the session handling and the licence hold. |
| `syncNow` (Web Lock `ifAvailable`, manual flag) and `startSync` | 714-748 | Port with changes. Keep `onCommit` debounce (1.5 s) and `online` event kicks. Change the 30-second `setInterval` (59, 746) so it is local-only. Only call the network when the outbox or the image queue is non-empty, with exponential backoff. |
| `skipBlockedEntry` and `skipBlockedImage` | 754-760, 471-481 | Port as-is. |
| `pullTable` (keyset paging), `pullAll`, `restoreFromCloud` and its guards | 770-818, 948-980 | Port with changes. Add the new tables. Keep the guards: outbox empty, `commitSeq` unchanged, session still valid, sanity checks against an empty download (950-971). These are full downloads and cost quota, so show a size estimate before starting. |
| `provisionDevice` and `linkDevice` | 867-941 | Port with changes. Decide admin status with `rpc('is_store_admin')` or `rpc('my_permissions').is_admin` (029:44-50, 81-89) instead of `myStaffRow`, which uses a username fallback and treats a null role as admin (852-864, 881). Keep the vendor-account refusal (871-872), the licence precheck (907-910), the takeover flag and the offline verifier for the setup admin (925). |
| `cloudMaxInvoice` | 830-842 | Port with changes. With a single writer the PC's counter is authoritative. Seed it at setup from the store's `invoice_counter.next_val`, or the maximum numeric `invoice_no` (012:105-150). The intake RPC should bump `invoice_counter` so a stray cloud checkout cannot reuse a PC number. |
| `pullStaffMember` (`ilike` username) | 1014-1029 | Port with changes. After `verifyOnline`, fetch by `users.id = authId` (main identity rule, A10). |

### 2.4 `web/src/lib/local/localAuth.ts` — **Port with changes**

Keep:
- The PBKDF2-SHA256 verifier: 150k iterations, 16-byte salt, constant-time compare (ref:localAuth.ts:21, 91-111, 114-140). It is never replicated or exported.
- A separate non-persisting verify client, so a staff sign-in never touches the sync session (145-161).
- Revoking the verifier when the cloud says "bad" (231-235).
- The admin "set offline password" action.
- `sessionAsAuthUser` (261-270). On main the staff `id` equals the auth id, so this lines up.

Change:
- `belongsTo` should be an id match only (187-189). Main guarantees `users.id = auth.uid()` (014:296-302, 015).
- Mirror 029's rules for who may sign in: `is_active` and a role in the same store (029:74-79).
- `localSignIn` checks online first, with a 6-second timeout (22, 166-184, 227). On a Wi-Fi link that is up but has no internet, every sign-in waits up to 6 seconds. That conflicts with "never Wi-Fi dependent".
  - Recommended: verify locally first when a verifier exists.
  - Then do the cloud check in the background, which also costs quota, so consider rate-limiting it.
  - Apply any revocation when the background answer comes back.
- Main's hooks call `supabase.auth.getUser()` directly (main:web/src/data/staff.ts:26-30, `resolveStaffUserId`). On the PC these must go through the seam that returns the local session.

### 2.5 `web/src/lib/local/backup.ts` — **Port with changes**

Keep:
- The format, version and store checks.
- Credentials are never exported (ref:backup.ts:59).
- Only photos the cloud does not have are exported (62).
- The same-device check and the older-than-last-sync warning (94-120).
- The rule that the invoice sequence never moves backwards (145-151).

Change:
- Bump the version and include the new stores.
- With idempotent event intake, the "drop outbox entries older than `lastSyncAt`" filter (139-142) can be relaxed. It was only needed because a stale row upsert undid newer edits.
- Consider an automatic daily local backup, for example through the File System Access API to a folder or USB stick. When quota or connectivity delays sync, the cloud copy can lag by days.

### 2.6 `web/src/lib/local/state.ts` — **Port with changes**

- Keep the in-memory meta with `useSyncExternalStore`.
- Add `pending` and `starts_at` to `CachedLicense` and `RANK` (7-16, 68). `RANK` has no `pending` today.
- Add a clock-rollback guard: store the highest `now` ever seen and use `max(Date.now(), highest)`. OFFLINE.md:145 admits the offline licence check trusts the PC clock.
- Cache the store row: time zone (`store_time_zone` 016:170) and `allow_negative_stock`. The offline Z-report and pricing need both.

### 2.7 `web/src/lib/local/boot.ts` — **Port with changes**

Keep:
- `navigator.storage.persist()` (ref:boot.ts:17-22).
- Remote-commit query invalidation (24-26).
- The device marker and starting sync (27-34).

Add: a check of the local schema version, so a failing local migration blocks with a clear screen.

### 2.8 `web/src/lib/local/uuid.ts` — **Port as-is**, or use `crypto.randomUUID()`.

### 2.9 Repository seam

- **`repository.ts` — Concept only.** The 60-method interface (ref:repository.ts:44-149) reflects 09d248c and has no void, refund, payments, Z-report, close shift, reports, lab queue, purchase items or receive, `my_permissions`, staff RPCs or customer balance and debtors.
  - Main's data layer is TanStack hooks calling `supabase` directly. Main's client uses these RPCs: `add_inventory_item`, `auth_store_id`, `close_shift`, `collect_sale_payment`, `create_sale_order`, `create_staff_role`, `customer_balance`, `customer_debtors`, `delete_purchase`, `delete_purchase_payment`, `is_platform_admin`, `lab_queue`, `my_license_state`, `my_permissions`, `next_invoice_no`, `platform_report_window`, `receive_purchase`, `refund_sale`, `replace_order_examinations`, `report_sales_window`, `report_top_customers`, `report_voided_count`, `schema_version`, `search_text`, `set_lab_status`, `set_license_window`, `set_role_permission`, `set_staff_access`, `set_user_permission`, `store_day_range`, `update_sale_order`, `void_sale`, `z_report`.
  - Main also still writes some tables directly: `stock_movements` insert (main:web/src/data/inventory.ts:200-230), notes, `sales` header update (sales.ts:1001, 1143), customers, suppliers and purchases.
  - Rebuild the interface from main's `data/*.ts`, one method per query or mutation function. The PC implementation reproduces each RPC's rules in TS.
  - For the phone build, main's hooks can stay unchanged.
- **`repositorySupabase.ts` — Drop.** It is an extraction of the old data layer. Main's hooks are the cloud implementation.
- **`repositoryLocal.ts` — Port with changes; most write paths need rewriting.**
  - Reusable patterns:
    - local emulation of filters, sorts, limits and unique checks (`assertSkuFree`, duplicate names);
    - `stamp()` for id and `store_id` (181-188);
    - the invoice reservation under `INVOICE_LOCK`, never handing out a number twice (368-386, 432-435);
    - the atomic multi-table commit.
  - Must be rewritten to follow main:
    - `createSale` must follow `create_sale_order` 029:246-408: catalog pricing from `price_cart` 013:259-337, line discounts, per-tender payment lines, `kind`, the actor being the signed-in staff member, and the idempotency key.
    - `updateSaleFull` must follow `update_sale_order` 029:410-562: refund permission when paid goes down, the photo-replace admin rule, and refusal when voided.
    - Add void (014:338-406), refund (028:96-169), collect payment (029:800-817), `set_lab_status` with the vocabulary check (029:748-756), the `guard_sale_access` column whitelist (029:774-796), and notes visibility and author rules (029:821-832).
    - Add the RBAC writes with their self-edit and admin-only rules (029:111-182), `receive_purchase` with weighted-average cost (029:589-675), and the purchase deletes.
    - Add the Z-report (023:112) and close shift (023:179-235), report windows (016) and the lab queue (019:117).
  - Performance: list queries load whole tables on every call. For example `getSalesPage` loads all sales, all customers and all users (291-331). That is fine at small sizes but degrades over years, so use indexes or cursors.
- **`repositoryReadOnly.ts` — Replace, keeping the concept.** A client-side Proxy blocks writes (ref:repositoryReadOnly.ts:8-63), but the branch's own docs say it is not enforced server-side (ref:OFFLINE.md:131-133). Main has no repository to wrap. Better options:
  1. The owner's phone login gets a non-admin position with only `*.view` codes. Main's restrictive action policies (029:210-240) and `require_perm` in every RPC then refuse writes. Admin and owner roles bypass `resolve_can` (029:62), so the owner's main account must not be the phone account.
  2. Add a server flag such as `stores.register_managed`. Ordinary write policies and RPCs then refuse writes for that store, so only the intake RPC can write. This also protects against a second writer, the one thing the design cannot merge (ref:OFFLINE.md:94-96).
  3. Optionally hide write controls when `VITE_READ_ONLY` is set. Main's UI already gates on `perms.can`.
- **`repositoryTypes.ts` — Drop, and derive from main.** Main's `CartLine` has `discount` and `discount_reason`, and `CreateSaleInput` has `payments`, `idempotencyKey` and `kind` (main:web/src/data/sales.ts:509-557).

### 2.10 `web/src/lib/auth.tsx` (ref) — **Port with changes**

- Keep the split between `LocalAuthProvider` and `CloudAuthProvider` (ref:auth.tsx:49-95), including the cross-window storage sync (69-79).
- Port `signOut({ scope: 'local' })` (ref:auth.tsx:139). Main signs out with the default global scope (main:web/src/lib/auth.tsx:61). If the phone and the PC ever share an account, signing out on the phone would kill the PC's sync session.
- **Drop** `ensureStaffRecord` (ref:auth.tsx:189-246). It inserts `users` rows from the client, auto-grants admin and adopts by username. Main revokes these writes (029:186) and uses only the id identity (A10).
- Keep main's `clearPosDraft()` and query-cache clearing on sign-out (main:auth.tsx:60-70).

### 2.11 New Sale draft: ref `wizardStore.ts` vs main `posDraft.ts`

**Replace by main's version, with one change.** Main's draft (main:web/src/lib/posDraft.ts:1-51) is namespaced by user and store and carries the idempotency key through `POSContext` (main:web/src/features/pos/POSContext.tsx:240-284). It uses sessionStorage (posDraft.ts:39), which does not survive closing the window or a power cut. The ref version used localStorage for exactly that reason (ref:web/src/features/pos/wizardStore.ts:1-33). On the PC build, store the draft in localStorage or IndexedDB.

### 2.12 `web/src/lib/storage.ts` (ref local image parts) — **Port with changes**

Keep:
- Queuing the image in IndexedDB under the final cloud path (ref:storage.ts:86-97).
- A local blob URL for offline viewing (27-43).
- The safe extension helper (108-113).

Change:
- `initLocalImages` creates object URLs for every stored image at boot (31-35). Make that lazy.
- `cacheCloudImage` downloads phone photos to the PC (119-137). That uses download quota, so cap it and do it on demand.
- Compression is the same as main: 1600 px, JPEG quality 0.82 (main:web/src/lib/storage.ts:26-42). For the quota, consider about 1280 px and quality about 0.7, and maybe WebP. Upload once (`upsert:false`, with "exists" treated as success, ref:sync.ts:443-451).
- Do not run main's storage orphan sweep (`storageCleanup.ts`, which lists the bucket) from the PC.

### 2.13 Phone-to-PC QR photo flow

- ref:QrDialog with `VITE_CLOUD_URL`, ref:MUploadPage `READ_ONLY` branch, ref:sync.ts `adoptPhoneImages`. Verdict: **concept only, needs a redesign for the quota.**
- The phone uploads on its own data, which is fine. Today the PC learns about the photo by listing storage every 2 minutes and then downloads it. See 2.3 for the inbox-table replacement, or drop QR on the PC and attach photos on the PC directly.

### 2.14 `web/src/lib/config.ts`, ref `vite.config.ts` flag check, ref `main.tsx` wrong-build guard — **Port as-is (concept)**

- Build flags `VITE_DATA_MODE` (`local` or `supabase`), `VITE_READ_ONLY` and `VITE_CLOUD_URL`, with misspelling refusal at build time and at runtime (ref:config.ts:16-54; ref:vite.config.ts:11-30).
- The device marker that refuses to run the cloud build at the register's address (ref:main.tsx:73-93).
- The local boot path (ref:main.tsx:94-107).
- On the PC, do not use main's `PersistQueryClientProvider` or the checkout replay (ref:main.tsx:15-30).
- PWA (both branches use `vite-plugin-pwa` with `registerType: 'autoUpdate'`, ref:vite.config.ts:42-72):
  - Every deploy is downloaded by the register. Consider prompt or manual updates on the register build, to control quota and avoid updating in the middle of a sale.
  - The register loads from a hosted URL and relies on the service-worker cache. If that cache is evicted, the POS cannot start offline. Consider serving the app shell locally.

### 2.15 `web/src/features/local/*.tsx` — **Port with changes**

- `SetupPage.tsx` (ref:1-129): keep the flow — sign in as admin, takeover checkbox, progress, language toggle. Add a download-size warning for the quota and the version handshake. Uses `provisionDevice` (2.3).
- `SyncStatus.tsx` (ref:16-258):
  - Keep the badge, the panel, admin-only skip buttons, the persisted-storage indicator (120-121) and `RelinkForm` (217-258).
  - Add data used this month, and use main's `perms.isAdmin`, which comes from `my_permissions` (main:permissions.tsx:76-80).
  - On the PC, `PermissionsProvider` must read locally. Main polls `my_permissions` every 15 seconds (permissions.tsx:68) and `current-user` every 15 seconds (staff.ts:24), about 11.5k requests per day. Those must not run on the shop link.
- `BackupPanel.tsx` (ref:9-114): keep export, import and restore with confirmations. Add a quota warning on "Restore from cloud".
- `LocalOfflineStrip` in ref `OfflineBanner.tsx`: port as-is. Main's `OfflineBanner` is about the checkout replay and should not show on the PC.
- The StaffPage offline-password button (ref StaffPage diff): port.

### 2.16 `main:web/src/lib/offlineMutations.ts` and the checkout replay

**Drop on the PC; it is superseded.**
- Keep the idempotency idea: one UUID per checkout attempt (offlineMutations.ts:13-20; 012:170-172). Every PC event should carry a stable id so that intake is idempotent.
- After cutover the phone is read-only, so the checkout replay in `queryClient.ts:26-33` loses its purpose.
- `DEFERRED.md:16` says "True offline-first … queue-and-replay covers the real need". The owner's requirement reverses that line, so update the doc.

### 2.17 `supabase/functions/create-user/index.ts` — **Replace by main's version**

- Main's version checks authorization as the caller: `auth_uid`, `auth_store_id`, `resolve_can`, `license_write_ok`, a seat limit, and `can_assign_role` (main:create-user/index.ts:61-108). It pins `store_id` (127-136).
- The ref version re-implements staff resolution with the 011 `auth_uid` and email rules (ref:create-user/index.ts:52-60 onward), which contradict 014.
- The PC calls it only when online, then writes the returned user into the local mirror and sets the offline verifier.

### 2.18 `web/OFFLINE.md` — **Port with changes**

The structure is useful: modes table, diagram, go-live checklist, test phases and known limits. Rewrite it for:
- event intake instead of row replication;
- the new migration numbers;
- the read-only phone enforced by the database;
- the quota budget.

### 2.19 `render.yaml` (three sites) — **Port with changes**

Sites: `lensy-web`, `lensy-register`, `lensy-phone`. After cutover, main's current site becomes the phone or read-only site. Decide whether the register is hosted at all (see 2.14).

---

## 3. Ref migration `011_multistore_hardening.sql` and `012_settings_per_store.sql` vs main

Both must be renumbered. Main already uses 011 (`011_sale_payments.sql`) and 012 (`012_integrity.sql`). The next free number is **030**, after `029_effective_permissions.sql`.

| 011 section | Ref lines | Main status | Single-store verdict |
|---|---|---|---|
| §1 Per-store uniqueness for `sales.invoice_no`, `inventory.sku`, `roles.name`, `lens_types`, `frame_types` and `frame_colors.name`, `settings.key`; blank SKU becomes null | 28-94 | Only roles are done (029:6-7, `roles_store_name_unique`). Still global on main: `invoice_no` (000:154), `sku` (000:109), `lens_types`, `frame_types`, `frame_colors` and `contact_lens_types` names (000:252-270), `settings.key` (000:280), and `users.username` (000:51, kept global on purpose by 014). | **Still needed**, because this Supabase project is multi-store: vendor licensing and platform reports (README.md:42, 147; 025). The register's invoice numbers and the `pc_last_sync`-style keys would collide with other stores, and `create_sale_order` already renumbers on a collision in any store (029:333-340). Port §1 except roles, and port 012 (settings) with it. Also change main's `settings.ts:31` `onConflict:'key'` to `'store_id,key'`. In a dedicated one-store project this is optional. |
| §2 `users.auth_uid` column, `auth_staff_id()`, username/email fallback, `auth_store_id()` through `auth_staff_id` | 96-134 | Contradicted. 014 removed the fallback (014:276-302). 015 re-pointed ids (015:39-118). 029 tightened `auth_store_id` (029:74-79). | **Drop.** It would reintroduce the impersonation hole 014 closed. |
| §3 RLS tenant policies wrapping functions in `(select …)` to evaluate once per query | 136-186 | Main's tenant policies come from 008 and later; 029 adds restrictive action policies with a bare `resolve_can` per row (029:210-240). | **Drop or optional.** With intake through a `SECURITY DEFINER` RPC, RLS cost is not on the hot path. Phone reads are small. Re-creating these policies risks clobbering 029's work. |
| §4 Store-scoped RBAC policies; read-only permission catalogue; seeding permission codes | 188-271 | Covered: RBAC tenant policies (014:186-262), read-only catalogue (014:264-279), and direct writes revoked with checked RPCs (029:186-205). Codes come from `supported_permissions()` (029:9-23). | **Drop.** |
| §5 `store_registers`, `claim_register(p_device, p_takeover)`, `register_is_current(p_device)` | 273-324 | Not on main. No `store_registers` or `claim_register` exists in `web/supabase/0*.sql`. | **Still needed — port with changes.** (a) Decide admin with `public.is_store_admin()` (029:44-50) and `auth.uid()`, not `auth_staff_id()` with a null role (011:296-303). (b) Check the licence with `license_write_ok`. (c) Add `last_sync_at`, `last_seq_ingested`, and a `register_epoch` or generation so a cloned PC or a restored old backup is refused after takeover. (d) The intake RPC must refuse unless `p_device` is the current register. (e) Grant execute to `authenticated` only. (f) Add `record_schema_version(30, …)`, following main's convention (029:839). |
| `012_settings_per_store.sql`: drop the global `UNIQUE(key)` on settings | 14-42 | Not on main (000:280 is still global). | Needed with §1 if multi-store. Ship it together with the client `onConflict` change; the ref's own ordering note is at 012:7-9. |

**New server pieces main lacks, needed by any rebuild** (not in the ref branch; listed so the designer sees the gap):

1. **An intake RPC** for the register's events, `SECURITY DEFINER`. It:
   - validates the device against `store_registers`;
   - checks `license_write_ok`, or holds as the ref's `licenseHold` does;
   - validates that each actor id is an active staff member of the same store;
   - is idempotent on event id;
   - writes rows with the PC's invoice numbers, timestamps and actors;
   - sets `lensy.money_write` (013:208-228) and an intake flag so `guard_sale_access` (029:774-793), `lab_status_stamp` (019:76-97) and `audit_row` (014:93-101) keep the PC's values or record the real actor;
   - bumps `invoice_counter` (012:105);
   - updates `store_registers.last_sync_at`;
   - returns a small piggyback: licence state, `staff_rev`, and whether the register is current.
2. **Optionally, a `register_managed` lock** on stores, so normal client writes are refused (2.9).
3. **If the designer prefers replaying main's RPCs instead of (1):** idempotency keys on `collect_sale_payment`, `refund_sale`, `void_sale`, `close_shift`, `set_lab_status`, `update_sale_order` and the others (A15). Those RPCs must also accept event time and actor (A4, A13) and stop renumbering invoices (A14). That is a larger change to main's audited RPCs than (1).

---

## 4. Bandwidth audit of the ref sync (limited monthly quota)

Costs while online and idle, with nothing to upload. Sizes are rough estimates.

| Source | Ref location | Frequency | Rough cost | Action |
|---|---|---|---|---|
| Storage list of 100 objects for phone-photo adoption | sync.ts:62, 580-589 | Every 2 min, 720 per day | About 40 KB of JSON per call before gzip; roughly 7–30 MB per day, which could reach hundreds of MB to about 1 GB per month | **Remove or replace** (2.3, 2.13). |
| Full `users` and `roles` download | sync.ts:61, 555-558, 991 | Every 10 min, 144 per day | Small per call, but grows with staff count and is pure waste | Replace with a delta or piggyback (2.3). |
| `my_license_state` RPC | sync.ts:60, 494-504 | Every 10 min, more often when not active | Small | Once per session, or piggyback. |
| `register_is_current` RPC | sync.ts:538-552 | Every 10 min, plus before every push | Small | Piggyback in the intake response. |
| Heartbeat upsert of `settings.pc_last_sync` | sync.ts:63, 625-629 | Every 5 min, 288 per day | Small, but each request carries about 1–2 KB of headers (JWT plus apikey) | Stamp it inside the intake call (2.3). |
| Token refresh (`autoRefreshToken`) | supabase-js default | About hourly | Small | Acceptable. Could lazily refresh only before a push. |
| Staff sign-in online check | localAuth.ts:166-184, 227 | Every sign-in | About 2–3 KB | Local-first (2.4). |
| PWA auto-update | ref:vite.config.ts:42-72 | Every deploy | The whole bundle | Prompt or manual update (2.14). |
| Main's own `my_permissions` and `current-user` polling | main:permissions.tsx:68; main:staff.ts:24 | Every 15 s each | About 11.5k requests per day | Must be local on the PC. |

Upload payload:
- Row upserts send full rows with repeated keys and UUIDs. Supabase-js upsert is `return=minimal`, which is good. Fetch request bodies are not compressed.
- An intake RPC taking a compact event batch per sync pass (header, lines, payments and exams of a sale, roughly 1.5–3 KB per sale) keeps volume near "number of events × about 2 KB".
- Photos dominate. At the current 1600 px and quality 0.82 they are about 200–400 KB each and are uploaded once. Reducing the size is the main lever.

---

## 5. What main has that the ref branch has no local equivalent for (build new on the PC)

The PC must have local equivalents so the shop works fully offline. Main's SQL and SQL tests in `web/supabase/tests/` are the specification and the test oracle for these TS ports:

- Payment ledger and split tenders (011); line discounts (013); `price_cart` and `allow_negative_stock` (013:259-337).
- Void with restock and compensating refunds (014:338-406).
- Partial refund per tender (028:96-169).
- Collect payment (029:800-817).
- Z-report and close shift (023:112-235), using the store time zone and `store_day_range` (016:170-199).
- Report windows, top customers, voided count (016), customer balance and debtors (`customerLedger.ts`).
- Lab queue and dwell stamps (019).
- Purchase receive with weighted-average cost (029:589-675).
- Effective permissions (`resolve_can`, `is_store_admin`, `my_permissions`, 029:44-89) and the checked staff admin rules (029:111-182).
- Licence window with `pending` (026); the version gate (017, 020).
- Global search (`search_text`, 016:264).
- Sale `kind` (022).

---

## 6. Decisions left to the designer

1. **How events reach the cloud.** Either (a) a new trusted intake RPC, where the server becomes a replica for this store, or (b) replaying main's existing RPCs, which needs idempotency keys, event time, actor and no renumbering across about 10 RPCs (A4, A13–A15).
2. **What authority the server keeps.** Server-side money validation becomes either "replica validation" (sanity checks only) or full re-pricing. Re-pricing can reject a valid offline sale because of later catalog changes or stock differences.
3. **Identity for sync.** Use a dedicated register login (non-human, admin-capable or intake-only), not a person's admin account. The ref pattern stores an admin session on the PC (ref:OFFLINE.md:134-136).
4. **Phone read-only.** Enforce it in the database with a view-only position and/or a `register_managed` lock, or accept the ref's app-only enforcement (2.9).
5. **One project per shop or multi-store.** This decides whether 011 §1 and 012 are required (section 3).
6. **QR phone photos.** Keep them with an inbox table, or drop them on the PC (2.13).
7. **Down-sync scope.** Licence, staff deactivation and vendor changes only, piggybacked on uploads. There is no periodic pull.
