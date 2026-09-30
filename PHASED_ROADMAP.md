# LensyPOS — Phased Hardening Roadmap

**Purpose:** turn a feature-complete POS into one that can be trusted with real money,
real stock and more than one store, without adding a single new screen first.

**Thesis:** today the **browser is the authority**. Postgres only enforces *which store
you belong to* and *whether your license is alive*. Every rule that protects money,
stock, invoice sequence and roles lives in TypeScript, which means a buggy client — or a
cashier with DevTools open — can break any of them. This roadmap is one theme executed in
order: **push every rule into Postgres, then let the app trust it.**

---

## 0. How to use this document

- Phases are **strictly ordered**. Phase 1 is a hard prerequisite for Phases 2, 4 and 6.
- Each phase is independently shippable — no "big bang" release.
- A phase is *done* only when its **Gate** passes, not when the code is written.
- Tick the checkbox per phase; add follow-up notes under it rather than editing history.
- Evidence links are `file:line` as of the audit. If a line moves, fix the reference — the
  defect list is the point, the line numbers are a convenience.

**Legend:** 🔴 loss/corruption risk · 🟠 wrong numbers at scale · 🟡 defect · 🔵 new capability

---

## 1. Current state (audit snapshot)

| Layer | What exists | Notes |
|---|---|---|
| Schema | `web/supabase/000…022_*.sql` — 23 migrations, flat files | applied by pasting into the Supabase SQL Editor (`SETUP.md`) |
| Tenancy & licensing | `008`, `009` + `lib/licensing.ts` | `store_id` on every table, `auth_store_id()`, read/write license gates via RLS |
| Checkout | `data/sales.ts`, RPC `002`→`011`, `features/pos/*` | atomic RPC **with a non-atomic client fallback** |
| Payments | `011`, `data/salesPayments.ts`, `lib/payments.ts` | ledger + sync trigger + split tenders — solid foundation |
| Screens | POS wizard, History, Lab, Inventory, Purchasing, Reports, Customers, Staff/RBAC, Notes, Platform, Mobile upload, Settings | all functional |
| Tests | **16 Vitest files, 163 tests, pure functions** — plus **11 pgTAP gates, 240 assertions**, which do touch Postgres | Vitest: `pricing`, `payments`, `receipt`, `posDraft`, `enterNav`, `types`, `permissions`, `sales`, `translations`, `schemaVersion`, `reportRpc`, `createUserAuthz`, `offlineMutations`. pgTAP: `012`–`022` |
| CI | `.github/workflows/ci.yml` — two jobs, green on every push | `web` runs `tsc -b`, `oxlint`, `vitest`, `build`; `db` applies 000–022 to a throwaway Postgres, runs `check-migrations-stamp.sh`, the pgTAP suite, and the schema-fingerprint drift check |

> **This table is an audit snapshot taken before any of the work below, and it is
> kept as written rather than quietly updated** — except where a row was so wrong it
> would mislead (CI, Tests, Schema). Phases 0–5 are all implemented; the ✅/❌ marks
> and the "none" entries above are the state *before* the roadmap was executed, which
> is what an audit is for. The current state is §11 and the phase notes.

### What is genuinely good (keep it)

- Tenant isolation via `store_id` + RLS is real Postgres enforcement, not a filter.
- The payment ledger (`011`) with a sync trigger that recomputes `sales.amount_paid` is the
  right design — header and ledger can never disagree.
- History paging is done correctly: `useInfiniteSales` (`web/src/data/sales.ts:103-119`)
  filters in Postgres and pulls 50 rows at a time.
- Invoice-conflict retry (`sales.ts:48-60, 298-455`) and the `isMissingFunction` graceful
  degradation for un-run migrations show real operational thinking.
- Lab status vocabulary is centralised (`sales.ts:647-659`) so badges and filters can't drift.

### The five defects that cause most of the rest

1. 🔴 **The checkout RPC trusts the client's money.**
   `create_sale_order` writes `unit_price`, `total_price`, `discount`, `net_amount`,
   `amount_paid` exactly as the browser sent them
   (`web/supabase/011_sale_payments.sql:197-207`). Nothing re-reads `inventory.sale_price`.
   A tampered or buggy client can sell a 5,000 EGP lens for 1 EGP, and no report will flag it.

2. 🔴 **Stock does not exist in the database.**
   `useInventory` fetches **every `stock_movements` row in the store** and sums it in JS
   (`web/src/data/inventory.ts:15-37`, the aggregation is `:24-34`). Consequences:
   the server *cannot* enforce availability at checkout, every inventory load gets slower
   forever, and `available_stock()` does not exist to be called.

3. 🔴 **Invoice numbers are generated in JavaScript.**
   `getNextInvoiceNo` (`web/src/data/sales.ts:180-250`) computes max+1 client-side, and on
   error falls back to `Date.now() % 1000000` (`:246-249`) — which can emit a duplicate or a
   meaningless invoice number rather than failing. It also uses `count(*)` as a seed
   (`:223-227`), which is wrong the moment any sale is deleted or a non-numeric invoice exists.

4. 🔴 **Sales can never be reversed.**
   There is no void, no refund, no return-with-restock anywhere in the codebase (no
   `useDeleteSale`, no reversal movement, no negative payment line — and `sale_payments`
   actively forbids them with `check (amount > 0)`, `011_sale_payments.sql:48`). A mis-keyed
   sale can only be re-checked-out; the money and stock of a wrong sale are permanent.

5. 🟠 **RBAC is a browser courtesy, and two tables are wide open.**
   Every permission gate is `perms.can(...)` in TSX (e.g. `routes/AppRouter.tsx:38`,
   `features/inventory/InventoryPage.tsx:218`); `resolveCan` lives in
   `web/src/data/permissions.tsx:64`. Meanwhile `008_multi_tenancy.sql:371-376` declares
   `permissions` a "GLOBAL catalog — readable/writable by any authenticated user"
   (`for all … using (true) with check (true)`), and `role_permissions` / `user_permissions`
   appear nowhere in `008`, so they still carry the Phase-2 policy
   `using (true) with check (true)` for all authenticated users
   (`web/supabase/001_security_rls.sql:69`). Worse, the `create-user` Edge Function runs
   with the service-role key and checks only that a JWT exists, so a cashier can mint an admin
   login directly (`supabase/functions/create-user/index.ts`). A cashier can grant themselves
   anything.

---

## 2. Threats this roadmap closes

| # | Threat today | Closed by |
|---|---|---|
| T1 | Client-supplied prices/totals are stored verbatim → under-selling, silent margin loss | Phase 1 |
| T2 | Overselling; two parallel checkouts both succeed; stock silently negative | Phase 1 |
| T3 | Duplicate / meaningless invoice numbers from the JS fallback | Phase 1 |
| T4 | Double-submit or dropped response creating two sales | Phase 1 |
| T5 | An irreversible sale (no void, refund, or return) | Phase 2 |
| T6 | A half-written order when a re-checkout fails mid-way | Phase 2 |
| T7 | A cashier granting themselves permissions | Phase 3 |
| T8 | Cross-store leakage if two stores have users with the same username | Phase 3 |
| T9 | Plan limits (`max_staff`, `features`) enforced only in the UI | Phase 3 |
| T10 | Reports that quietly stop counting once data grows | Phase 4 |
| T11 | "Today" meaning different things on different screens | Phase 4 |
| T12 | Search that can't find a name containing brackets, and can't use an index | Phase 4 |
| T13 | Live schema drifting from the migration files, invisibly | Phase 5 |
| T14 | Failures swallowed by `console.warn` that staff never see | Phase 5 |
| T15 | Orphaned prescription/frame photos accumulating forever | Phase 3/5 |
| T16 | Any signed-in user can mint an admin login via the `create-user` Edge Function | Phase 3 |
| T17 | A voided sale that cannot be expressed in the ledger (no negative tender, no restock) | Phase 2 |

---

## 3. Phase 0 — Safety net before changing anything · ~0.5 day

- [x] **Add CI**, which does not exist today (`.github` is absent). One workflow running the
  scripts already defined in `web/package.json`: `npm run lint` (oxlint) → `npx tsc -b` →
  `npm run test` (vitest) → `npm run build`, plus a second `db` job that applies
  `000…012` to a throwaway Postgres and runs the pgTAP gate.
- [x] **Commit a schema baseline**: a `pg_dump` of the live `public` schema stored in
  `web/supabase/baseline/`, so every later migration has a reference snapshot to diff against.
  *Status: **done** — captured by the `SUPABASE_DB_URL` secret +
  `.github/workflows/schema-baseline.yml` (run #36282916171), committed as
  `web/supabase/baseline/schema_after_012.sql` (3,336 lines: 32 tables, 12 top-level
  functions, 98 policies, 22 indexes; no keys or passwords in the file).* Why CI and not the
  local CLI: `supabase db dump` runs `pg_dump` inside a Docker container (Docker is not
  installed on the dev machine), and the direct host `db.<ref>.supabase.co` is IPv6-only,
  which GitHub-hosted runners cannot reach — so the dump runs on a runner through the IPv4
  **session pooler** (port `5432`) using the `postgres:18` client image.
  *Naming note: the file says **after_012**, not before, because `012` was already applied to
  the live project when it was captured — a "before" name would have been a quiet lie for the
  next diff. The dump doubles as the evidence that Phase 1 is live in production (see §4).*
- [x] **Reconcile the types file.** Decision: keep the hand-maintained
  `web/src/lib/database.types.ts` as the source of truth for now, and give it the drift
  protection CI can provide token-free — `web/src/lib/database.types.test.ts` lists the
  money-critical columns with `satisfies readonly (keyof T)[]`, so `tsc -b` (the CI step)
  fails the moment one disappears. Generating types from the *live* DB as the enforced
  truth would bless today's drift in the wrong direction; full regen-and-diff enforcement
  lands in Phase 5 once migrations live under the CLI root.

> **Gate:** CI is green on `main`, and the type file covers the `sale_payments` columns
> added by `011`. *Do not start Phase 1 without this* — Phase 1 changes both SQL and TS
> across several files, and CI is the only thing that catches a half-applied edit.

---

## 4. Phase 1 — Money and stock become true in the database · 2–3 days 🔴

Highest-value work in the repository. Everything later (ledger statements, day-close,
offline replay, line discounts) rests on a checkout the database vouches for.

**New migration: `web/supabase/012_integrity.sql`** — replaces `create_sale_order` with a
function that *validates and recomputes* instead of merely recording:

1. **Re-price and re-total server-side.** Read `inventory.sale_price` for each line, apply
   the discount rule, recompute `total_amount`, `discount`, `net_amount`. If the client's
   figure differs by more than ±0.01, `raise exception` rather than write — today
   `011_sale_payments.sql:197-207` records whatever the browser sent.
   `web/src/features/pos/pricing.ts` is demoted to a *preview*: the cashier sees the same
   number, it just stops being the number that wins.
2. **Guard stock inside the transaction.** New `available_stock(p_product uuid)` SQL
   function (sum of `stock_movements.qty` for the caller's store, index-backed). Lock the
   product row with `select … for update` and `raise exception 'insufficient stock'` on
   shortage. This fixes overselling, and it is only possible once stock exists in SQL.
3. **Give stock a home.** Add `inventory.stock_qty` as a **trigger-maintained read model**
   over `stock_movements` — the ledger stays the source of truth. `useInventory` can then
   drop its "download every movement" aggregation (`web/src/data/inventory.ts:24-34`), which
   today grows by one row per sold line, forever.

4. **Move the invoice sequence into the database.** `getNextInvoiceNo()`
   (`web/src/data/sales.ts:190-250`) is pure JS: it inspects the newest 100 invoices by
   number *and* by date, keeps the max in memory, and if that max is 0 seeds itself from
   `count(*)` (`:222-227`) — wrong the moment a sale is deleted or a non-numeric invoice
   exists. On any error it returns `String(Date.now() % 1000000)` (`:246-249`): a
   duplicate-looking or meaningless invoice number instead of a failure. Replace all of it
   with an `invoice_counter(store_id, prefix, next_val)` row updated by
   `insert … on conflict … returning next_val` **inside** the checkout transaction, so two
   registers can never draw the same number, and keep the RPC's conflict loop as a
   belt-and-braces. Delete the client function and the `PRESC-<base36 epoch>` invoice it
   bypasses (`sales.ts:717`).
5. **Idempotency.** The client sends `p_idempotency_key` (a UUID minted once per checkout,
   storable alongside the POS draft) and `sales` gets `unique (store_id, idempotency_key)`;
   on conflict the RPC returns the existing sale instead of creating a second one. This also
   makes Phase 6's offline replay safe to build later.
6. **Constraints that make illegal states unrepresentable** — added `not valid`, then
   `validate constraint`, so existing bad rows are *reported* rather than blocking the
   migration: `qty > 0`, `unit_price >= 0`, `total_price = qty * unit_price`,
   `0 <= discount <= total_amount`, `amount_paid >= 0`,
   `net_amount = total_amount - discount`.
7. **Close the legacy paths.** Keep the fallback client-side inserts
   (`web/src/data/sales.ts:386-445`) only while `012` is unapplied, and make the fallback
   *visible* when it is used — today it is silent, so a half-written order (header without
   items, or items without movements) looks like a success. Note also that the older
   `002_create_sale_rpc.sql` in the repo silently drops `rx_image_path` /
   `frame_image_path` (fixed in `011`): any store that stopped at 002 loses photos.

**Client changes:** `web/src/data/sales.ts`, `web/src/data/inventory.ts`,
`web/src/features/pos/pricing.ts`, the stock badge in `features/inventory`, and the cart
availability check in `features/pos/steps`.

> **Gate — pgTAP suite must prove:** tampered totals are rejected · oversell is rejected ·
> two concurrent checkouts draw two different invoice numbers · double-submit with the same
> key creates exactly one sale · `stock_qty` equals the sum of movements on a seeded
> dataset. *Money and stock stop being promises once these five tests exist.*

> **Status — implemented.** `web/supabase/012_integrity.sql` + the 26-assertion pgTAP gate
> (`web/supabase/tests/012_integrity_test.sql`, run by `npm run test:db` and CI job `db`)
> + the client switch are in. Deliberate deviations from the sketch above:
> - **Oversell follows the code's documented intent** (`POSContext`): new
>   `stores.allow_negative_stock` column, **default `true`** preserves today's behaviour;
>   set it `false` per store to enforce the guard. The gate proves BOTH states
>   (allowed + stock goes negative / refused with the product named).
> - **Invoice numbers are reserved at cart entry** via `next_invoice_no()` rather than
>   drawn only inside the checkout transaction, because the cart header, the mobile-upload
>   QR and pre-checkout photo adoption all use the number before Finish is pressed; the
>   counter's row lock plus the RPC's in-transaction draw (when no number is supplied)
>   keep the atomicity guarantee. Gaps from abandoned carts are accepted.
> - **The legacy JS numbering survives** behind `isMissingRpc('next_invoice_no')` until 012
>   is confirmed deployed everywhere — deprecated and warned, never silent (removed in
>   Phase 5 with the other fallbacks).
> - **Re-checkout (`useUpdateSaleFull`) still writes client-side** — it is not
>   server-validated yet; Phase 2's "header edits" item owns that.
> - **Red→green was demonstrated in CI itself** (runs #1–#5 red, run #6 green — there is no
>   Docker/psql on the dev machine, so CI is the only runner). The red states exposed three
>   *harness/test* gaps, never a flaw in `012`'s money logic: missing `USAGE` grants on the
>   `auth`/`storage` schemas for `authenticated`, then that grant being placed *before*
>   `create schema`, and finally the assertion form `f(...) IS NOT NULL` (PostgreSQL's
>   row-wise null test evaluates false for a composite function call here — replaced with a
>   field-based `is()`). With the auth grant fixed, 25/26 passed immediately — all six
>   rejection paths returned exactly the designed messages (`price changed: …`,
>   `invalid line quantity`, `payment exceeds net amount`, `unknown product in cart`,
>   `negative net amount`, `insufficient stock: …`); 26/26 followed with the assertion fix.
> - **Flip the switch:** `update public.stores set allow_negative_stock = false where id = '…';`
>   (a Platform-page toggle needs the stores write policy loosened — Phase 3 territory).

> **Status — APPLIED TO PRODUCTION ✅.** Confirmed empirically, not assumed: the live
> `pg_dump` in [`web/supabase/baseline/schema_after_012.sql`](./web/supabase/baseline/schema_after_012.sql)
> contains every 012 object — `available_stock()`, `next_invoice_no()`, `add_inventory_item()`,
> `sync_stock_qty()`; `inventory.stock_qty` + the `stock_qty_sync` trigger;
> `sales.idempotency_key`; the **5-argument** `create_sale_order(..., p_idempotency_key uuid)`;
> `stores.allow_negative_stock`; and all **seven** money constraints **validated** (zero
> `NOT VALID` remaining, so the guarded validate passed with no violating legacy rows). The
> same dump re-confirms what Phases 2–3 still own: **44** `lensy_tenant_delete` policies,
> `lensy_authenticated_all … USING (true)` on `permissions` / `role_permissions` /
> `user_permissions`, and `sale_payments_amount_check CHECK (amount > 0)` blocking refunds.
> Remaining: `allow_negative_stock` is still `true` on every store (overselling still
> allowed, by design) and the legacy JS invoice-number fallback is still reachable.

---

## 5. Phase 2 — A sale can be reversed, and no one can erase one · 2 days 🔴

**The sharpest finding in the audit:** `008_multi_tenancy.sql:332-339` creates
`lensy_tenant_delete` on all 20 store-scoped tables, and `011_sale_payments.sql:150-155` adds
the same for `sale_payments`. The rule is only *store + active license* — there is no role
check. So **any signed-in cashier can wipe the store's sales, sale items, stock movements or
payment ledger with a single `DELETE /rest/v1/sales` request.** No UI does this; the API
allows it.

- [x] **Revoke direct `delete` on every financial table** (`sales`, `sale_items`,
  `sale_payments`, `stock_movements`, `purchases`, `purchase_items`,
  `purchase_payments`) and keep deletes only through `security definer` functions.
- [x] **Add `void_sale(sale_id, reason)`** — sets `voided_at` / `voided_by` /
  `void_reason`, writes compensating `stock_movements` (`type = 'return'`), and leaves every
  original row in place. Voiding is an event, never an edit.
- [x] **Add refunds and returns.** Drop `check (amount > 0)` on `sale_payments`
  (`011_sale_payments.sql:48`) in favour of `amount <> 0` plus a `tender`/`kind` value that
  includes `refund`, so the ledger can express money going back. Offer "restock or not"
  explicitly at the till.
- [x] **Stop header edits from touching money.** `useUpdateSale` / `useUpdateSaleFull`
  (`web/src/data/sales.ts:662-700` and the full-order editor above it) send a
  `Partial<Sale>`, so they can rewrite `net_amount` and `amount_paid` directly and desync
  the header from the ledger that `sync_sale_amount_paid()` (`011:90-112`) works to keep
  honest. Either strip money columns from the patch or add a trigger that refuses header
  writes to them, and require payment changes to go through the ledger.
- [x] **Line-level discounts with a reason** (`sale_items.discount` + `discount_reason`),
  which needs nothing beyond a column, a rule in the RPC from Phase 1, and two fields in the
  cart step.
- [x] **`sale_payments.paid_at` as `timestamptz`, not `date`** — a day-only column cannot
  support shift/day close, and makes two payments on one indistinguishable.
- [x] **Give `stock_movements` a real vocabulary** (enum or FK to `movement_types`) instead
  of free-text, so a void, a purchase receipt, a transfer and a correction can be told apart.


> **Status — implemented, gate green.** `web/supabase/013_void_refunds.sql` (757 lines)
> + a 54-assertion pgTAP gate (`tests/013_void_refunds_test.sql`), both run by
> `npm run test:db` and the CI `db` job. Deliberate deviations from the sketch:
> - **The gate asserts behaviour, not `has_table_privilege`.** RLS, not grants, is
>   what denies a delete here, so the gate *performs* four deletes as
>   `authenticated` and asserts the rows survived, plus asserts the seven
>   `lensy_tenant_delete` policies are gone from `pg_policies`. A privilege
>   check would have passed while the policies still allowed the wipe.
> - **Revoking DELETE forced the re-checkout rewrite.** `useUpdateSaleFull`
>   deleted and reinserted `sale_items` / `stock_movements` / `sale_payments`
>   from the browser, so the gate could not be met without moving it into
>   `update_sale_order()` first — which is also the fix for T6. The client path
>   survives as the pre-013 fallback for unmigrated databases.
> - **The Suppliers screen had two real deletes too** (a purchase and a payment
>   row), so it got `delete_purchase()` / `delete_purchase_payment()` rather than
>   a special exemption. Reads and ordinary writes are untouched everywhere.
> - **`create_sale_order` was redefined** on a shared `price_cart()` core so
>   re-checkout is priced by exactly the checkout rules. Phase 1's 26-assertion
>   gate re-proves checkout after that refactor — it stayed green.
> - **The money guard uses a transaction-local GUC** (`lensy.money_write`) that
>   the checkout RPC, the re-checkout RPC and the ledger's own sync trigger raise
>   around their writes. SECURITY DEFINER alone would not have been enough:
>   `create_sale_order` is SECURITY INVOKER and must write the header itself.
> - **`void` is a new permission action**, separate from `delete` (which nobody
>   can exercise any more). A manager who may correct a mis-keyed invoice should
>   not thereby gain the power to erase history.
> - **Not done:** partial refunds on a *live* invoice (a full void refunds
>   everything; single-tender refunds belong with Phase 6's customer ledger),
>   and storage cleanup of `rx_image_path` / `frame_image_path` on void
>   (Phase 3/5).
> - **Gate status:** CI run #19 green — 013 applied cleanly, all 54 Phase 2
>   assertions pass, and Phase 1's 26 still pass after the refactor. Getting
>   there took four genuine test bugs (inverted "is refused" assertions, a
>   re-checkout aimed at an already-voided sale, a wrong sale count, and two
>   wrong pgTAP call forms — `like` does not exist, and `is(bigint, integer,
>   text)` does not resolve), each caught by the CI annotations rather than
>   guessed at.
> - **013 is NOT yet applied to production** — see `web/supabase/SETUP.md`
>   step 7, which also says to deploy the app in the same breath, because the
>   direct `DELETE`s the old client sent are gone.

---

## 6. Phase 3 — Authority leaves the browser · 2 days 🔴

Four separate holes, one theme.

1. 🔴 **The RBAC tables are world-readable and world-writable to all staff.**
   `008_multi_tenancy.sql:371-376` deliberately makes `permissions` a "GLOBAL catalog —
   readable/writable by any authenticated user" (`for all … using (true) with check (true)`),
   and `role_permissions` / `user_permissions` are not mentioned anywhere in `008`, so they keep
   the blanket policy from `001_security_rls.sql:69` — also `using (true) with check (true)` for
   `authenticated`. A cashier can read another store's role matrix and insert a row granting
   themselves `sales.delete`. Fix: make `permissions` a read-only catalogue for
   `authenticated` (writes only via platform admin), and give `role_permissions` /
   `user_permissions` policies that resolve the owning role/user through its `store_id` — they
   need a `store_id` column of their own, or a join-based policy.
2. 🔴 **`auth_store_id()` has a cross-store fallback.** `008_multi_tenancy.sql:176-183`
   falls back to matching `auth.users.username` against `users.username` when the JWT
   `sub` finds nothing. Usernames are not guaranteed unique across stores, so an account
   whose `user_id` is missing can resolve into *another store's* tenant — and every policy
   downstream trusts that answer. Fix: make `store_id` a claim on the JWT (or a
   `user_roles`-derived lookup that is unique by `auth_uid`), never a username match; make
   "no store resolved" a hard failure, not a guess.
3. 🟠 **Role checks exist only in TSX.** `resolveCan` (`web/src/data/permissions.tsx:64`) is
   the whole permission system, and `routes/AppRouter.tsx:38` is the only route gate — so the
   rules apply to buttons, not to data. Add `can(user uid, perm text) returns boolean` as a
   `security definer` SQL function and use it inside RLS policies on
   `users`/`roles`/`settings`/financial tables, plus a `require_perm()` call at the top of
   each privileged RPC. Keep the TSX checks for UX; they stop being enforcement.
4. 🔴 **The `create-user` Edge Function is an unmetered privilege escalation.**
   `supabase/functions/create-user/index.ts` runs with the **service-role key** (correct — that
   key must never reach the browser) but its only gate is a valid JWT: `supabase/config.toml`
   sets `verify_jwt = true`, and the handler then checks only that `username` exists and
   `password` is ≥ 6 characters. It then inserts into `public.users` with whatever `role_id` and
   `store_id` the caller sent. So **any signed-in cashier** can mint an admin login, or mint a
   user inside *another tenant's* store, and bypass every RLS policy afterwards through that
   account — including the plan's `max_staff` limit. Fix: inside the function, call the same
   `can()` / `require_perm()` from item 3, pin `store_id` to `auth_store_id()` unless the caller
   is `is_platform_admin()`, and enforce the staff quota in SQL so it cannot be raced.

Also in this phase:

- [x] Enforce plan limits (`max_staff`, `features`) inside the RPC that adds a user, not
  only in the Staff screen — `lib/licensing.ts` gates reads and writes, not quota.
- [ ] Give the platform-admin surface (`features/platform`, backed by `licensing.ts`) a
  service-role key instead of a logged-in staff token where it crosses tenants. *Not done: the
  surface reads licenses through RLS, which already scopes it to a platform admin, so
  the extra key is a defence-in-depth nicety rather than a hole - and a service-role
  key in a browser bundle is a far worse trade. Revisit if it ever needs to WRITE.
  across tenants.*
  service-role key instead of a logged-in staff token where it crosses tenants.
- [x] **Clean up orphaned storage objects:** a void now deletes the invoice's
  `rx_image_path` / `frame_image_path` (client-side, since SQL cannot reach the
  storage API). Replacing an image already did. Still open: photos orphaned by a
  half-failed checkout, and any pre-existing orphans - Phase 5.

> **Status - implemented, gate green.** `web/supabase/014_server_rbac.sql` + a
> 33-assertion pgTAP gate (`tests/014_server_rbac_test.sql`), both run by
> `npm run test:db` and the CI `db` job, plus 13 vitest cases over the
> create-user decision. Two findings changed the design, and both came from the
> gate rather than from review:
> - **T8 as written is impossible, and a worse variant is real.** The roadmap's
>   scenario - two stores both containing a user called `admin` - cannot occur:
>   `public.users.username` carries a global UNIQUE constraint
>   (`users_username_key`). The gate built that fixture and the database
>   refused it. But the `or username = split_part(email,'@',1)` fallback is
>   still impersonation: an auth identity with **no staff row of its own** whose
>   email local part happens to equal *someone else's* username inherited that
>   person's store, role, licence and data. My first fix (a 'username is unique
>   across stores' clause) could never fire, for the reason above - the gate said
>   so. The fallback is now **cut**, not hardened. Nothing depended on it:
>   `create-user` writes `public.users` with the auth identity's own UUID, and
>   Flet-era rows cannot sign in. The visible cost is an unlinked account now
>   getting a clear 'not linked to a store' screen, which ships in the same
>   commit.
> - **A detected mismatch also has to be REPAIRABLE, not merely visible.**
>   Cutting the fallback locked out a real account on the day it shipped, and
>   the cause was step 2 of `SETUP.md`: the admin staff row is created by hand
>   with its own uuid, while the person signs in through Supabase Auth with a
>   different one — the state the fallback had been hiding all along.
>   `015_link_staff_ids.sql` repairs that in both directions (a disagreeing row
>   is moved onto the login's id, six referencing columns with it; a login with
>   no staff row gets one at the real store, with no usable password, since one
>   cannot be recovered) and **refuses anything ambiguous** — a name two logins
>   could own is listed for a human instead of guessed at, because guessing is
>   how you hand somebody's sales history to the wrong person. Three real
>   defects surfaced while getting there, all caught by its 13-assertion gate:
>   the repair has to *swap* the row rather than re-point the key (`users.id` is
>   the primary key, none of the six constraints on it is `ON UPDATE CASCADE`,
>   and `ALTER TABLE` is refused inside a set-returning function), and a bare
>   `username` is ambiguous with the function's own `RETURNS TABLE` parameter.
> - **`014` had a genuine idempotency bug**, which matters because the operator
>   flow *is* "paste into the SQL Editor": four `create policy` statements had no
>   preceding `drop policy if exists`, so a second paste died with `42710 ...
>   already exists` — exactly the failure the re-runnability rule at the bottom
>   of this document exists to prevent. Fixed in the same commit as 015.
> - **The UI and the database deliberately disagree**, and G-X asserts it. The
>   provider grants *everything* to an account with no position (`openAccess`,
>   'never brick a login over bookkeeping'). `resolve_can` refuses. The
>   browser's job is to not lock someone out during a provisioning hiccup; the
>   database's job is to not trust an account nobody placed.
>
> Deliberate deviations:
> - **`resolve_can` is NOT wired into the ordinary READ policies.** Reads are
>   already tenant-scoped by RLS, and gating them on the permission matrix would
>   lock a whole shop out of History the moment one grant is mistyped.
>   Enforcement goes on privileged WRITES and inside the privileged RPCs; the
>   TSX gates remain as UX.
> - **The catalogue stays readable by everyone.** `permissions` is
>   `for select using (true)` and writes are platform-admin only. The Access
>   Control matrix has to render the code list; locking that out would break the
>   Staff screen for every user, not just the untrusted ones.
> - **The three RBAC tables have no `store_id` of their own** (004:24-39), so
>   their policies JOIN through `roles.store_id` / `users.store_id` instead
>   of pretending the column exists.
> - **`create-user` authorises as the CALLER.** A client built from the anon key
>   and the caller's JWT asks `resolve_can`/`auth_store_id`/`my_store_license`;
>   the service-role key is then used only to create the auth user, and the row
>   is written with the **pinned** store. It fails CLOSED - with 014 unapplied
>   every create is refused, naming the migration. The rules live in
>   `web/src/lib/createUserAuthz.ts` (pure, so `tsc -b` checks them and vitest
>   covers them) because the function has no live project to test against in CI;
>   `SETUP.md` step 9 carries the manual probe instead.
> - **`audit_log` was pulled forward from Phase 6.** A permission system nobody
>   can review is just a slower way to lose data, and this phase's own changes
>   should be reviewable.
> - **Not done:** the platform-admin surface keeps using a staff token (it only
>   READS, through RLS that already scopes it, and a service-role key in a
>   browser bundle is a worse trade than the nicety is worth); and
>   `features jsonb` plan flags are still UI-only - `max_staff` is now enforced
>   in the create-user decision, but the rest are not.
> - **014 is NOT yet applied to production** - see `web/supabase/SETUP.md`
>   step 9, which also says to redeploy the `create-user` function and to deploy
>   the app in the same sitting.

---

## 7. Phase 4 — Numbers that stay true at scale · 2 days 🟠

Not performance polish: each item is a screen that quietly stops being correct
as data grows — and, as it turned out, one of them was already wrong.

1. 🟠 **Reports aggregate in the browser over an unbounded fetch.**
   `useSalesSummary` selected *every* sale header in the store with no `range`
   or `limit`, then `ReportsPage.tsx` summed it in JS and sliced the top 5. Fine
   at a few thousand invoices; at 200k it is a multi-megabyte download and a
   stalled tab. Replaced by `report_sales_window` / `report_top_customers` /
   `report_payment_mix` / `report_voided_count` (`016_reporting.sql`), each
   returning a fixed-size payload.
2. 🔴 **Two different definitions of "today" in one app** — three, in fact.
   Reports used the **UTC** date (`new Date().toISOString().slice(0, 10)`);
   History used the store-local `localDate()`; and the cash-up panel filtered
   `paid_at` with a bare date string against a `timestamptz`, where
   `lte('2026-09-28')` means midnight at the **start** of that day — so every
   payment after midnight was dropped. A sale at 1:00 AM counted as yesterday
   on one screen and today on another. Now one `stores.time_zone` and
   `store_day_range()`.
3. 🟠 **Lexical comparisons against `timestamptz`.** Reports compared
   `order_date` with `startsWith` on `'YYYY-MM-DD'` strings, while History sent
   naive `${localDate()}T00:00:00` that Postgres read in the session timezone.
   Both now go through explicit timestamptz boundaries.
4. 🟠 **Zero-total "prescription sales" pollute revenue.** They write a sale
   with a `PRESC-<base36 epoch>` invoice and all-zero totals. Phase 1 removed
   the JS invoice numbering, so the second namespace is gone; `sales.kind` is
   still Phase 6 work.
5. 🟠 **Search destroys legitimate queries instead of escaping them.** `,()`
   were stripped from every term, so `Ahmed (Cairo)` silently matched nothing;
   and every field was `ilike '%term%'`, unindexable. Now `search_text(term)`
   over `pg_trgm` + GIN, so no filter string is assembled in the browser at all.
6. 🟡 **Index sweep.** Confirmed or added: `sales (store_id, order_date desc)`,
   `sales_live_idx` (partial, `where voided_at is null`),
   `sale_payments (sale_id, paid_at)`, `stock_movements (product_id)`, and
   `idx_trgm_*` on the five searchable columns.

> **Status — implemented; gates green.** `web/supabase/016_reporting.sql` + a
> 30-assertion pgTAP gate, plus the client switch. The money fix is a separate
> commit so it is not waiting on a migration paste.
> - **A live money bug, found by reading rather than by a failing test.**
>   Phase 2 made voiding possible, and `void_sale` deliberately leaves
>   `net_amount` intact so the audit trail reads true — but the Reports screen
>   summed that column and never selected `voided_at`. So **voiding a 5,000 EGP
>   invoice made the shop look 5,000 richer**, and `balanceDue` inflated with
>   it. The partial index written for exactly this in 013 — `sales_live_idx …
>   where voided_at is null`, with a comment saying *"Reports/History filter on
>   this"* — was never used. I wrote both halves. `computeReport` is now its own
>   tested module, and the exclusion is stated in the SQL too, so it is enforced
>   by the schema rather than remembered by whoever edits the screen next.
> - **Voids are reported, not hidden.** `voidedCount` / `voidedNet` surface a
>   line under the totals: excluding a void from revenue is correct, but
>   silently dropping it would let a mistaken void look like a quiet day.
> - **Red first, in the repo:** with the filter removed the gate reports
>   `expected 6000 to be 1000` and `expected 5000 not to be 5000`.
> - **Every expectation the gate corrected was mine, and the database was right
>   each time** — recorded because it is the opposite of what a test-first phase
>   usually looks like:
>   - `paid` came back 1600, not 1500: the 011 sync trigger recomputes
>     `amount_paid` from the ledger and overwrote my fixture, which now states
>     the value the trigger computes.
>   - `store_day_range` returned 21:00 UTC, not 22:00: **Africa/Cairo is EEST =
>     UTC+3 all year** (Egypt moved to a permanent UTC+3 in 2023). My +2
>     assumption came from pre-2023 Egypt and would have closed the shop an hour
>     late. Verified against the runner's tzdata.
>   - a lab counter saw two jobs, not one: `sales.lab_status` **defaults to
>     `'Not Started'`**, so an unrelated fixture had quietly become a lab job.
>   - a payment expected 70 came back −330: the −400 refund falls in the same
>     Cairo day. A refund belongs to the day the money went back — which is the
>     entire point of netting refunds in the cash-up.
>   - `like()` does not exist in pgTAP (the same trap Phase 2 hit), and `EXPLAIN`
>     is a statement rather than an expression, so the index assertion is
>     structural.
> - **The timezone is a column, not a client guess.** A tablet with the wrong
>   system clock, or a cashier abroad, must not move the shop's books. A
>   per-store `time_zone` key in `settings` overrides it, so moving a store is
>   one `UPDATE`.
> - **`search_text()` removes the sanitiser by removing the string it needed.**
>   G-S2 seeds an *identical* name in another store, because a search that leaks
>   tenants is worse than one that misses.
> - **Both client changes fall back** behind `isMissingRpc`, so an un-migrated
>   database keeps working — and the fallback keeps its old behaviour on
>   purpose, since a fallback that quietly reintroduces a bug is worse than none.
> - **Not done:** History's paging is still offset-based, so concurrent inserts
>   can shift rows between pages.
> - **The last client-side sub-totals are gone.** Reports used to compute its
>   "today" and "month" figures in the browser from the same rows it had already
>   fetched, which meant two definitions of the same number: one from the
>   database, one from `order_date.slice(0, 10)` in the browser's own zone — so
>   a 1am sale was credited to the day before. Both are now asked for
>   separately, with the store's own day bounds. That was the last item on the
>   "not done" list above, and it closed a defect rather than just a
>   limitation: the report functions take `timestamptz` bounds, and the app was
>   passing bare `'YYYY-MM-DD'` strings, which Postgres casts in the **session**
>   zone (UTC on Supabase). "Today" therefore began at 00:00 UTC = 03:00 in
>   Cairo, and everything sold in the first three hours fell outside its own day.
>   The bounds come from `store_day_range()` as half-open UTC instants now,
>   which removes the guess rather than adjusting for it.
> - **The end bound is EXCLUSIVE, and that is load-bearing.** A store-day bound
>   from `store_day_range` is the *next* local midnight, not the end of this
>   day, so the cash-up compares with `<`. Passing a bare date still means that
>   whole day and needs `<=` — the same two arguments meaning different things
>   is what made the panel come back empty. `usePaymentsRange` now takes the
>   convention as an argument, so the mistake is visible at the call site, and
>   the KPIs and the cash-up are handed the same bounds, so the two panels can
>   no longer disagree about which day they are describing.
> - **A defect the migration introduced, not one it exposed.** PostgREST wraps a
>   set-returning function in an array even when it returns exactly one row, so
>   reading fields off the result gave `undefined` — and
>   `Number(undefined ?? 0)` is `0`. Reports rendered a tidy, confident row of
>   zeros while Top Customers, the one call that used `.map()`, showed real
>   names. Nothing threw; the screen simply lied. `callReportRow` handles the
>   single-row shape once, and `reportRpc.test.ts` (11 tests) pins the
>   distinction in both directions, because TypeScript cannot tell
>   `returns table` from a composite return.

> **Gate:** the 016 gate covers the void exclusion, the store's own day
> boundaries, tenant isolation, refund netting, and the bracketed-name search.
> Two gate items are **not** covered and stay open: the <300 ms / <20 KB payload
> claim is asserted structurally (the partial index exists and its predicate is
> the void filter) rather than measured against a seeded 50k-row dataset — and
> `EXPLAIN` plan-shape on a three-row fixture would be false comfort — and
> History's offset→cursor paging.

## 8. Phase 5 — Making the schema trustworthy to change · 1–2 days 🟠

`web/supabase/000_base_schema.sql:14-17` openly states the live project has drifted from the
file, and `SETUP.md` is a hand-paste-into-the-SQL-Editor flow. So two "identical" installs
can differ, and nothing will ever notice.

- [x] **pgTAP** — *already done before this phase; recorded here because the box was stale.*
   `create extension pgtap`, gates under `web/supabase/tests/*_test.sql`, wired to
   `npm run test:db`, gated in CI on every push. `test-db.sh` globs both the migrations and the
   gates, so a new phase drops in a file and is picked up with no runner change. Six gates,
   ~169 assertions, no live project touched.
- [ ] **Fixtures.** A seeded store (one invoice per edge case: part-paid, voided, returned,
   zero-total prescription, multi-tender) so money tests are deterministic. — **Deferred.** Every
   gate already seeds exactly the rows it asserts on, inside a transaction that rolls back, so a
   shared fixture would mostly be a second thing to keep in sync. Revisit if a gate ever needs to
   assert against another's data.
- [x] **Make failures visible.** — `017_schema_version.sql` + `SchemaBanner` + the two money paths.
- [x] **Schema drift is now detected**, replacing "regenerate types in CI" — see the status note.

> **Status — implemented, except CLI migration tooling (deliberately deferred).**
>
> The root cause of the three silent fallbacks was that nothing in the system knew what version
> the database was, so the app could only *infer* drift from an error code — and inference fails
> quietly. `017_schema_version.sql` gives both sides a fact: the database records which migrations
> it absorbed, the app ships `EXPECTED_SCHEMA_VERSION`, and `SchemaBanner` names the version it
> found when they disagree. A pre-017 database reads as `unknown`, not `behind`, because that is
> the ordinary state of every shop that updates the app before the SQL — a false alarm would
> train people to ignore the one banner that matters. Gate: 13 assertions.
>
> **`getNextInvoiceNo` no longer invents a number.** The old catch-all returned
> `Date.now() % 1000000`: plausible, unique, and unrelated to the store's sequence. One dropped
> connection could write one against a real sale, and a duplicate-invoice report would have had
> nothing to point at. It now throws, keeping the original error as `cause`. The existing test
> asserted the *old* behaviour (`resolves.toMatch(/^\d{6}$/)`) and was rewritten to pin the new
> contract, since the test was the reason the bug looked intended.
>
> The non-atomic checkout fallback stays — removing it would refuse to sell to a shop that has not
> run 002 — but it now `console.error`s with context instead of degrading silently.
>
> **Two deviations from the plan above, both forced by facts found while doing it:**
> 1. **`supabase gen types` cannot run in this CI.** It needs a live project id + access token, or
>    `supabase db start` (the whole Supabase container stack); this repo's `db` job is a plain
>    `postgres:16` built by `test-db.sh`, and `gen types --db-url` against a non-Supabase server
>    requires Docker Desktop (supabase/cli#2536, closed as *not planned*). Rather than add a CI
>    step that could not run, drift is detected with `web/scripts/schema-fingerprint.sh`: a
>    `pg_dump --schema-only` hash of the whole public schema, compared against a recorded baseline
>    in CI. It needs only `psql`, covers every table rather than the subset TypeScript imports,
>    and cannot leak credentials. The baseline is recorded on the first run (it hashes a database
>    that only exists in CI), so that run reports rather than enforces.
> 2. **CLI migration tooling deferred.** `supabase db pull` writes *one* baseline snapshot and
>    discards the 17-file history, and it needs the database password. Detection was the actual
>    requirement — "nothing will ever notice" — and it is now met without a password and without
>    rewriting history. Adoption stays available as a separate, reversible step.
>
> **Not verified locally:** no Docker or Postgres on this machine, so the pgTAP gate and the
> fingerprint step are proven by CI only. The EDB installer is 403 behind this network, so a
> local Postgres was not an option either.
>
> **CI run #69: green, both jobs.** The gate, the fingerprint step and the web job all pass. Two
> rounds of real failures came out of this phase first, and both are worth keeping in mind:
>
> - **#67** — `has_function(..., '[]')`: pgTAP wants a real `text[]`, and a string is not one, so
>   psql aborted at line 39 before a single assertion ran. A latent twin sat in G-S10, where
>   `p_note` has a DEFAULT: the declared signature is `(integer, text)` but the identity is
>   `(integer)`, and `has_function_privilege` raises 42883 on a mismatch rather than returning
>   false. Both now resolve by OID from `pg_proc`, so there is no signature left to get wrong.
> - **#68** — G-S4 asserted an empty ledger, but 017 stamps version 17 as it *applies*, so the
>   gate was checking 0 against 17. And pgTAP has no `is(bigint, integer, unknown)` overload, so
>   `is(count(*), 1)` aborted the file at line 80. That trap is already documented in the 013
>   gate, which makes the repeat a fair process failure rather than a bad break.
>
> The lesson, recorded because it cost three pushes: **a gate that cannot run locally is only as
> good as its first CI run, and pgTAP's implicit typing punishes exactly the comparisons a
> migration gate is made of.** Cast every `count(*)`/catalog value, and resolve functions by OID.
>
> The awk fix in the same series earned its place immediately — under #67 the real one-line error
> sat below six phantom annotations; under #68 it was the first annotation.

> **Gate:** `npm run test:db` runs in CI ✅ · `SchemaBanner` warns only on an affirmative `behind`
> ✅ · no money path can invent a value ✅ · schema drift fails CI once a baseline is recorded ✅

> **The baseline attempt failed, and the reason is the most valuable thing in this phase.**
> Committing the hash from run #70 turned run #71 red — against a schema that had not changed by
> a single byte. The diff between the two runs touches no migration at all.
>
> Cause: since 17.6 and its backports, `pg_dump` brackets its output in
> `\restrict <random-token>` / `\unrestrict <random-token>` as a defence against psql
> meta-command injection (CVE-2025-1094 / CVE-2026-18408). **The token is regenerated on every
> invocation**, so hashing raw output yields a fresh digest for an identical schema. The check
> would have failed on every push forever, and the obvious human response to a permanently red
> build is to delete the check — which would have removed the drift detection this whole phase
> exists to provide.
>
> Two fixes, and the second matters more than the first:
> 1. the script now drops every backslash-prefixed line, so the token cannot reach the hash. The
>    spelling has already changed across versions, so it matches the shape rather than the token;
> 2. **the CI step now fingerprints twice and fails if the two disagree**, before it compares
>    anything to the baseline. A non-deterministic fingerprint is a broken *check*, not a drifted
>    *schema*, and the two demand opposite responses: one says "fix the script", the other says
>    "update the baseline". Run #71 could not make that distinction, and it is exactly the
>    distinction that stops the next person from overwriting a good baseline to make a red build
>    go green.
>
> The stale baseline was deleted rather than replaced, so the step is back in bootstrap mode and
> the next run reports a hash that is stable by construction. It must not be committed until a
> green run has shown `(stable across 2 runs)`.
>
> **Done — the check is enforcing.** Run #73 reported a stable hash across two invocations, and
> `web/supabase/schema.fingerprint` now holds it (`4e18d7c7…`). From the next push on, a migration
> that changes the schema shape fails the build until someone updates the file deliberately. Note
> that this value differs from the run #70 hash: that one hashed the random `\restrict` token, and
> this is the first hash of the schema alone.
>
> Getting the baseline in took one wrong turn worth recording. Run #71 failed, and the obvious
> response — "the value CI printed, therefore the value to commit" — was correct in principle and
> wrong in practice: the step's summary text was never visible to the person downloading, so the
> hash had to come from the artifact, and the two must agree. They did not, because the run that
> produced it predated the determinism fix. **A drift baseline should be copied from the step
> summary in the run that reported it, not from whichever artifact link is to hand** — a stale
> artifact is indistinguishable from a fresh one by its contents, since both are a bare 64-character
> hex string. The step summary now prints `stable across 2 runs` next to the value for exactly this
> reason, and the summary is the thing to trust.

---

## 9. Phase 6 — New capabilities that are now cheap 🔵 · 5–8 days

Nothing here is possible *safely* today, which is why it sits last. Once Phase 1–2 land, each
item is a small RPC plus a screen.

> **Re-scoped after reading the code, not just this table.** Three of the seven items were
> mis-filed: two were **defects wearing a feature's clothes**, and one was **already shipped**.
> The original order put new screens in front of a data-loss bug, so the order below is by
> risk, not by appeal.
>
> - [x] **Audit log** — **already done, in Phase 3.** `014_server_rbac.sql` has `audit_log` with
>   a trigger, RLS, three indexes and a gate assertion. The row was stale; deleting it rather
>   than re-implementing it.
> - [x] 🔴 **The offline banner was a false promise** — *not a capability, a defect*.
>   `OfflineBanner` told staff "Changes will sync when you reconnect" and there was **no write
>   queue anywhere** (zero matches for `setMutationDefaults` / `networkMode`). A sale rung up on
>   wifi was silently lost while the banner said it was safe — the same category as the
>   `Date.now()` invoice number Phase 5 removed. The copy now states the truth, and checkout is
>   genuinely queued (`lib/offlineMutations.ts`, `queryClient.ts:26`).
> - [x] 🔴 **Receiving a purchase did not add stock** — *not a capability, a data-loss bug, and
>   worse than recorded*. `useAddPurchase` wrote a `purchases` row and nothing else, and
>   `purchase_items` was **never written by the app at all** — a shipment was a bare total with
>   no products, so there was no line to receive and `stock_qty` never moved. Now
>   `receive_purchase()` (`018`), idempotent and row-locked, plus `received_at` so an
>   unreceived shipment is visible rather than merely unpaid.
> - [x] 🟠 **Customer ledger & statements** — `sale_payments` existed since 011 and nothing
>   aggregated it; the README claimed balances that did not exist. `customer_balance()` /
>   `customer_debtors()` (`018`), tenant-scoped as functions rather than views, because a report
>   nobody can scope eventually leaks.
> - [ ] **Day / shift close (Z report)** — now cheap: `paid_at` is a `timestamptz` (013), voids
>   net correctly (016), and 018's `customer_debtors` demonstrates the windowed aggregate.
> - [x] **Lab dwell time is measurable** — `019_lab_dwell.sql`. `lab_status` was a bare string
>   with no timestamp, so the Lab screen could colour a badge by status and could not say
>   which job was stuck. `lab_status_changed_at` / `lab_started_at` / `lab_ready_at`, all
>   maintained by a trigger, plus `lab_queue()` returning the wait per job. The two
>   "once-only" columns are the point: a re-opened job must not erase how long the lenses
>   took. Still open from the original item: **lab cost per lens into margin**.
> - [x] **History cursor paging** — now a `(order_date, id)` cursor rather than OFFSET, so a
>   sale rung up while the cashier reads page 2 no longer shifts rows and shows one invoice
>   twice while hiding another. The id tiebreak matters because sales can share a timestamp.
> - [ ] **Receipt share / thermal print** — `features/pos/receipt.ts` has tested formatting;
>   share-to-WhatsApp and an 80 mm stylesheet are additive.
> - [ ] **Consolidated multi-store reporting** — platform-admin view, now that store scoping
>   is trustworthy.

**Deliberately deferred:** true offline-first (conflict-merged) data model — queue-and-replay
covers the real need at 1/10 the cost; realtime two-register sync; Playwright end-to-end.

**Scope note on the queue.** Checkout is the *only* queued mutation, and that is a decision
rather than a default. Voiding, deleting a purchase and creating a user are choices made against
a view of the world that has since moved on; replaying them minutes later would apply them to a
state that no longer exists. Those keep failing loudly. Extending the queue is a per-mutation
judgement, never a blanket default.

> **Status — implemented. CI run #82 green, both jobs, every gate.** The offline queue, receiving
> and the customer ledger are all in, and all 19 of the 018 gate's assertions pass alongside
> 012–017.
>
> **Six CI runs to get 018 green, and the failures are the interesting part** — none of them was a
> bug in the migration, and five of six were readable in the existing gates:
>
> - **#75** — the fixtures omitted `purchase_items.store_id`, which 008 made `NOT NULL`. I had read
>   the DDL in `000_base_schema.sql` instead of checking whether a later migration added it. Same
>   class of error as Phase 5's `pronargs`: assuming a column from the file that is easiest to read.
> - **#76** — `license_write_ok()` refused the first receive, correctly. The gate had no licence.
>   The rival store is licensed too on purpose: unlicensed, G-P6 would have passed for the wrong
>   reason (refused for licence, not for tenancy).
> - **#77** — the worst one, and the most valuable. Every balance came back `NULL` and the
>   cross-store refusal never fired, because **the gate never impersonated anyone**.
>   `auth_store_id()` returns NULL with no JWT, `store_id = NULL` matches nothing, so the functions
>   found no customers — and G-P6 was about to pass for entirely the wrong reason, since the
>   purchase was never found rather than refused. **A gate can be green and mean nothing.** The
>   `set role` / `set_config` block is now the same fixture 013, 014 and 016 use.
> - **#78/#79** — `sale_payments.recorded_by` references **`auth.users`**, not `public.users`. I
>   seeded only the staff row, so there was no Auth identity for the FK. Naming `recorded_by` was
>   correct but insufficient; the fix was creating *both* rows, as every other gate does.
> - **#80** — the only failure that was a genuine arithmetic error, and **the database was right**:
>   the weighted average of 10@4 then 10@6 is 4.67, not the 5 I asserted. Fixing an expectation is
>   normally forbidden by this document's own rules, and it is legitimate here only because the
>   value is recomputable by hand from the fixture — which is the test of whether "the database says
>   so" is evidence.
> - **#81** — every gate green, and the **only** remaining failure was the schema fingerprint,
>   because 018 genuinely added `purchase_items.received_at` and three functions. The drift check
>   from Phase 5 catching a real change, four runs after catching three of my own mistakes.
>
> **CI run #87: green. 8 gates, 203 assertions, both jobs.** The offline queue, receiving, customer
> balances, lab dwell times and History cursor paging are all in, and every gate in the suite
> passes together.
>
> Getting 019 green took two runs and both were the same mistake, which is the single most
> expensive habit in this repository: **writing a fixture for a state the migration had already
> passed through.**
> - **#84** — `select is( (update … returning …), … )`: a data-modifying statement cannot sit inside
>   a sub-select. While fixing it I found G-L3 was not testing its own label — it said "an unrelated
>   update does NOT reset the clock" while the statement changed the status, so it asserted the same
>   thing as G-L2. It now writes the SAME status, which is the real test.
> - **#85** — the fixture row meant to be "a job Ready since 2026-09-01" arrived with all three
>   timestamps NULL, because **019's backfill runs once at migration time and the gate's rows are
>   inserted after it.** The trigger then correctly filled `lab_ready_at` on the way to 'Received',
>   and the assertion read that correct behaviour as a failure. The fixture now writes the stamps the
>   backfill would have produced. G-L5b was also comparing `lab_ready_at <> lab_status_changed_at`,
>   which passes whenever both are NULL; it now compares against the exact recorded value, with a
>   companion assertion that the *other* column did move.
>
> **#86** is the exception worth noting: every gate passed and the ONLY failure was the schema
> fingerprint, because 019 really did add four columns. That is the drift check working — the second
> time it has been right, and the first time it was not about my own mistake.
>
> **The backfill itself is not gated, and cannot be.** It only touches rows that existed before the
> migration, and a gate builds a fresh database, so there is nothing for it to act on. It is a data
> migration rather than behaviour, and `SETUP.md` step 15 gives the query that checks it on the live
> database. Declared in the gate file rather than left to be assumed.
>
> **Phase 6 · 020 — the drift check was itself the blind spot.** A shop applied 018 and 019, then
> asked why `schema_version()` still answered 17. It answered 17 because **018 and 019 never
> recorded their own versions** — 017 did, and I did not carry the habit forward. A shop with
> every migration applied and a shop that had stopped at 017 were indistinguishable, so the
> "your database is behind" banner could never fire. The one check built so a mismatch cannot
> pass unnoticed was the thing that was not noticing.
>
> **No test could have caught it**, which is the part worth recording: the 017 gate asserted
> `schema_version()` returns 17, and that was *true*. Every individual value was correct. It
> surfaced only because a human upgraded and asked a question no assertion was asking.
>
> The fix is two enforcement points rather than a convention:
> - `web/scripts/check-migrations-stamp.sh`, wired into `test-db.sh` as step 2 of 4, checks the
>   FILES. It runs before any migration is applied, so a missing stamp is a two-second failure
>   with a one-line message instead of a confusing version number afterwards. 018 and 019 are
>   grandfathered by name — the repository rule forbids editing an applied migration, and 020
>   backfills the ledger for both.
> - `assert_versions_recorded()` (020) checks the LEDGER against the applied migrations and
>   **raises** rather than returning false, because a gate that returns a boolean can be ignored
>   while an exception during a paste cannot.
> - `schemaVersion.test.ts` pins `EXPECTED_SCHEMA_VERSION` to the newest migration, so bumping
>   the constant is part of adding a migration.
>
> The guard was verified by making it fail: a temporary `021_temp_bad.sql` with no stamp was
> flagged with the exact line to add. And Git Bash turned out to be available, so the script was
> actually executed — which immediately caught a syntax error of my own in the failure message
> (a nested `'…'` inside a double-quoted `echo` truncated the quoting, and the shell tried to
> parse the rest as code). A syntax error in the error message is the worst possible place for
> one, and nothing but running it would have found it.
>
> **And the gate for that guard failed its first CI run (#89), for a reason worth keeping.** G-V3/G-V4
> prove the guard *fires* by naming 018/019 as the versions missing from the ledger — the exact
> defect 020 repairs. But 020 backfills those two rows, so by the time the gate runs they are
> recorded, the guard correctly has nothing to complain about, and `throws_ok` failed. The
> database was right and the expectation was wrong, for the third time in this phase. A guard test
> that names the very rows its own migration repairs is not testing the guard; it now names **021**,
> which genuinely has never been applied. The lesson generalises past pgTAP: *an assertion written
> alongside a fix tends to encode the pre-fix state it was mentally written against.* The gate also
> could not be run locally — there is still no psql on this machine — so this cost a push, which is
> exactly the cost the next section is about.
>
> **And the reason the SQL gates cost a push each: no local Postgres.** The EDB installer is 403
> behind this network and `embedded-postgres` ships every contrib extension *except pgTAP*, so the
> pgTAP suite cannot run here at all. Every failure above was readable in the existing gates — the
> impersonation block, the licence row, the `auth.users` half of a login, a `NOT NULL` column, a
> sub-select that cannot contain an UPDATE — and a local database would have caught all of them on
> the first attempt. **Solving that is the highest-value infrastructure left.**
>
> Git Bash *is* available at `C:\Program Files\Git\bin\bash.exe`, which is enough to run the
> shell-level checks locally. Worth remembering before concluding that nothing here can execute
> shell code — I assumed otherwise for several phases before looking properly.
>
> **CI run #94: green. 9 gates, 213 assertions, both jobs, fingerprint baseline matched.** Two more
> failures stood between #89 and green, and both were in the *expectation*, not the SQL:
>
> - **#92 — `throws_ok` compares messages by exact equality, not as a pattern.** G-V4 expected the
>   fragment `version\(s\) for: 021`. The guard was working: it raised `P0001` naming `021_e.sql`,
>   exactly as designed. pgTAP read the expectation as literal text, backslashes included, and
>   failed the assertion against a correct database. pgTAP exposes `throws_like` and
>   `throws_matching` as *separate* functions, which is the giveaway that `throws_ok` is `=` — and
>   unanchored regex is independently ruled out, because the old fragment would have matched as a
>   substring had it been one. The expectation now carries the whole message, two spaces after the
>   first placeholder included, checked byte-for-byte against the string CI reported as `caught`.
> - **#93 — the pgTAP gates went green and the *fingerprint* failed**, which is the drift check
>   doing its job: 020 creates `assert_versions_recorded(text[])`, so the schema genuinely moved and
>   `schema.fingerprint` had to move with it. The value came from CI, which hashes twice and
>   refuses to compare unless the two agree — a digest of this schema, not a number copied on
>   trust. Updating a baseline after a real schema change is the intended flow; the check says to
>   review the diff first, and the diff was one new function.
>
> The shape of this phase is worth naming: **every failure from #89 to #93 was a wrong test
> expectation, and each was reported by the gate that caught it.** The gates were not the obstacle
> — they were the only reason progress was visible, given that none of this can run on this
> machine. The remaining cost is the push-per-failure loop, and its fix is still a local Postgres
> with pgTAP.
> ---
>
> **Phase 6 · 021 — the first platform admin could not be created at all.** A real account was
> lost to a lost password, and repairing it exposed a locked table with no key. `platform_admins`
> is the one table whose contents bypass every other policy, so locking it was right — but 008
> seeded it *during migration time*, a few lines above the statement that enables RLS, and that
> window closed the moment the migration finished. Afterwards the SQL Editor, the Table Editor and
> `CREATE POLICY` each refused, and the only route that worked was holding the service-role key:
> a master key, for a routine administrative task.
>
> `bootstrap_platform_admin(email)` (021) opens that door **once**. It refuses while any platform
> admin exists, so a leaked handle is worth nothing after setup, and `execute` is revoked from
> `anon`/`authenticated` entirely. Ten assertions; the security half is proving the refusal.
>
> **Runs #99–#102 cost four failures, and every one of them was mine — the database was right
> each time.** They are recorded because two of them are new failure shapes this repository had
> not seen before:
> - **#99, the gate that never made the call it was testing.** The 021 gate checked
>   `platform_admins` *after* the argument checks and assumed the happy path had happened, so
>   G4–G9 all failed against a function that worked perfectly. A gate that never runs its subject
>   is not a weak gate; it is a wrong one, and no amount of green-then-red would have caught it.
> - **#99, a sentinel that stopped being a sentinel.** 020's guard test named `021_e.sql` as "a
>   version never applied" — and then 021 was applied, in this same phase. The guard correctly
>   declined to raise about a migration that had recorded itself. That gate has now been wrong
>   here **twice** the same way (018/019 before it), and the fix is not "pick a higher number":
>   the sentinel is `099`, far outside any range a POS will reach, because a guard test naming a
>   version the project might plausibly ship is a test with an expiry date.
> - **#100, `psql exited 3` with no failing assertion.** G-V6b read `'guard'\''s'` — a backslash
>   before a quote, which closes the string early and leaves a syntax error. It came from an
>   editor call that **timed out mid-write**, and I committed the result without re-reading the
>   line. A tool that fails halfway is not a tool that failed; it is a tool that needs re-reading.
> - **#99, the `NOT NULL` trap, again.** `008` makes `users.store_id` `NOT NULL`, so a vendor —
>   who belongs to no shop — cannot be given a staff row *at all* (23502). The 021 function was
>   written assuming it could. Same trap as run #75 over `purchase_items.store_id`: check the
>   DDL, not the file that is easiest to read.
>
> **A dead path, found while fixing the login, and it is worse than a smell.**
> `ensureStaffRecord` (`auth.tsx:119`) inserts a `public.users` row from the browser on first
> sign-in. That insert is refused twice over — RLS requires a store or platform admin, *and*
> `store_id` is `NOT NULL` — and a bare `catch {}` hides it. **No account has ever been created
> that way.** Add Staff works because it goes through the service-role Edge Function. The
> function's own comment claims it creates a row; it cannot.
>
> **A race, and the worst kind: intermittent, sticky, and it locked a real admin out of the
> till.** `useMyLicense` / `useStoreId` / `useIsPlatformAdmin` fire on mount, and React runs hooks
> *before* `AppShell`'s `if (loading)` early return — so the request raced the async session
> restore and sometimes went out as `anon`. `auth_store_id()` is NULL for anon, so
> `my_license_state()` returned **zero rows**, which the app read as a confident "this account is
> not linked to a store". Two of the three use `staleTime: Infinity`, so a wrong anon answer was
> **persisted to localStorage for 24 hours** and survived every reload until sign-out. The
> database was perfect throughout; the client asked on behalf of nobody and believed the answer.
> Fixed by gating all three on a real session (`licensing.ts`), and `/platform` no longer renders
> "Platform access only" while the answer is still in flight — absence of an answer is not a
> verdict, which is the same conflation the licence screen was making.
>
> **Two consequences worth carrying.** The `superadmin` username bypass (`permissions.tsx:52`,
> `014:155`) is **unreachable**: it reads `public.users.username`, and by the `NOT NULL` above no
> vendor can have a staff row. It is vestigial, not a second door — `is_platform_admin()` already
> grants the same bypass in `resolve_can`. Removing it properly means a new migration, because
> 014 is applied and this document forbids editing an applied file. And `021` forces two
> knock-ons: `EXPECTED_SCHEMA_VERSION` 20 → 21, and 020's G-V6b relaxed from `equals 20` to
> `at least 20` — a hardcoded version inside a migration gate goes stale on every migration, so
> the half of that invariant that *moves* is pinned in `schemaVersion.test.ts`, where it belongs.
>
> **CI run #102: green. 10 gates, 223 assertions, both jobs, fingerprint baseline matched.**
>
> **The two documents were silently destroyed, and nobody noticed for five phases.** Both
> `PHASED_ROADMAP.md` (6827 characters) and `README.md` were damaged by PowerShell read/write
> round-trips, and README ended up containing a **NUL byte** — which is why git rendered it as
> `Bin` and no one could review a diff on it. Repaired with `ftfy`. Recorded here because the
> obvious fix is the dangerous one: "iterate cp1252 until there is no mojibake" converges on
> **deletion**, not correctness — it turns an em-dash into `U+FFFD` and then removes it, while
> still reporting zero mojibake. The naive version would have passed the obvious check and
> destroyed the document. Verified instead by byte-comparing 1014 of 1078 roadmap lines against
> the last known-good historical revision.
>
> **Phase 6 · 022 — the last open Phase-4 money item turned out not to be about money, and
> reading the code was cheaper than fixing it.** The audit filed "standalone prescriptions
> create zero-total sales" as 🟠 under Phase 4. It is not a money defect at all: 016's
> `report_sales_window` sums `net_amount`, so a zero-total row contributes 0 to revenue, and
> the `PRESC-` invoice namespace it referenced was already gone in Phase 1. What was actually
> wrong is narrower and duller — `order_count` was `count(*)`, so "Orders today: 12" counted
> prescriptions nobody paid for, and each one consumed an invoice number from the shared
> counter, leaving gaps that read like lost business.
>
> **Over-scoping this would have been the expensive mistake.** The obvious fix — exclude the
> row everywhere it appears — would have understated the lab queue, because a prescription is a
> genuine job waiting to be made. 022 excludes it from exactly one number, and the gate proves
> both halves: the prescription is gone from `order_count` (G-K8) and still counted as pending
> lab (G-K9), with revenue and paid unmoved (G-K10). Those three assertions are the fix; the
> other fourteen are about not breaking the other nine gates.
>
> **`kind` is whitelisted in SQL rather than trusted, and the second half matters more than the
> first.** `create_sale_order` exists because it does not trust the browser — it re-prices the
> cart and re-totals the header — and `jsonb_populate_record` would have copied a client-sent
> `kind` of anything. So the RPC re-derives it. Validating only against a whitelist would still
> have been exploitable in the direction that matters: claim `prescription` on a *real* order and
> it drops out of the count, hiding a sale. Requiring a cart worth *nothing* is what closes
> that (G-K7), and a check constraint means the property survives a future edit to the function
> (G-K11) — a security property living only in application code is one refactor from gone.
>
> **Runs #104–#106, and the middle one is the most valuable thing in this section — because it
> was not a mistake in the new code. It was a mistake in how the new code was written.**
>
> - **#104 — `syntax error at end of input`.** The migration had been assembled with three
>   `insert_line` edits whose line numbers went stale as earlier inserts grew the file, so the
>   chunks interleaved and the report function landed inside the checkout function's body. My
>   pre-commit check was *"are the quote counts balanced"* — and they were. **The file was
>   structurally wrong while every count matched.** Rebuilt by appending strictly at EOF.
> - **#105 — an old gate caught a regression in code the new gate does not test.**
>   `013`'s gate went red: `G7b the line discount is stored on the item | have 0.00 | want 100`.
>   022 had redefined `create_sale_order` from **012's** body — but 013 redefined it onto the
>   shared `price_cart()` core to add line-level discounts, refund tenders and a per-line
>   `paid_at`. So 022 silently reverted a shipped Phase 2 feature.
>
>   The 022 gate was green on the very rows that were mispriced, because it does not test line
>   discounts. **This is the entire argument for running every gate on every change**, and it is
>   the one thing a new gate can never do for itself.
>
>   The cause was a check that was right against the wrong file. I diffed the new function
>   against 012 and reported "only the four intended differences" — true, and irrelevant, because
>   **013 is the live definition**. Redone against 013, the diff is exactly `v_kind`, the
>   whitelist block, and `kind` in the header insert. *When re-declaring a function that later
>   migrations have already redefined, diff against the last migration that touched it, not the
>   one you remember.* Two migrations redefine `create_sale_order` (012 and 013); I read the
>   wrong one.
>
> - **#105 also — the same interleaving hit the gate**: assertions out of order, no
>   `finish()`/`rollback()` at the end, and a literal written `'''sale''::text` where six quote
>   characters were needed — a *syntax* error rather than a failed assertion, so it aborted the
>   file outright. Now `quote_literal()`, so the escaping is the database's problem.
>
> **What I would do differently, having made this mistake twice in one sitting:** verify
> *structure*, not totals. Both failures passed a count check — quote parity, then "the diff is
> only my four lines". The checks that would have caught them are cheap: section markers in
> ascending order, `plan(n)` re-derived from the assertions rather than remembered, `finish()`
> before `rollback()`, and a diff against the file that *currently* defines the function.
>
> - **#106–#110 — the same lesson four more times, and then a fixture bug that was mine.**
>   #106 `control reached end of function without RETURN` (the splice ate `return v_sale;`);
>   #107 an unclosed `$$` body in the gate plus a stray `end $$;` after `rollback;`;
>   #108 `is(information_schema.character_data, …) does not exist` — the Phase 5 trap again, a
>   domain compared without a cast, reported as though an extension were missing; #109 G-K2
>   comparing information_schema's *rendering* of the default (`'sale'::text`, cast suffix and
>   all) against a hand-built string. Five failures in a row, every one of them a **shape the
>   expectation takes rather than a shape the thing under test has.** Not one assertion was
>   wrong about the migration.
>   #109 also exposed a fixture bug worth keeping: switching the gate to its **own** store
>   meant creating one, which meant **licensing** it — `create_sale_order` is SECURITY INVOKER,
>   so its `sales` insert goes through RLS and 008:452 gates that on `license_write_ok()`.
>   Unlicensed, every checkout would have been refused and G-K4 would have been asserting that a
>   refusal is a success. That is run #76's failure mode wearing new clothes, and the only
>   reason I caught it is that I checked the policy instead of assuming a report function's
>   licence-blindness carried over to the write path.
>
> **CI run #110: all 11 gates green** — 022's 18 assertions, and 012–021's 231 unchanged. The
> only failure was the schema fingerprint, which is the drift check doing precisely its job:
> 022 really did add a column, a constraint and two function bodies. Baseline re-recorded from
> the **step summary** after reviewing that the diff was exactly those four objects and nothing
> else — the value was not taken from the artifact, per the rule that stale artifacts are
> indistinguishable from fresh ones.
>
> **Phase 6 · 023 — the day/shift close, and the property the whole thing rests on.**
> A shop's daily question is not "what did I sell"; Reports answers that. It is
> "how much should be in the drawer, and is it". `z_report()` answers the first
> half live, and `close_shift()` records the second as an append-only row in
> `shift_closes` — so "was the drawer right last Tuesday?" is answerable months
> later, which is the only reason to keep the table.
>
> **The one design decision worth reading twice: a void is NOT filtered out of the
> cash figures, and must not be.** `void_sale` writes a compensating *negative*
> payment on the same tender, so the money cancels itself inside the sum. That is
> the right shape for a drawer — a voided invoice leaves the drawer exactly as
> empty as the sale left it full — and it is why `z_report` has no `voided_at is
> null` filter where 016's revenue function has one. G-Z3 pins it, and the
> comment on that assertion says the useful thing: a future edit that "fixed" a
> wrong number by excluding voided sales **would still pass G-Z3** while quietly
> swapping the mechanism underneath. The filter would be a different, and wrong,
> answer to the same number.
>
> **`expected_cash` is stored, not recomputed.** A later re-price must not rewrite
> what the drawer was supposed to hold on Tuesday. That single choice is the
> difference between an audit trail and a live query, and it is why `shift_closes`
> keeps the figures as they stood rather than joining back to the ledger.
>
> **Permission: `reports.edit`, deliberately an existing code.** Reading the live
> report needs no permission beyond tenancy, because Phase 3 decided that
> `resolve_can` is not wired into ordinary reads — gating them on the permission
> matrix locks a shop out of their own numbers over one mistyped grant. *Closing*
> is a privileged write and calls `require_perm`. Inventing a `reports.close`
> would have shipped a permission **no role holds**, and the feature would be dead
> until somebody granted it by hand: 021's trap, reached from a new direction.
>
> Gate: 21 assertions. **G-Z12b is the one that matters most** — it asserts the
> refusal wrote *no row*, because a gate that proves only that a refusal
> *happened* passes just as happily against a function that raises and then
> inserts anyway. 013 made the same argument when it chose to perform deletes
> rather than assert `has_table_privilege`.
>
> **#112 — the version-gate trap, for the third time, and I walked into it with
> the roadmap's own warning in view.** 023's gate passed all 21 assertions on its
> first run; the only failure was 022's G-K13, `have: 23, want: 22`, because it
> asserted 022 was the **newest** migration. 020's G-V6b had already been relaxed
> from `= 20` to `>= 20` for precisely this, and §9 says in as many words that *a
> hardcoded version inside a migration gate goes stale on every migration*. Read
> it, then wrote `= 22`.
>
>   Both gates now assert **at least**, which is the half that survives: that the
>   migration recorded *itself*. "022 is the newest" is true today and false the
>   moment anyone writes 024, and it is already pinned in
>   `schemaVersion.test.ts` — which is where a value that moves belongs, once,
>   rather than in every gate that happens to be reading it.
>
> **#113: green, 12 gates.** The fingerprint was re-baselined after reviewing the
> diff: one table, one index, one policy, two functions, and three grant
> statements — exactly what 023 declares.



---

## 10. Deliberately deferred (tracked, not forgotten)

Deferred on purpose, with the trigger that should bring each one back:

| Deferred | Why | Revisit when |
|---|---|---|
| Replacing the `users` table with Supabase Auth identities | Large blast radius; tenancy already works on top of it | After Phase 3 locks store resolution |
| Realtime sync between two open registers | Needs Phase 1 idempotency to avoid double-writes | Two stores ask for it |
| True offline-first (conflict-merged) data model | Queue-and-replay covers the real need at 1/10 the cost | Offline is a paid feature |
| Upgrading the toolchain (React 19.2 / Vite 8.1 / TS ~6.0 / vitest 5 / oxlint) | Hygiene, not value — never mix with a money phase | Standalone PR after Phase 0 |
| Playwright end-to-end suite | Slow to build, thin value until the DB is authoritative | After Phase 2 |
| Image de-duplication by hash | Needs a storage listing pass; orphan cleanup (Phase 3) is the urgent half | Storage costs show it |
| PDF invoice archiving | Nice-to-have; receipt print comes first | A customer asks for e-invoices |
| Multi-currency, VAT engine, e-invoicing | Real requirements in Egypt, but they change the money model | After the money model is server-owned |
| SSR / framework migration | No user-visible gain | Never, unless it removes a real defect |

---

## 11. Testing strategy (the actual deliverable of every phase)

**This section as originally written said the repository had 9 Vitest files, all pure functions,
and that "none of them touches Postgres, so nothing in the database has ever been tested."** That
was true in the audit and stopped being true in Phase 1. The sentence survives as the reason the
pgTAP suite exists; what it must not do is imply the gap is still open. The database is now
covered by 11 gates and 240 assertions — and it is the layer where every money defect in this
document lived, which is the whole argument of the roadmap.

The audit's original inventory: `data/permissions`, `data/sales`, `features/pos/{enterNav,
pricing,receipt,types}`, `i18n/translations`, `lib/{payments,posDraft}`. Added since:
`lib/schemaVersion`, `data/reportRpc`, `lib/createUserAuthz`, `lib/offlineMutations`.

| Layer | Tool | Covers | Status |
|---|---|---|---|
| Pure logic | Vitest (`npm run test`) | pricing, receipt text, payment split maths, draft shape, report-RPC shape | ✅ 16 files, 163 tests |
| **Database** | **pgTAP** (`npm run test:db`) | re-priced totals, stock guard, invoice uniqueness, idempotency, constraints, voids, refunds, RBAC, receiving, customer balances, lab dwell, the version ledger, `sales.kind` | ✅ 11 gates, 240 assertions, CI `db` job |
| **Authorisation** | pgTAP, impersonating a real cashier JWT via `set role` + `set_config` | RLS matrix per role × table, denied deletes, denied cross-store reads, denied admin minting, denied reads of another store's closes | ✅ Phase 2/3 — `013` (54), `014` (33), `015` (13) |
| Migration safety | `scripts/check-migrations-stamp.sh` (files) + `assert_versions_recorded()` (ledger) + a `pg_dump` fingerprint in CI | an unstamped migration is a red build; a schema that drifts from the repo fails the build | ✅ Phase 5/6 — the fingerprint baseline is recorded and enforcing |
| Query cost | structural assertions (the partial index exists, its predicate is the void filter) | no seq scans on the hot paths | ◐ Phase 4 — asserted structurally, **not** measured against a 50k-row dataset |
| UI smoke | Vitest + testing-library | checkout wizard renders, void dialog | optional |

**Rules for this roadmap:**
1. A phase is not closed until its gate test exists and fails before the fix, passes after.
2. Every gate test is written *first*, against the unpatched database, so the defect is
   demonstrated rather than described.
3. Never weaken a gate to make it green; if a gate is wrong, fix the gate in a separate commit
   and say why.
4. Keep migration operational steps in `web/supabase/SETUP.md` — this document lists *what*
   must be true, `SETUP.md` says *how* to apply it. Do not duplicate order-of-application or
   env-var instructions here.

---

## 12. Effort and sequencing

| Phase | Theme | Days | Gate that must pass |
|---|---|---:|---|
| 0 | Safety net (CI, baseline, types) | 0.5 | CI green; type file matches `011` |
| 1 | Money + stock true in the DB | 2–3 | 5 pgTAP gates (price, stock, sequence, idempotency, ledger) |
| 2 | Reversible sales, undeletable ledger | 2 | void works end-to-end; `delete` revoked on 7 tables |
| 3 | Authority leaves the browser | 2 | cashier JWT fails every privileged probe, incl. minting an admin |
| 4 | Numbers that stay true at scale | 2 | <300 ms reports, one definition of "today", indexed search |
| 5 | Schema trustworthy to change | 1–2 | `test:db` in CI; live == repo |
| 6 | New capabilities | 5–8 | per feature |
| | **Phases 0–5 total** | **≈9.5–11.5 days** | |

**Recommended order if time is short:** 0 → 1 → 3 → 2 → 4 → 5.
Phase 3 is cheap relative to its risk and is pulled forward when a second store is onboarding,
because cross-store resolution and the open RBAC tables are the two things that make a second
tenant unsafe.

**Migration discipline for every phase** (as practised in `008`/`011`): additive first, then
backfill, then switch reads, then tighten constraints `not valid` → `validate constraint`;
every migration idempotent (`create or replace`, `drop policy if exists`), tenant-safe
(backfills set `store_id` explicitly), and re-runnable after a half-applied paste.

---

## Appendix A — Per-feature defect backlog

Every row is a finding from the audit with its evidence. Phase column = where it gets fixed.

| Feature | Defect | Evidence | Phase |
|---|---|---|---|
| POS · Checkout | Prices/totals persisted exactly as the browser sent them | `011_sale_payments.sql:197-207` | 1 |
| POS · Checkout | Stock availability never checked in the database (oversell possible) | `data/inventory.ts:24-34` | 1 |
| POS · Checkout | ~~Invoice number generated in JS; on error returns `Date.now() % 1000000`~~ **fixed in Phase 5** — the invented number is gone, the path now throws | `data/sales.ts` (`getNextInvoiceNo`) | 1 |
| POS · Checkout | ~~When the RPC is missing, a silent non-atomic multi-table fallback runs~~ **Phase 5** — the fallback still exists (removing it would block sales) but `console.error`s with context, and `SchemaBanner` names the cause | `data/sales.ts` (createSaleOrder), `components/SchemaBanner.tsx` | 1 |
| POS · Checkout | Legacy 3-arg RPC drops `rx_image_path` / `frame_image_path` | `002_create_sale_rpc.sql` | 1 |
| POS · Checkout | No idempotency key — a retry after a lost response can create a second sale | `data/sales.ts:298-455` | 1 |
| POS · Checkout | A sale can never be voided, refunded or returned | `011_sale_payments.sql:48` (`check amount > 0`), no `void_*` RPC | 2 |
| POS · Checkout | Order-editor patch can rewrite `net_amount` / `amount_paid`, bypassing the ledger | `data/sales.ts:662-700` (`:691`) | 2 |
| POS · Checkout | No line-level discount (order-level only) | `sale_items` columns | 2 |
| POS · Checkout | Payment timestamp is a `date`, not a `timestamptz` | `sale_payments` DDL in `011` | 2 |
| POS · Checkout | ~~Standalone prescriptions create zero-total sales with a `PRESC-<epoch36>` invoice~~ **Phase 6 / 022** — the invoice namespace is gone (012), and `sales.kind` now marks the row so it is not counted as a billable order. *Corrected on review: revenue was never wrong* (016 sums `net_amount`, so a zero row adds 0). The real damage was `order_count` being `count(*)` — "orders today" counted prescriptions nobody paid for — and an invoice number consumed by non-sales | `data/sales.ts:1159` (`useAddStandalonePrescription`); gate: `tests/022_sales_kind_test.sql` (17 assertions) | 4→6 |
| History | Paging is correct (server-filtered, 50/page) but offset-based, so concurrent inserts can shift rows between pages | `data/sales.ts:103-119` | 4 |
| History | Range filter sends naive `${localDate()}T00:00:00` strings | `data/sales.ts:118-119` | 4 |
| Inventory | Stock is a browser-side sum of **all** movement rows | `data/inventory.ts:15-37` | 1 |
| Inventory | Product insert + its opening stock movement are two separate writes | `data/inventory.ts` `useAddProduct` | 1 |
| Inventory | Stock adjustments carry no reason code, approval or audit trail | `data/inventory.ts` `useAdjustStock` | 2 |
| Reports | Whole sales table (headers) downloaded, then summed in JS | `data/sales.ts:67-82` + `reports/ReportsPage.tsx:27` | 4 |
| Reports | "Today"/"month" computed in **UTC** while History uses local time; duplicated in two components | `reports/ReportsPage.tsx:19-20`, `:116-117` vs `data/sales.ts:84-87` | 4 |
| Reports | Top-5 / low-stock lists are sliced client-side *after* the full download | `reports/ReportsPage.tsx:47`, `:155` | 4 |
| Customers | No balance / statement view — `sale_payments` exists but is never aggregated per customer | `data/salesPayments.ts` | 6 |
| Customers | Doctor-name search needs two queries merged in the browser | `data/customers.ts:74-95` | 4 |
| Search | Sanitizer replaces `,()` with spaces, so bracketed queries silently return nothing; all matches are `ilike '%…%'` (unindexable) | `data/search.ts:14`, `:23`, `:29`; `data/customers.ts:68` | 4 |
| Staff / RBAC | Permission model is TSX-only (`resolveCan`); one route gate | `data/permissions.tsx:64`, `routes/AppRouter.tsx:38` | 3 |
| Staff / RBAC | `permissions` made a global catalogue (`for all … using (true)`); `role_permissions` / `user_permissions` absent from `008` → keep the blanket policy | `008_multi_tenancy.sql:371-376`; `001_security_rls.sql:69` | 3 |
| Staff / RBAC | `create-user` Edge Function holds the service-role key but checks only "has a JWT" → any cashier can mint an admin login, in any store | `supabase/functions/create-user/index.ts`, `supabase/config.toml` | 3 |
| Staff / RBAC | Plan limits (`max_staff`, features) enforced only in the UI | Staff screen vs `lib/licensing.ts` | 3 |
| Staff / RBAC | No audit log of who changed what | schema-wide | 6 |
| Tenancy | `auth_store_id()` falls back to matching `username` across stores | `008_multi_tenancy.sql:176-183` | 3 |
| Tenancy | Any authenticated staff member may `DELETE` from 21 store tables | `008_multi_tenancy.sql:332-339`, `011:150-155` | 2 |
| Lab | Status is free text with no per-status timestamps, so dwell time is unmeasurable | `data/sales.ts:647-659` | 6 |
| Purchasing | Receiving does not create stock movements; supplier balance is not computable | `003_purchase_payments.sql`, purchasing screen | 6 |
| Uploads | Replaced/voided prescription & frame images are never deleted | `007_order_images.sql`, `lib/storage.ts` | 3/5 |
| Offline | The banner promises "Changes will sync when you reconnect", but there is no write queue — a checkout made while offline is lost, and a blind retry can double-book it | `components/OfflineBanner.tsx:17` vs `lib/queryClient.ts:19-20` | 6 |
| Process | ~~Live schema has drifted from `000_base_schema.sql` (stated in its own header)~~ **Phase 5** — drift is now *detected*: `schema_version()` in the DB, a banner in the app, and a `pg_dump` fingerprint compared in CI | `017_schema_version.sql`, `lib/schemaVersion.ts`, `scripts/schema-fingerprint.sh` | 5 |
| Process | ~~No CI, no SQL/RPC/RLS tests; `database.types.ts` is hand-maintained while `gen:types:reference` has never been run~~ **Phase 0/1 + 5** — CI runs the pgTAP gates; the unusable `gen:types` script is replaced by a schema fingerprint that needs no credentials | `.github/workflows/ci.yml` | 0/5 |

---

## Appendix B — Migration chain (applied, and planned)

Application order and the manual steps live in `web/supabase/SETUP.md`; this table is only a
map of what each file is responsible for, so a review can tell which phase owns which file.

| File | Responsibility | Note for this roadmap |
|---|---|---|
| `000_base_schema.sql` | Base tables (customers, sales, sale_items, order_examinations, prescriptions, inventory, stock_movements, suppliers, purchases/purchase_items, warehouses, lens/frame metadata, settings) | Header (`:14-17`) admits the live DB has drifted — Phase 5 |
| `001_security_rls.sql` | Roles + one blanket `lensy_authenticated_all` policy, `using (true)` (`:64-71`) | Still in force for every table `008` omits — Phase 3 |
| `002_create_sale_rpc.sql` | First atomic checkout RPC (3-arg) | Superseded by `011`; silently drops order images — Phase 1 |
| `003_purchase_payments.sql` | `purchase_payments` ledger per shipment, one-off backfill of legacy `amount_paid` (`:29-32`), blanket `lensy_authenticated_all` (`:42-43`) | Receiving→stock work lands later (Phase 6) |
| `004_rbac_notes.sql` | `permissions`, `role_permissions`, `user_permissions`, notes + role seeds | The three tables Phase 3 must bring under tenant RLS |
| `005_notes_edit.sql`, `006_note_seen.sql` | Note editing and per-user "seen" state | Healthy; no phase owns them |
| `007_order_images.sql` | `rx_image_path`, `frame_image_path` on `sales` | Orphan cleanup — Phase 3/5 |
| `008_multi_tenancy.sql` | `stores`, `store_id` everywhere, `auth_store_id()` (`:176-183`), RLS v2 loop (`:287-340`) | Fallback bug + table-list gap + delete policy — Phases 2/3 |
| `009_store_licensing.sql` | Licenses/plans, `license_read_ok()`, `license_write_ok()`, `is_platform_admin()` | Good design; quota enforcement still missing — Phase 3 |
| `010_metadata_sort.sql` | Re-numbers lens/frame metadata by name (`:18`, `:26`) | Cosmetic |
| `011_sale_payments.sql` | Payment ledger (`:48` positivity check), store-id trigger (`:88`), `sync_sale_amount_paid()` (`:90-112`), RLS (`:118-155`), 4-arg `create_sale_order` (`:164-248`) | The RPC Phase 1 rewrites from "record" to "validate" |
| `012_integrity.sql` | Server re-pricing, stock guard (`stores.allow_negative_stock`, default allow), `available_stock()`, `stock_qty` read model, `invoice_counter` / `next_invoice_no()`, idempotency key, money constraints | Implemented — gate: `tests/012_integrity_test.sql`. **Applied to production** (proven by `baseline/schema_after_012.sql`) |
| `013_void_refunds.sql` | `void_sale()`, refund tenders, movement vocabulary, `paid_at` → `timestamptz`, delete revocation, `update_sale_order()` | Implemented — gate: `tests/013_void_refunds_test.sql` (54 assertions) |
| **`014_server_rbac.sql`** | `resolve_can()` / `require_perm()`, tenant RLS on the three RBAC tables, store resolution without the username fallback, `audit_log` | Implemented - gate: `tests/014_server_rbac_test.sql` (33 assertions) | `can()` / `require_perm()`, tenant RLS on the three RBAC tables, store resolution without username fallback | Phase 3 |
| `015_link_staff_ids.sql` | `link_staff_ids()` — moves a disagreeing staff row onto its login (both directions), refuses ambiguous names, `staff_id_problems` view | Implemented — gate: `tests/015_link_staff_ids_test.sql` (13 assertions) |
| `016_reporting.sql` | Report RPCs (`report_sales_window` / `report_top_customers` / `report_payment_mix` / `report_voided_count`), `stores.time_zone` + `store_day_range()`, `search_text()` + `pg_trgm`/GIN | Implemented — gate: `tests/016_reporting_test.sql` (30 assertions) |
| `supabase/config.toml` *(repo root)* | CLI project root; `verify_jwt = true` for `create-user` | Split from the SQL in `web/supabase/` — adopting the CLI migrations is deferred to a separate PR |
| `017_schema_version.sql` | `schema_version()` + the `lensy_schema_versions` ledger (RLS on, no direct read) | Implemented — gate: `tests/017_schema_version_test.sql` (14 assertions) |
| `web/scripts/schema-fingerprint.sh` | `pg_dump --schema-only` hash of the public schema, compared in CI | Phase 5 drift check — replaces `supabase gen types`, which cannot run without a live project or the Supabase container stack |
| `018_purchase_stock.sql` | `receive_purchase()` (idempotent, row-locked, weighted-average cost) + `customer_balance()` / `customer_debtors()`, and `purchase_items.received_at` | Phase 6 — fixes a recorded purchase never moving stock, and the missing answer to "what does this customer owe?" |
| `019_lab_dwell.sql` | `lab_status_changed_at` / `lab_started_at` / `lab_ready_at` (trigger-maintained; the last two written ONCE) + `lab_queue()` | Phase 6 - makes "how long has this job been waiting?" answerable at all |
| `020_version_gate.sql` | Backfills the ledger for 018/019, adds `assert_versions_recorded()` (raises, not returns false), and `scripts/check-migrations-stamp.sh` makes an unstamped migration a red build | Phase 6 - the drift check was the blind spot: 018/019 shipped without recording themselves, so a fully-migrated shop was indistinguishable from a shop stuck at 017 |
| `022_sales_kind.sql` | `sales.kind` ('sale' \| 'prescription', NOT NULL defaulting to 'sale', constrained) + a re-derivation of the kind inside `create_sale_order`, and `order_count` narrowed to `kind = 'sale'` | Phase 6 — the last open Phase-4 item, and **not** the money bug the audit recorded: revenue was always right, because a zero-total row adds 0. `order_count` was `count(*)` |
| `supabase/functions/create-user/index.ts` | Creates an Auth user + mirrors it into `public.users` using the service-role key | JWT-only gate, caller-supplied `role_id`/`store_id` — Phase 3 |
| `web/supabase/tests/_shim.sql`, `tests/012_integrity_test.sql` | Plain-Postgres shims (roles, `auth/`, `storage/`, pgTAP) + the Phase 1 gate (26 assertions) | Run by `npm run test:db` and CI job `db` — no live project touched |
| `web/supabase/baseline/schema_after_012.sql` | Live `pg_dump --schema-only` of `public`, captured in CI | The **after-012** reference snapshot (012 was already applied when captured) — the diff base for `013`+. Supersedes the drifting `000_base_schema.sql`; Phase 5 turns the drift check into a job |

**Migration rules that apply to every one of these:**

- Never edit an already-applied file — forward-fix in the next number, so a store that ran the
  old version and a fresh install converge on the same schema.
- Every file must be safely re-runnable (the hand-paste flow means half-applied pastes happen).
- Money-touching migrations ship with their pgTAP file in the same commit.
- Constraints go in `not valid` first, backfill, then `validate constraint` — never block a
  live checkout on a cleanup.
- When Phase 5 moves these files into a real migrations directory (the CLI root is the repo
  root, so `supabase/migrations/`), keep the numbers and record the mapping, so history stays
  readable and `SETUP.md` can be rewritten in one pass.

---

**If you only do one thing from this document:** do Phase 1. Everything else in the repository
is a screen; Phase 1 is the difference between a POS whose numbers you can defend and one whose
numbers you hope are right.








