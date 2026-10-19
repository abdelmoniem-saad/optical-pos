# Permission and workflow verification

Run from `web`:

```sh
npm run dev -- --config qa/vite.config.ts --host 127.0.0.1 --port 5174
```

This configuration substitutes an in-memory Supabase fixture. It does not use
production credentials or send database writes. The normal production build
does not use this configuration. Reloading resets the fixture. Use
`/lab?qaRole=seller` for the restricted seller, or `/staff?tab=access` for Admin.
The fixture demonstrates rendering and interactions, not database enforcement.

Verified visually in Arabic/RTL:

- Staff: removing role View makes dependent actions effectively denied;
  employee Allow restores access; Inherit restores the role decision.
- Reports Ready link opens Lab with Ready selected.
- Lab: recording the remaining demo payment updates the ledger and balance.
- Restricted seller: status is disabled, payments remain readable, collection
  and refund controls are absent.
- Open Invoice opens the exact invoice expanded in History; refund displays
  available funds, a reason field, and the effect on the invoice balance.

Screenshots contain only local demo data. The deployed Staff, Reports, Lab and
History screens were reviewed read-only; no production financial/staff data
was changed. `database-validation.log` records the clean migration run and
365 passing pgTAP assertions. `repository-inventory.json` inventories every
tracked file by contents/hash and maps SQL/frontend entry points; it is not
a claim of a line-by-line security audit of every file.
