# LensyPOS — Web (React + Supabase)

The web rewrite of LensyPOS. Runs alongside the existing Flet app and talks to
the **same Supabase project**, so there is no data migration during the rollout.

## Stack

- **Vite + React + TypeScript** — client-side rendering (no server round-trip per
  interaction, unlike Flet web)
- **Tailwind CSS v4** — responsive styling; design tokens in `src/index.css`
  (`@theme`) and `src/theme/tokens.ts`, ported from `app/ui/components/ui_tokens.py`
- **React Router** — routing + protected shell
- **TanStack Query** — server-state cache
- **Supabase JS** — direct browser → Postgres (RLS-protected)

## Run

```bash
cd web
npm install            # first time
npm run dev            # http://localhost:5173 (also exposed on LAN for tablets)
npm run build          # type-check + production bundle
```

## Config

Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY`. The anon key is browser-safe **only if Row-Level
Security is enabled on every table** — see Phase 2.

## Layout

```
src/
  lib/         supabase client, query client
  theme/       design tokens (TS mirror of the Flet tokens)
  components/  AppLayout (protected shell), Placeholder
  features/
    auth/      LoginPage (UI shell — auth wired in Phase 2)
    dashboard/ DashboardPage (+ live backend-connectivity probe)
  routes/      AppRouter
```

## Migration phases

1. ✅ Foundation & shell — this scaffold
2. Auth & security — **enable RLS + policies**, real login, sessions
3. Data layer — generated TS types, Query hooks per table, offline cache
4. POS flow — multi-step sale wizard
5. Supporting screens — inventory, customers, history, reports, staff, settings
6. Receipts & printing — HTML receipt + `window.print()` + PDF
7. PWA, offline & cutover
