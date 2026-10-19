# Release 029

Release status (2026-10-19): production migration 029 is applied and the deployed
create-user function (version 5) contains the updated index.ts and authz.ts.
Both were verified through the connected Supabase project. The instructions below
are retained for reference; do not repeat completed deployment steps.
Tests ran in disposable local Postgres databases. Pushing code does not apply
SQL or deploy Edge Functions.

## Supabase SQL Editor

1. Check the production schema version:

   ```sql
   select * from public.lensy_schema_versions order by version;
   ```

2. If migrations through 028 are present, run the complete contents of
   `web/supabase/029_effective_permissions.sql` in the project's SQL Editor.
   If earlier versions are missing, apply the missing numbered migrations from
   `web/supabase/` in order first. Do not use files from its `tests/` directory.
   Migration 029 is transactional; if it errors, stop and retain the error.
3. Repeat the version query and confirm version 29 is recorded.

None of the `*_test.sql` files belong in the production SQL Editor, including
`029_effective_permissions_test.sql`. They use test fixtures and the pgTAP harness.
Do not run `_shim.sql` or the local database setup scripts against production.

## Edge Function and web client

After SQL succeeds, deploy the updated `create-user` function from this checkout,
including both `index.ts` and `authz.ts`. The repository's deployment command is:

```sh
supabase functions deploy create-user --project-ref qhbprvavoudetjbyxrsn
```

Run this with the Supabase CLI authenticated to the intended project. Verify the
project reference against the dashboard first. Alternatively update both files
in the existing Edge Function through the dashboard and deploy it. Preserve its
existing secrets; do not put service-role credentials in the web client or chat.

Then merge/release the code to the branch Render deploys and deploy the web app.
The working branch is kept separate from main so web deployment can follow SQL.
Reload the app after deployment. Check Staff access, Reports-to-Lab navigation,
invoice links, and permissions in a separate restricted employee session.
Do not use real financial transactions as test fixtures.

## Repository CI gate

Migration 029 changes the expected schema fingerprint. After a CI run for this
change, copy its stable `actual` hash from the **CI step summary** into
`web/supabase/schema.fingerprint`, commit it, and rerun CI. Do not use an old
artifact or the live schema-baseline workflow for this hash. See `DEFERRED.md`.
The 029 fingerprint was recorded from CI run 39321408088 (PR #1), whose migration
tests passed and whose fingerprint was stable across two calculations. The run
summary's reported actual value was used, not a downloaded artifact.

Local verification: production build, 260 frontend tests, 365 pgTAP assertions.
Module View currently controls screens and prerequisite actions; strict isolation
of shared same-store read APIs remains follow-up work (IMPLEMENTATION_PLAN.md).
