# Connected workflows and effective permissions

Scope: repair the existing app without adding another dashboard. Reports already
has pending lab, ready pickup, low stock and financial summaries; Customers has
a debtor list; History already records additional payments; Lab already tracks
handover; refunds already exist in SQL (028).

## Implementation order

1. Make access control authoritative and understandable. Deny access while
   unresolved, on errors, for inactive staff and for unassigned staff. Resolve
   staff by Auth UUID only. Show only supported actions. Make role changes and
   overrides explicit, save errors visible, and remove stale permission caches.
   Protect the same actions in SQL and fix the create-user RPC response handling.
2. Refresh connected data after writes: customer debt, invoices, lab timing,
   stock, reports and shift summaries. Test the dependency map.
3. Improve existing links: exact customer/invoice search results, customer to
   invoice, invoice to customer/lab, Reports to the correct lab filter. Reuse the
   payment panel at collection; gate status changes and show failures.
4. Verify with TypeScript, lint, unit/component tests and the local Postgres
   permission gates. Inspect the deployed screens read-only after sign-in and
   visually check the revised screens using an isolated local fixture session.

## Deployment

Apply migration 029 before shipping the new client; redeploy create-user too.
No production staff grants, customer records or financial records are changed
as test data. Record exact validation results and any deployment blockers here.

## Implemented and verified (2026-10-19)

- Replaced the generic CRUD grid with supported actions and explicit position
  grants / employee Inherit, Allow, Deny. Active/assigned state, effective access,
  immutable administrator access and errors are visible. Server checks prevent
  direct role escalation, unauthorized administrator assignment and self-lockout.
- Corrected create-user response-envelope handling and reserved administrator
  identities. Permission checks fail closed, refresh every 15 seconds/focus,
  and are excluded from persisted query caches. Server writes check current
  grants immediately, including with an existing JWT.
- Protected sale editing, collection, lab changes, examinations, stock,
  purchases, notes and settings at the database boundary. Refunds reuse 028.
- Connected existing customer/invoice/lab/report routes and refreshes. Collection
  reuses the payment ledger. Removed unsupported customer cascading deletion and
  the misleading editable discount field that did not persist.
- Production build and 260 frontend tests passed. All migrations 000–029 applied
  from scratch and all 365 pgTAP assertions passed. Lint has only the existing
  unused `tuplesOnly` warning in `scripts/psql-shim.js`.
- Reviewed deployed screens and revised local fixture screens visually; see
  `web/qa/README.md` and its screenshots. No production migration/deploy performed.

## Release gates and next work

1. Apply 029, redeploy the create-user Edge Function, then deploy the web client.
   Check two real sessions (administrator and restricted employee) after release:
   revoke an action, verify the open employee session loses it, then restore it.
2. Update `web/supabase/schema.fingerprint` from the trusted CI step summary,
   as required by `DEFERRED.md`. The old fingerprint is intentionally unchanged;
   this branch must not be described as fully CI-green before that step.
3. Define and implement data visibility separately from screen/action access.
   Current module View grants control navigation and prerequisite actions;
   existing same-store read policies and some reporting/search RPCs still expose
   shared tenant data to active assigned staff. This work does not establish
   strict per-module confidentiality. Prescription storage access also needs
   a separate review before making such a claim.
4. After deployment, prioritize that read-access boundary and real two-session
   end-to-end tests. Keep Reports as the existing attention summary rather than
   adding another dashboard. Realtime multi-register sync remains in DEFERRED.md.
