# LensyPOS - handoff and current status

Read this first if you are picking the project up with no history. It says what
is live, what is waiting, what comes next and how to work in this repository
without tripping over its quirks. Last updated 2026-11-28 (after PR #5 merged).

## 1. What the project is

LensyPOS is a point-of-sale system for one optical shop (one store, one shop PC,
the owner's phone), built so it can host more stores later.

- `web/` - the app: React 19 + Vite + TanStack Query 5, talking to Supabase.
- `web/supabase/NNN_*.sql` - numbered database migrations (000 to 033, all applied in production). Each is
  pasted by hand into the Supabase SQL Editor, in order; each is one
  transaction, safe to paste twice, and records its own number
  (`record_schema_version(N, ...)`).
- `web/supabase/tests/*_test.sql` - pgTAP gates. CI applies every migration to an
  empty database, then runs every gate.
- `supabase/functions/create-user/` - the Edge Function that creates staff
  logins (`index.ts` does the I/O, `authz.ts` the decisions, tested from
  `web/src/lib/createUser*.test.ts`).
- Production: Supabase project ref `qhbprvavoudetjbyxrsn`; the web app is a
  Render static site (`render.yaml`) that rebuilds from `main` on every merge.
  Public sign-up is OFF (staff logins are made by `create-user`).
- GitHub: `abdelmoniem-saad/optical-pos`. Work happens on a branch, lands by PR.

## 2. Where things stand

| Piece | What | State |
|---|---|---|
| 029 | Effective staff permissions (PR #1) | Live |
| 030 | Money fixes, offline checkout queue, security hardening (PR #3) | Live (applied 2026-11-27) |
| 031 | Per-store names, safe photo sweep, active staff seats (PR #4) | Live (applied 2026-11-27, `create-user` deployed) |
| 032 + 033 | Offline register groundwork, shipped dark; read-only phone client (PR #5) | Live (applied 2026-11-28, `create-user` deployed, merged as 1499640) |
| 034 | Register ingest (Phase 1b) | Not started |

Production database version today: **33**. No store is register-only; the shop works online as before.

**Store owner.** Main Store (`d2fa0efc-5aab-445d-8888-ac68f8088928`) has two admin logins (`admin`, `d`), so 033's backfill left `owner_uid` empty. The owner chose `admin` (`c6abb73f-3f73-4aef-8bbe-b07bc88ab268`); it is set by the vendor with `set_store_owner` (command in `RELEASE_033.md`, run as the `superadmin` platform account). Confirm with `select id, name, owner_uid from public.stores;` before Phase 4 setup. `teststore` has no owner yet; give it one before the dry run. Staff row `o` has no login (cannot sign in): recreate or switch off.

## 3. The big goal: an offline-first register

The owner wants the shop PC to work fully without internet, forever, and sync
to the cloud when it can so the owner's phone shows the latest data with a
"last synced" status. Today (main) only a NEW sale is queued during an outage;
everything else needs internet.

The whole plan is `docs/offline-v2/design.md` (revision 3). Key sections:

- section 1: core decision (the PC keeps an ordered log of operations, the cloud
  replays them through dedicated `_ingest_<kind>` writers; the online money
  functions stay untouched)
- section 2: PC architecture (IndexedDB store, rules engine, clock and licence,
  invoice numbers, PIN sign-in, phone view, photos incl. QR drop)
- section 3: replication protocol; section 4: each migration (031-034) in detail
- sections 5-6: security and recovery; section 7: what to reuse from the old v1
  branch `origin/offline-first`
- section 8: the phased build plan with tests per phase, cutover checklist,
  rollback; section 9: owner decisions (all answered, see below)
- Appendix A: every review finding and where it is resolved

Other background in `docs/offline-v2/`: `critique.md` (review of revision 1) and
`main-map.md` (a map of the code on `main`).

### Phases

| Phase | Content | Days (one developer) | State |
|---|---|---|---|
| 0 | Money fixes (030) | - | Live |
| 0b | 031 | - | Live |
| 1a | 032 + 033 + read-only phone client + create-user 409 | - | Live (PR #5) |
| 1b | 034 `register_ingest` (23 writers, undo log, revert, export) - written and tested, kept on its branch, applied only in Phase 4 | ~8-12 | **Next** |
| 3a | Cloud half of the data seam (refactor, ships live) | 6-9 | |
| 2 | PC database and rules (`lib/register/*`) | 12-16 | |
| 3b | Register shell, PIN lock screen, local backend | 12-18 | |
| 4 | Sync, setup, backup/restore, phone status, QR photo drop, parity test; then 034 applied | 15-21 | |
| - | Dry run on a test store, cutover, 2-week pilot | - | |
| 5 | Thumbnails, paging, docs | 2-5 | |

### Owner decisions (design section 9)

One shop, one register device; only the owner uses the phone (read-only, with
last-sync status); the owner is the store's existing admin login; photos from
the PC or by QR from a phone (QR needs the PC online); **no offline time limit**
(licence end date only); backups to the Downloads folder until a folder is
chosen; the register runs as an installed Google Chrome app in one fixed Windows
user and Chrome profile. Unanswered items keep the defaults in brackets.

### Phase 1b starting points

- Spec: design section 4.4 and its Tests bullet, plus sections 3.1-3.10
  (envelope, outcomes, flag codes, the per-op table 3.6, money semantics 3.7).
- 033 adds a **token contract** 034 must follow (033 header, part 4):
  `register_ingest` opens `_register_bypass(store, 'ingest', true)` while it
  sets `lensy.ingest`/`lensy.store` and closes it before returning;
  `register_revert_ops` opens the `'admin'` token. Without them the guard
  refuses the writes.
- Revision 3 removed the 45-day contact limit; 4.4 still says undo rows are
  pruned after 60 days "longer than the 45-day contact limit" - revisit that
  retention when writing 034.
- 034 is a working number: it ships under the next free number when applied.

## 4. How to work here

### Git
The checkout is owned by another Windows user, so every git command needs
`git -c safe.directory=D:/Projects/optical-pos/optical-pos ...`. Never change
global git config. Never stage `.junie/` (an unrelated tool folder). Commit
messages end with the Co-Authored-By line; PR bodies with the Claude Code line.

### Tests (all must be green before a PR)
```sh
cd web
npx tsc -b && npx vitest run && npx oxlint && npm run build
npm run db:local          # once: starts a throwaway local Postgres (Windows, embedded)
npm run test:db:local     # recreates database "lensy", applies 000-NNN, runs every gate
```
- To run the suite in a separate database (e.g. parallel agents): create it via
  the shim (`export PATH="$PWD/web/.local-db/shim:$PATH"; psql postgresql://postgres:postgres@localhost:5432/postgres -c 'create database X'`)
  and run `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/X bash web/scripts/test-db.sh`.
- `psql` locally is a node shim: no backslash meta-commands; put SQL in a file and use `-f`.
- Local Postgres is 18.x; CI uses 16. CI is the authority.
- The one oxlint warning in `web/scripts/psql-shim.js` predates everything.

### Adding a migration
1. `web/supabase/NNN_name.sql`: header comment explaining every change and the
   production-apply rules; `begin; ... record_schema_version(NNN, '...'); commit;`
   idempotent; every function pins `search_path`; SECURITY DEFINER functions
   revoke from `public, anon` and grant explicitly; every table has RLS
   (`tests/030_security_hardening_test.sql` fails otherwise).
2. A gate `web/supabase/tests/NNN_name_test.sql` (begin/rollback, pgTAP plan).
3. Bump `EXPECTED_SCHEMA_VERSION` in `web/src/lib/schemaVersion.ts` and its test
   when the client needs the new schema.
4. `RELEASE_NNN.md` (order of SQL / Edge Function / merge, prechecks, checks),
   a step in `web/supabase/SETUP.md`, a row in `README.md`'s migration table.
5. **Schema fingerprint:** `pg_dump` is not available locally. Open the PR; CI's
   "Schema drift - fingerprint" step fails and prints the new hash; write it to
   `web/supabase/schema.fingerprint`, note it in the RELEASE file, push.
6. The SQL must be applied to production BEFORE the PR is merged when the client
   depends on it (Render deploys `main` immediately).

### Editing quirks
- Many files have CRLF line endings. The Edit tool copes; a script that matches
  text must normalise `\r\n` first.
- In JavaScript `String.replace`, `$$` in the replacement becomes `$` - fatal for
  SQL dollar quotes. Use `split(a).join(b)`.
- Never run `tests/*_test.sql`, `_shim.sql` or local-db scripts against production.

## 5. Other documents
- `RELEASE_029.md`, `RELEASE_030.md`, `RELEASE_031.md`, `RELEASE_033.md` - per-release steps.
- `web/supabase/SETUP.md` - every migration step from a fresh project (steps 1-30).
- `DEFERRED.md` - what was deliberately not done and when to revisit it.
- `IMPLEMENTATION_PLAN.md` - older plan; the offline work follows `docs/offline-v2/design.md`.
