# Release 030

Release status: NOT deployed. Migration 030 and the matching web client are in
the working tree only; nothing has been applied to the production project and no
web deployment has been made. Tests ran in the disposable local Postgres
database (`npm run test:db:local`). Pushing code does not apply SQL or deploy
the web app.

## What ships together

`web/supabase/030_money_fixes.sql` and the web client in the same branch **must
ship together**, SQL first:

- The client now sends line discounts on the FIRST checkout. Against a database
  without 030, `price_cart` adds those discounts back onto the net, so every
  first checkout with a line discount would overcharge. 030 fixes `price_cart`.
- The client sends the per-method tenders read from the payment ledger, plus
  `expected_amount_paid` and `expected_tenders` (what it last saw), on
  re-checkout. A pre-030 database ignores the extra keys but still deletes and
  rewrites the ledger on re-checkout.
- A checkout queued offline is replayed with the time Finish was pressed
  (`order_date` / `paid_at` from the device clock). 030 bounds that time to
  [the latest closed shift's end, at most 2 days back, now]; a pre-030 database
  stores it unbounded, so a late replay could land inside a closed shift.
- `EXPECTED_SCHEMA_VERSION` is 30, so a shop still on 29 sees the version banner
  until the SQL is applied.

No Edge Function changes in this release.

## Supabase SQL Editor

1. Check the production schema version:

   ```sql
   select * from public.lensy_schema_versions order by version;
   ```

2. If migrations through 029 are present, run the complete contents of
   `web/supabase/030_money_fixes.sql` in the project's SQL Editor. If earlier
   versions are missing, apply the missing numbered migrations from
   `web/supabase/` in order first. Do not use files from its `tests/` directory.
   Migration 030 is transactional; if it errors, stop and retain the error.
3. Repeat the version query and confirm version 30 is recorded.

030 drops the global `sales_invoice_no_key` constraint after creating the
per-store unique index `sales_store_invoice_no_key (store_id, invoice_no)`. A
database that satisfied the global rule satisfies the per-store one, so the index
build cannot fail on existing data.

None of the `*_test.sql` files belong in the production SQL Editor, including the
seven `030_*_test.sql` gates. They use test fixtures and the pgTAP harness. Do not
run `_shim.sql` or the local database setup scripts against production.

## Web client

After SQL succeeds, merge/release the code to the branch Render deploys and
deploy the web app. Reload the app after deployment. Check, in a test store and
never with real financial transactions:

- a re-checkout of a split-tender invoice that was partly refunded keeps the
  refund row and the original payment dates in History;
- a first checkout with a line discount stores net = what was charged;
- voiding an invoice that had a partial refund succeeds;
- removing an item from a paid invoice and pressing Finish says the money must be
  refunded from History first; after refunding it there and reopening the
  invoice, the re-checkout goes through;
- the receipt printed at Finish for an order with a line discount shows the same
  gross / discount / net as its reprint from History;
- with the network disconnected, Finish Checkout says "Saved on this device" and
  the sale appears once the network returns (also after reloading the page, and
  after switching to another tab and back, when the receipt appears).

## Behaviour changes users will notice

- **Refund first.** A re-checkout that would give money back (an item removed or
  discounted on a paid invoice) is refused - by the POS before it sends, and by
  the server as `refund first`. The cashier records the refund in History,
  choosing the tender and the reason, then reopens the invoice. The server never
  guesses which tender the drawer paid out from.
- Moving money from one tender to another at the same or a higher total (cash ->
  card) appends a refund row on the tender that went down and needs
  `history.refund`; a cashier without it is told so before the call.
- Re-checkout is refused with "This invoice changed since it was opened" when a
  payment or refund was recorded after the invoice was opened in the POS - also
  when the total did not change (refund 100 cash + collect 100 card); reopen it
  and try again.
- Re-checkout with a tender that is neither a known method nor already on the
  invoice is refused (`Invalid payment method`). A legacy tender already on the
  invoice (`visa`, `cash + instapay`, from the 011 backfill or an old
  re-checkout) is shown read-only in the POS: it can be kept or refunded, never
  given new money. History's refund form now offers those legacy tenders.
- A sale's time comes from the device when it is queued offline, bounded by the
  server: never in the future, never inside a shift already closed, never more
  than 2 days back.
- A sale that was "Saved on this device" but never reached the shop - the
  server refused it when it was replayed, or the held queue was discarded by
  signing out or by the 24-hour cache limit - is shown in a red strip on every
  screen until dismissed, so it can be entered again.
- Access (my_permissions, current user) is no longer polled every 15 seconds. It
  refreshes on load, on navigation (at most every 2 minutes), on returning to the
  tab or reconnecting after 5 minutes, and immediately after any server denial.
  A revoked button can stay visible a little longer; the database still refuses
  the action. A network blip no longer blanks the POS with "no access".
- Offline, every write except checkout now fails at once with an error instead of
  spinning; checkout is queued and survives a reload.

## Repository CI gate

Migration 030 changes the expected schema fingerprint (new index, dropped
constraint, redefined functions). `pg_dump` is not available on the local
Windows setup, so `npm run db:update-fingerprint` could not be run here. The
030 hash `88126510862a738b85ace3eec8a1cfae602333636d6556fbba1e7964241e201c` was
taken from the PR's CI run 45896660616 (stable across the step's two runs, all
pgTAP gates green in the same job) and recorded in
`web/supabase/schema.fingerprint` - the same procedure as 029. See `DEFERRED.md`.

Local verification: production build, 298 frontend tests, 444 pgTAP assertions
(365 before 030 plus 79 in the seven 030 gates).
