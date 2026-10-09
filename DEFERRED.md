# LensyPOS — Deferred Work

`PHASED_ROADMAP.md` (archived at `docs/archive/PHASED_ROADMAP.md`) tracked the
six-phase hardening programme. **All six phases are implemented and gated.** This
file is the surviving memory of what was *deliberately not done*, and the trigger
that should bring each one back. Kept short on purpose: an item here is a
decision with a reason, not a task list.

## Deliberately deferred

| Item | Why deferred | Revisit when |
|---|---|---|
| Replace `users` with Supabase Auth identities | Large blast radius; tenancy works on top of it | Store resolution is now locked (014) — reassess when convenient |
| Realtime sync between two open registers | Needs Phase 1 idempotency to avoid double-writes | Two stores ask for it |
| True offline-first (conflict-merged) model | Queue-and-replay covers the real need at 1/10 the cost | Offline becomes a paid feature |
| Toolchain upgrade (React / Vite / TS / vitest / oxlint) | Hygiene, not value — never mix with a money phase | Standalone PR |
| Playwright end-to-end suite | Thin value until the DB is authoritative | After the UI surface stabilises |
| Image de-duplication by hash | Needs a storage listing pass; orphan cleanup (003) was the urgent half | Storage costs show it |
| PDF invoice archiving | Receipt print/share comes first | A customer asks for e-invoices |
| Multi-currency, VAT engine, e-invoicing | Changes the money model | The money model is server-owned (since 012) — reassess |
| SSR / framework migration | No user-visible gain | Never, unless it removes a real defect |
| Platform-admin service-role key | The platform surface only READS, through RLS that already scopes it; a service-role key in a browser bundle is a worse trade | It ever needs to WRITE across tenants |

## Known, measured, not yet acted on

- **`platform_report_window` is the one slow report.** Measured at 50k-row scale
  (`npm run bench:db`): every single-store report is 20–55 ms, but the 025
  cross-store report is ~305 ms and touches ~151k shared buffers for a ONE-DAY
  window — an order of magnitude more work than the single-store reports, which
  implies its per-store date filter is not index-served. A fix is a migration
  (add/tune an index, or reshape the per-store aggregate); do it when the
  platform view is used at real scale.
- **Lab cost per lens is not in margin.** `lab_queue()` (019) makes dwell time
  measurable, but a per-lens lab cost is not captured, so true job margin is not
  computable. Needs a cost field on the lab line plus a margin rule.

## Operational notes worth keeping

- Migrations are applied by pasting into the Supabase SQL Editor
  (`web/supabase/SETUP.md`); every file is idempotent and re-runnable.
- A schema change re-baselines `web/supabase/schema.fingerprint` — copy the hash
  from the **CI step summary** of the run that reports it, never from an artifact
  (a stale artifact is indistinguishable from a fresh one).
- Adding a migration means bumping `EXPECTED_SCHEMA_VERSION`
  (`web/src/lib/schemaVersion.ts`) and its test, or the drift banner goes quiet.
- The pgTAP gates run locally: `npm run db:local` once, then
  `npm run test:db:local`. The report benchmark: `npm run bench:db`.
