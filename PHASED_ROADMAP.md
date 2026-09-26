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
| Schema | `web/supabase/000…011_*.sql` — 12 migrations, flat files | applied by pasting into the Supabase SQL Editor (`SETUP.md`) |
| Tenancy & licensing | `008`, `009` + `lib/licensing.ts` | `store_id` on every table, `auth_store_id()`, read/write license gates via RLS |
| Checkout | `data/sales.ts`, RPC `002`→`011`, `features/pos/*` | atomic RPC **with a non-atomic client fallback** |
| Payments | `011`, `data/salesPayments.ts`, `lib/payments.ts` | ledger + sync trigger + split tenders — solid foundation |
| Screens | POS wizard, History, Lab, Inventory, Purchasing, Reports, Customers, Staff/RBAC, Notes, Platform, Mobile upload, Settings | all functional |
| Tests | 9 Vitest files, **pure functions only** | `pricing`, `payments`, `receipt`, `posDraft`, `enterNav`, `types`, `permissions`, `sales`, `translations` |
| CI | **none** — there is no `.github` directory | nothing runs `tsc`, `oxlint`, or `vitest` automatically |

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

- [ ] **Add CI**, which does not exist today (`.github` is absent). One workflow running the
  scripts already defined in `web/package.json`: `npm run lint` (oxlint) → `npx tsc -b` →
  `npm run test` (vitest) → `npm run build`.
- [ ] **Commit a schema baseline**: a `pg_dump` of the live project stored in the ops notes,
  so every later migration has a "before" picture to diff against.
- [ ] **Reconcile the types file.** The app imports the hand-maintained
  `web/src/lib/database.types.ts`, while `package.json` carries a generator command
  (`gen:types:reference`) that writes a separate reference file. Decide one: generate into
  `database.types.ts` and delete the hand-written one, or keep it and add a CI step that
  regenerates and diffs. As things stand, a schema change produces no type error, so drift
  is invisible.

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

---

## 5. Phase 2 — A sale can be reversed, and no one can erase one · 2 days 🔴

**The sharpest finding in the audit:** `008_multi_tenancy.sql:332-339` creates
`lensy_tenant_delete` on all 20 store-scoped tables, and `011_sale_payments.sql:150-155` adds
the same for `sale_payments`. The rule is only *store + active license* — there is no role
check. So **any signed-in cashier can wipe the store's sales, sale items, stock movements or
payment ledger with a single `DELETE /rest/v1/sales` request.** No UI does this; the API
allows it.

- [ ] **Revoke direct `delete` on every financial table** (`sales`, `sale_items`,
  `sale_payments`, `stock_movements`, `purchases`, `purchase_items`,
  `purchase_payments`) and keep deletes only through `security definer` functions.
- [ ] **Add `void_sale(sale_id, reason)`** — sets `voided_at` / `voided_by` /
  `void_reason`, writes compensating `stock_movements` (`type = 'return'`), and leaves every
  original row in place. Voiding is an event, never an edit.
- [ ] **Add refunds and returns.** Drop `check (amount > 0)` on `sale_payments`
  (`011_sale_payments.sql:48`) in favour of `amount <> 0` plus a `tender`/`kind` value that
  includes `refund`, so the ledger can express money going back. Offer "restock or not"
  explicitly at the till.
- [ ] **Stop header edits from touching money.** `useUpdateSale` / `useUpdateSaleFull`
  (`web/src/data/sales.ts:662-700` and the full-order editor above it) send a
  `Partial<Sale>`, so they can rewrite `net_amount` and `amount_paid` directly and desync
  the header from the ledger that `sync_sale_amount_paid()` (`011:90-112`) works to keep
  honest. Either strip money columns from the patch or add a trigger that refuses header
  writes to them, and require payment changes to go through the ledger.
- [ ] **Line-level discounts with a reason** (`sale_items.discount` + `discount_reason`),
  which needs nothing beyond a column, a rule in the RPC from Phase 1, and two fields in the
  cart step.
- [ ] **`sale_payments.paid_at` as `timestamptz`, not `date`** — a day-only column cannot
  support shift/day close, and makes two payments on one indistinguishable.
- [ ] **Give `stock_movements` a real vocabulary** (enum or FK to `movement_types`) instead
  of free-text, so a void, a purchase receipt, a transfer and a correction can be told apart.

> **Gate:** an intentional mis-keyed sale can be voided from the UI in ≤3 taps; stock and
> the customer ledger return to the pre-sale values; `delete` from `authenticated` is denied
> on all seven financial tables (pgTAP assertion on `has_table_privilege`); nothing is lost
> from the audit trail.

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

- [ ] Enforce plan limits (`max_staff`, `features`) inside the RPC that adds a user, not
  only in the Staff screen — `lib/licensing.ts` gates reads and writes, not quota.
- [ ] Give the platform-admin surface (`features/platform`, backed by `licensing.ts`) a
  service-role key instead of a logged-in staff token where it crosses tenants.
- [ ] Clean up orphaned storage objects: `rx_image_path` / `frame_image_path`
  (`007_order_images.sql`, `lib/storage.ts`) are never deleted when a sale is voided or an
  image replaced. Add a scheduled cleanup or a `before delete` hook.

> **Gate:** with a cashier's JWT, direct SQL/REST must fail on: reading another store's
> tables, writing `role_permissions`, adding a user beyond plan, and reading a
> permission-gated table — and a `POST /functions/v1/create-user` with `role_id` = admin must
> be rejected. Prove each with pgTAP + a REST probe in CI, not with a screenshot.

---

## 7. Phase 4 — Numbers that stay true at scale · 2 days 🟠

Not performance polish: each item is a screen that quietly stops being correct as data grows.

1. 🟠 **Reports aggregate in the browser over an unbounded fetch.** `useSalesSummary`
   (`web/src/data/sales.ts:67-82`) selects *every* sale header in the store with no `range`
   or `limit`, then `ReportsPage.tsx` sums it in JS (`:27`) and slices the top 5 (`:47`).
   Fine at a few thousand invoices; a multi-megabyte download and a stalling tab at 200k.
   Replace with store-scoped, index-backed SQL — `report_sales_window(from_t, to_t)` for
   totals/counts, `report_top_products`, `report_payment_mix` — so the payload size stops
   depending on history depth.
2. 🔴 **Two different definitions of "today" in one app.** Reports uses the **UTC** date:
   `const todayIso = new Date().toISOString().slice(0, 10)`
   (`web/src/features/reports/ReportsPage.tsx:19`, with `monthStart` derived at `:20`, and
   the same two lines repeated in a second component at `:116-117`). History uses the
   **store-local** date: `localDate()` (`web/src/data/sales.ts:84-87`) feeding the filter at
   `:118-119`. In UTC+2/+3 every sale before 03:00 local counts as *yesterday* on Reports and
   *today* on History. Fix: one `store_day_range()` / `store_today()` in SQL, used by both.
3. 🟠 **Lexical comparisons against `timestamptz`.** `order_date` is a `timestamptz`, but
   Reports compares it with `startsWith` / `>=` on `'YYYY-MM-DD'` strings in JS, while the
   naive strings History sends (`${localDate()}T00:00:00`) are interpreted in the session
   time zone by Postgres. Filter on explicit `gte`/`lt` timestamptz boundaries instead.
4. 🟠 **Zero-total "prescription sales" pollute revenue.**
   `useAddStandalonePrescription` (`web/src/data/sales.ts:704-734`) writes a sale with invoice
   `PRESC-<base36 epoch>` (`:717`) and all-zero totals. It counts as a sale in Reports and it
   injects a second, non-numeric namespace into the invoice sequence — which is exactly what
   makes the `count(*)` seed in `getNextInvoiceNo` wrong. Fix: `sales.kind`
   (`'sale' | 'prescription'`), excluded from revenue and counted separately.
5. 🟠 **Search destroys legitimate queries instead of escaping them.**
   `search.ts:14`, `customers.ts:68` and `sanitizeTerm` (`sales.ts:89-92`) each strip
   `, ( )` from the term. That closes PostgREST or-syntax injection — good — but
   `Ahmed (Cairo)` silently becomes `Ahmed   Cairo` and returns nothing, with no error. And
   every field is `ilike '%term%'`, which cannot use a btree index. Fix: move search into a
   `security definer` RPC (`search_text(p_term text)`) over `to_tsvector` / `pg_trgm` with
   GIN indexes, so no filter string is ever assembled in the browser; add GIN on
   `customers.name/phone`, `inventory.name/sku`, `sales.invoice_no`.
6. 🟡 **Index sweep.** Confirm or add: `sales (store_id, order_date desc)`,
   `sale_items (sale_id)`, `sale_payments (sale_id, paid_at)`,
   `stock_movements (product_id, created_at)`, `customers (store_id, name)`.

> **Gate:** Reports over a year of history returns in <300 ms with a payload under ~20 KB;
> Reports and History agree on "today" with the store set to `Africa/Cairo`; `EXPLAIN` shows
> no sequential scan on the five tables above; the search box finds a customer whose name
> contains brackets.

---

## 8. Phase 5 — Making the schema trustworthy to change · 1–2 days 🟠

`web/supabase/000_base_schema.sql:14-17` openly states the live project has drifted from the
file, and `SETUP.md` is a hand-paste-into-the-SQL-Editor flow. So two "identical" installs
can differ, and nothing will ever notice.

- [ ] **Real migration tooling.** Move the 12 flat files (`000`…`011`) into a real migrations
   directory. Note the wrinkle: the Supabase CLI project root is the **repository root** — that
   is where `supabase/config.toml` and `supabase/functions/create-user/` already live — so
   `supabase migration up` will look in `supabase/migrations/`, not `web/supabase/`. Either
   move the SQL there (keeping the numbers) or use a `schema_migrations` table plus a CI check,
   and deploy with `supabase migration up`. Reconcile live → repo once with `supabase db pull`.
   Keep `SETUP.md` as the operator guide; stop treating it as the deployment mechanism.
- [ ] **pgTAP.** `create extension pgtap`, tests under `web/supabase/tests/`, wired to
   `npm run test:db` and gated in CI. Every gate in this document is a pgTAP assertion —
   that is what makes "we tested it" mean something six months from now.
- [ ] **Fixtures.** A seeded store (one invoice per edge case: part-paid, voided, returned,
   zero-total prescription, multi-tender) so money tests are deterministic.
- [ ] **Make failures visible.** `getNextInvoiceNo` logs its own failure with `console.warn`
   and then invents a number (`web/src/data/sales.ts:246-249`); the RPC-missing fallback
   (`:40-46`) degrades silently. Convention: a mutation either surfaces a toast and keeps
   the draft, or it is documented as non-critical. Add a persistent "schema out of date —
   run 012" banner whenever the `isMissingFunction` path fires, because silent fallback is
   precisely how drift hides.
- [ ] **Regenerate types in CI** so a schema change cannot land without a type error.

> **Gate:** `npm run test:db` runs in CI; a fresh project + `migration up` produces a schema
> that matches production's `pg_dump` on the money-critical tables; every fallback path in
> `sales.ts` is either removed or visible to the cashier.

---

## 9. Phase 6 — New capabilities that are now cheap 🔵 · 5–8 days

Nothing here is possible *safely* today, which is why it sits last. Once Phase 1–2 land, each
item is a small RPC plus a screen.

| Capability | What it needs from earlier phases |
|---|---|
| **Offline queue + replay** | Phase 1 idempotency + server re-pricing. `lib/queryClient.ts:19-20` already admits "full offline-write support (queue + sync) is Phase 7" while `OfflineBanner` promises syncing — today a sale made while the browser is offline is simply lost or duplicated. |
| **Customer ledger & statements** | `sale_payments` already exists; needs `customer_balance(p_customer)` + a statement screen and a part-payment reminder list. Today there is no way to answer "what does this customer owe?". |
| **Day / shift close (Z report)** | `paid_at` as `timestamptz` + voids (Phase 2) + server aggregation (Phase 4). |
| **Purchase receiving → stock** | Link `purchase_items` receipt to `stock_movements` with cost, so `sale_price`/cost margin becomes real and supplier balances are computable. |
| **Lab as line items** | Lab cost per lens into margin, plus `lab_status_changed_at` so "Ready 3 days ago" is measurable. `LAB_STATUSES` (`web/src/data/sales.ts:647-659`) is already the single vocabulary to hang that on. |
| **Audit log** | Trigger-fed `audit_log (who, table, row, action, when)` — build it *before* adding more permissions, so Phase 3's changes are reviewable. |
| **Receipt share / thermal print** | `features/pos/receipt.ts` already has tested formatting; add share-to-WhatsApp and a 80 mm print stylesheet. |
| **Consolidated multi-store reporting** | Platform-admin view across tenants, now that store scoping is trustworthy. |

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

The repo has **9 Vitest files, all pure functions**:
`data/permissions.test.ts`, `data/sales.test.ts`, `features/pos/enterNav.test.ts`,
`features/pos/pricing.test.ts`, `features/pos/receipt.test.ts`, `features/pos/types.test.ts`,
`i18n/translations.test.ts`, `lib/payments.test.ts`, `lib/posDraft.test.ts`.
They are good tests of arithmetic and string building. **None of them touches Postgres**, so
nothing in the database has ever been tested — which is exactly where the money defects live.

| Layer | Tool | Covers | Status |
|---|---|---|---|
| Pure logic | Vitest (`npm run test`) | pricing, receipt text, payment split maths, draft shape | ✅ exists |
| **Database** | **pgTAP** (`npm run test:db`) | re-priced totals, stock guard, invoice uniqueness, idempotency, constraints | ❌ Phase 0/1 |
| **Authorisation** | pgTAP + REST probe with a cashier JWT + one `create-user` invocation | RLS matrix per role × table, denied deletes, denied cross-store reads, denied admin minting | ❌ Phase 2/3 |
| Migration safety | `supabase db push` on a preview project + `pg_dump` diff | drift between live and repo | ❌ Phase 5 |
| Query cost | `EXPLAIN (ANALYZE)` assertions in pgTAP | no seq scans on the hot paths | ❌ Phase 4 |
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
| POS · Checkout | Invoice number generated in JS; on error returns `Date.now() % 1000000` | `data/sales.ts:190-250`, `:222-227`, `:246-249` | 1 |
| POS · Checkout | When the RPC is missing, a silent non-atomic multi-table fallback runs | `data/sales.ts:40-46`, `:386-445` | 1 |
| POS · Checkout | Legacy 3-arg RPC drops `rx_image_path` / `frame_image_path` | `002_create_sale_rpc.sql` | 1 |
| POS · Checkout | No idempotency key — a retry after a lost response can create a second sale | `data/sales.ts:298-455` | 1 |
| POS · Checkout | A sale can never be voided, refunded or returned | `011_sale_payments.sql:48` (`check amount > 0`), no `void_*` RPC | 2 |
| POS · Checkout | Order-editor patch can rewrite `net_amount` / `amount_paid`, bypassing the ledger | `data/sales.ts:662-700` (`:691`) | 2 |
| POS · Checkout | No line-level discount (order-level only) | `sale_items` columns | 2 |
| POS · Checkout | Payment timestamp is a `date`, not a `timestamptz` | `sale_payments` DDL in `011` | 2 |
| POS · Checkout | Standalone prescriptions create zero-total sales with a `PRESC-<epoch36>` invoice | `data/sales.ts:704-734`, `:717` | 4 |
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
| Process | Live schema has drifted from `000_base_schema.sql` (stated in its own header) | `000_base_schema.sql:14-17` | 5 |
| Process | No CI, no SQL/RPC/RLS tests; `database.types.ts` is hand-maintained while `gen:types:reference` (`web/package.json:13`) has never been run — `src/lib/database.gen.ts` does not exist | no `.github/`; `web/src/lib/` | 0/5 |

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
| **`012_integrity.sql`** *(planned)* | Server re-pricing, `available_stock()`, `stock_qty` read model, `invoice_counter`, idempotency key, money constraints | Phase 1 |
| **`013_void_refunds.sql`** *(planned)* | `void_sale()`, refund tenders, movement vocabulary, `paid_at` → `timestamptz`, delete revocation | Phase 2 |
| **`014_server_rbac.sql`** *(planned)* | `can()` / `require_perm()`, tenant RLS on the three RBAC tables, store resolution without username fallback | Phase 3 |
| **`015_reporting_search.sql`** *(planned)* | Report RPCs, `store_day_range()`, `search_text()` + `pg_trgm`/GIN, index sweep | Phase 4 |
| `supabase/config.toml` *(repo root)* | CLI project root; `verify_jwt = true` for `create-user` | Split from the SQL in `web/supabase/` — Phase 5 |
| `supabase/functions/create-user/index.ts` | Creates an Auth user + mirrors it into `public.users` using the service-role key | JWT-only gate, caller-supplied `role_id`/`store_id` — Phase 3 |

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








