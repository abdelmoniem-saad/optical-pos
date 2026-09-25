# LensyPOS — Web (React + Supabase)

The LensyPOS application: a React SPA talking directly to the Supabase project
(Postgres + RLS). This is the **only UI** — the legacy Flet/Python app was
removed from the repo (see the root README's History section).

## Stack

- **Vite + React + TypeScript** — client-side rendering (no server round-trip
  per interaction)
- **Tailwind CSS v4** — responsive styling; design tokens in `src/index.css`
  (`@theme`) and `src/theme/tokens.ts`, ported from the legacy Flet UI
  (removed — recoverable from git history)
- **React Router** — routing + protected shell + URL-driven filters
- **TanStack Query** — server-state cache, persisted to localStorage for
  offline reads
- **Supabase JS** — direct browser → Postgres (RLS-protected)

## Run

```bash
cd web
npm ci               # first time (npm install works too)
npm run dev          # http://localhost:5173 (also exposed on LAN for tablets)
npm run build        # type-check + production bundle
```

## Config

Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` (and optionally `VITE_AUTH_EMAIL_DOMAIN`). The anon
key is browser-safe **only because Row-Level Security is enabled on every
table** — see `supabase/SETUP.md`.

## Layout

```
src/
  lib/          supabase client, query client, auth, licensing, pos draft storage
  theme/        design tokens (TS)
  i18n/         translations (ar/en) + RTL handling
  data/         permissions model, shared data helpers (sales paging)
  components/   AppLayout (protected shell), GlobalSearch, Feedback (confirm/toast)
  routes/       AppRouter, nav items
  features/
    auth/       LoginPage (username sign-in)
    pos/        multi-step sale wizard, pricing, receipts, keyboard nav
    dashboard/  DashboardPage (+ backend-connectivity probe)
    customers/  customer list + detail (orders, exams, notes)
    inventory/  products, stock movements, optical metadata
    lab/        lab pipeline
    history/    invoice search, extra payments, reprint
    reports/    revenue / stock / customer reports
    suppliers/  suppliers + purchase payments
    notes/      shared notes
    staff/      staff & positions (permissions)
    settings/   shop settings, optical settings
    platform/   multi-store licensing (platform admin)
    mobile/     standalone /m-upload page (phone uploads)
supabase/       SQL migrations 000–010 + SETUP.md
```

## Types

`src/lib/database.types.ts` is **hand-maintained**: it declares the shapes the
app actually uses (Customer, Product, Sale, …). `npm run gen:types:reference`
writes a full generated `src/lib/database.gen.ts` for reference/diffing only —
nothing imports it and it is git-ignored, so re-generating can never break the
build.

## Tests

```bash
npm test          # vitest run — pricing, invoice numbers, receipts,
                  # permissions, nav keys, i18n coverage, draft storage
npm run test:watch
```

`src/i18n/translations.test.ts` fails the build when a literal `t('…')` key has
no Arabic translation, so translate new UI strings in the same commit.

## Database setup

See `supabase/SETUP.md` for the one-time dashboard steps (RLS, admin login,
atomic checkout RPC, storage bucket, `create-user` Edge Function deploy).
