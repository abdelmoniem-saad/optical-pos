# Release 032 + 033 (offline-v2 Phase 1a)

Release status: NOT deployed. Migrations 032 and 033, the matching web client and
the `create-user` change are on branch `offline-v2-phase1` only. Tests ran in the
disposable local Postgres database. Pushing code does not apply SQL, deploy the
web app or deploy the Edge Function.

033 ships **dark**: no store becomes register-only and no register exists after
it. The shop keeps working online exactly as today. These two migrations lay the
server groundwork the offline register (Phases 2-4) will use.

## Earliest date: 2026-12-04

032 removes the old global settings rule that a pre-031 app still uses. Paste it
only when the 031 web app (PR #4, deployed 2026-11-27) has been live for **7
days** AND every shop device (the PC, any phone or tablet) has been reloaded
since. Before that, a stale tab would fail to save settings.

## What changes for the shop

- **Weighted cost is right.** Receiving 10 units at 4.00 and then 10 at 6.00
  stored a cost of 4.67; it now stores 5.00. Costs already stored are not
  recomputed.
- **Only staff accounts take money.** A payment, a void or a shift close done
  from a login that has no staff row (for example the vendor's own platform
  account) is refused from now on. Use a staff login in the shop.
- **Permission checks stay inside a store.** Asking whether a user of another
  store may do something now answers "no" unless the asker is the vendor.
- **The store owner is recorded.** 033 links the store to its owner's login:
  the store's single active admin login, as decided. Only that login will be
  able to set up the register, switch it off and switch off staff from the
  phone.
- **The phone code is ready for read-only mode.** Nothing changes until a
  register is set up. Then the phone shows "Read-only: the shop PC is the system
  of record", when the PC last synced, and two owner buttons: "Revoke register"
  and "Switch off" on a staff member.
- **Usernames.** A login name stays unique across the whole system, as today.
  Staff who will sign in only at the register PC need a name unique within
  their store only.
- **Staff creation refuses register shops.** When a store records on its PC,
  `create-user` answers "Add staff at the shop PC" (HTTP 409).

## Before pasting: three checks (SQL Editor)

```sql
select * from public.lensy_schema_versions order by version;   -- 31 is the latest

-- payments with no store (032 fills them in from their sale; normally none)
select sale_id, count(*) from public.sale_payments where store_id is null group by 1;

-- money actions recorded by a login with no staff row (each makes 032 warn)
select id, recorded_by from public.sale_payments t
 where recorded_by is not null and not exists (select 1 from public.users u where u.id = t.recorded_by);
select id, voided_by from public.sales t
 where voided_by is not null and not exists (select 1 from public.users u where u.id = t.voided_by);
select id, closed_by from public.shift_closes t
 where closed_by is not null and not exists (select 1 from public.users u where u.id = t.closed_by);
```

If the last three return rows, 032 still applies but prints
`WARNING: lensy: constraint ... is NOT valid` and leaves that rule unchecked for
old rows. Such a sale then refuses a later void or payment until fixed. Set
those ids to the right staff id (or NULL), then run
`select public._repoint_actor_keys();` to validate the rules.

## Order: 032, 033, the Edge Function, then the web app (at closing time)

1. **032.** Run the complete contents of `web/supabase/032_actor_core.sql`. One
   transaction, safe to re-run. Confirm `select public.schema_version();` reads
   32.
2. **033.** Run the complete contents of `web/supabase/033_register.sql`. One
   transaction, safe to re-run. It adds a trigger to 25 tables, so run it when
   the shop is closed. Confirm the version reads 33, then check the owner:

   ```sql
   select id, name, owner_uid from public.stores;
   ```

   A NOTICE names any store left without an owner (none, or several admin
   logins). Set it as the **vendor's own login** (SQL Editor: "Run as"
   authenticated, choose the vendor user), because the function checks for a
   platform admin:

   ```sql
   select public.set_store_owner('<store id>', '<owner auth uid>');
   ```

   Setting `stores.owner_uid` directly is refused from 033 on.
3. **Edge Function `create-user`.** Deploy `supabase/functions/create-user/`
   (`index.ts` and `authz.ts` changed):

   ```sh
   supabase functions deploy create-user --project-ref qhbprvavoudetjbyxrsn
   ```

   or update both files in the dashboard and deploy. It works before and after
   033: if the new check is missing it behaves as today.
4. **Web app.** Merge the pull request into `main`; Render deploys. Reload every
   shop device. The app expects version 33: deployed before 033, it shows the
   red database-update banner.

Do not run any `tests/*_test.sql` file, `_shim.sql` or the local database
scripts against production.

## Check after deploying (in a test store, not with real money)

- Sales, refunds, voids, receiving stock, closing the shift and settings all
  work as before; the phone shows no read-only banner.
- Receive 10 of a product at 4.00 into an empty shelf, then 10 at 6.00: its cost
  reads 5.00.
- Staff: adding a staff member still works; switching one off frees a seat.

## Repository CI gate

032 and 033 change the schema fingerprint. The new hash is taken from the PR's
CI step summary, as for 029-031.

Local verification: production build, 366 frontend tests, 729 pgTAP assertions
(473 before Phase 1 plus 67 in `032_actor_core_test.sql`, 189 in
`033_register_test.sql`; `018` G-P4b corrected to 5.00 and `031` ST1 now checks
the global settings key is gone).
