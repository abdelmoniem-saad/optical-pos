# LensyPOS

Start with `HANDOFF.md`: current status (what is live, what is waiting on the
owner, what comes next), the offline-first plan, and how to work here.

Rules that bite immediately:
- Git: always `git -c safe.directory=D:/Projects/optical-pos/optical-pos ...`; never stage `.junie/`.
- Database migrations in `web/supabase/` are applied to production by hand; never run tests or the
  local-db scripts against production, and apply SQL before merging a PR whose client depends on it.
- Before a PR: `cd web && npx tsc -b && npx vitest run && npx oxlint && npm run build && npm run test:db:local`.
- The schema fingerprint is recorded from CI, never computed locally.
- The plan for the offline register is `docs/offline-v2/design.md` (revision 3); keep `HANDOFF.md`
  section 2 and the design's section 0 status line up to date when something ships.
