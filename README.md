# LensyPOS — Optical Shop Point of Sale

LensyPOS is a web-based point-of-sale system for optical shops: a multi-step sale
wizard with optical examinations, inventory, customers, lab tracking, sales
history, reports, staff/roles and store licensing — in **Arabic and English**
(full RTL support).

The entire UI is a React single-page app in [`web/`](./web) that talks directly
to [Supabase](https://supabase.com/) (Postgres + Row-Level Security). The legacy
Flet/Python desktop app was removed from this repository — the web app is the
only UI (see [History](#history)).

![React](https://img.shields.io/badge/React-19-61DAFB.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6.svg)
![Vite](https://img.shields.io/badge/Vite-8-646CFF.svg)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E.svg)
![vitest](https://img.shields.io/badge/vitest-5-729B1B.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)

## Features

- **Point of sale** — multi-step wizard (category → customer → examination →
  items → payment), keyboard-first entry (Enter/arrow navigation), discounts,
  partial payments, balance tracking, printable receipts (Arabic + English)
- **Optical examinations** — multiple Rx rows per order (distance / reading /
  contact lens), history and reuse, prescription image attachments
- **Inventory** — product catalog, stock movements (sale, purchase,
  adjustment…), optical metadata (lens/frame types, colors) with drag-sort
- **Customers** — CRM with order history, balances and examination history
- **Lab** — order status pipeline (Not Started → In Lab → Ready → Received)
  with lab-copy printing
- **Sales history** — search/filter invoices, record extra payments, reprint
- **Reports** — revenue summary, low stock, top customers, order statistics
- **Suppliers & purchase payments**
- **Staff & roles** — positions with permission grants, per-user overrides,
  in-app account creation via an Edge Function
- **Notes** — shared per-customer notes with read/unread state
- **Platform admin** — multi-store licensing (trial / active / grace / expired)
- **Global search** across customers, products and invoices
- **PWA** — installable, offline read cache, shared-tablet hygiene
  (cache + in-progress draft cleared on sign-out)

## Stack

- **Vite + React 19 + TypeScript** — client-side rendering
- **Tailwind CSS v4** — design tokens in `web/src/index.css` and `web/src/theme/tokens.ts`
- **React Router 7** — routing, protected shell, URL-driven filters
- **TanStack Query** — server-state cache with localStorage persistence (offline reads)
- **Supabase JS** — browser → Postgres over RLS, Auth, Storage, Edge Functions
- **vitest + jsdom / oxlint** — tests and linting

## Repository layout

```
web/                    the entire application
  src/                  app source (features/, data/, lib/, i18n/, routes/, components/)
  supabase/             SQL migrations 000–010 + SETUP.md (first-time setup)
  public/               PWA icons and manifest assets
supabase/functions/     Edge Function: create-user (staff account creation)
render.yaml             Render blueprint — static site serving web/dist
.claude/launch.json     dev launch config (npm --prefix web run dev)
```

## Quick start

Prerequisites: **Node.js 20+** and a Supabase project.

```bash
git clone https://github.com/abdelmoniem-saad/optical-pos.git
cd optical-pos/web
npm ci                      # first install (npm install works too)
cp .env.example .env.local  # then fill in the values
npm run dev                 # http://localhost:5173 (LAN-exposed for shop tablets)
```

### Environment (`web/.env.local`)

| Variable | Meaning |
| --- | --- |
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Browser-safe **only** because RLS is on every table |
| `VITE_AUTH_EMAIL_DOMAIN` | Staff log in with a username, mapped to `<username>@<domain>` (default `lensypos.local`) |

### Scripts (run inside `web/`)

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR |
| `npm run build` | Type-check (`tsc -b`) + production bundle |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | oxlint |
| `npm test` / `npm run test:watch` | vitest suite |
| `npm run gen:types:reference` | Regenerate `src/lib/database.gen.ts` (reference only, git-ignored) |

## Database & migrations

First-time setup is documented in [`web/supabase/SETUP.md`](./web/supabase/SETUP.md)
(RLS, admin login, atomic checkout RPC, storage bucket, Edge Function deploy).

Migrations run in numeric order in the Supabase SQL editor:

| # | File | What it does |
| --- | --- | --- |
| 000 | `000_base_schema.sql` | Historical base bootstrap (kept for reference — see note below) |
| 001 | `001_security_rls.sql` | Row-Level Security on every table |
| 002 | `002_create_sale_rpc.sql` | Atomic checkout (`create_sale_order`) |
| 003 | `003_purchase_payments.sql` | Purchase payments |
| 004 | `004_rbac_notes.sql` | RBAC tables + notes |
| 005 | `005_notes_edit.sql` | Note editing |
| 006 | `006_note_seen.sql` | Read/unread note state |
| 007 | `007_order_images.sql` | Prescription image attachments |
| 008 | `008_multi_tenancy.sql` | Store scoping, license-gated write policies |
| 009 | `009_store_licensing.sql` | Store licensing (trial/grace/expired) |
| 010 | `010_metadata_sort.sql` | Optical metadata ordering |
| 011 | `011_sale_payments.sql` | Sale payment ledger — split cash/wallet/instapay + later payments |

> **Note on 000:** it is the original bootstrap the app shipped with. The live
> project has drifted from it (e.g. Supabase Auth now owns passwords, not the
> legacy `users.password_hash`). When convenient, capture a fresh baseline with
> `supabase db dump` and commit it as the new 000.

## Security model

- **RLS on every table** (001) — the anon key shipped in the browser bundle
  cannot read or write anything without it.
- **Roles → grants, per-user overrides**, admin bypass and a superadmin
  break-glass; permission codes are mirrored in `web/src/data/permissions.tsx`.
- **Multi-tenancy** — rows scoped by store (008); license writes are gated
  server-side by `license_write_ok()` policies.
- **Fail-open with visibility** — an account with no role still signs in (so a
  mis-provisioned login never bricks), but the shell shows a visible
  "no access assigned" marker instead of failing silently.

## Store licensing

Each store is licensed (trial / active / grace / expired) — see
`008_multi_tenancy.sql` and `009_store_licensing.sql`. During **grace** the app
is read-only: `SELECT` is allowed, `INSERT/UPDATE/DELETE` policies require
`license_write_ok(store_id)`, and the shell shows a grace banner. Licenses are
managed from the in-app **Platform** page.

## Testing

```bash
npm test
```

Vitest suites cover pricing/discounts, invoice numbering (the historically
buggy path), receipt rendering (Arabic/RTL), POS keyboard navigation,
permissions resolution, in-progress sale draft storage, and an **i18n test that
fails when a `t('…')` key has no Arabic translation**.

## Deploy

[`render.yaml`](./render.yaml) deploys `web/` as a static site:
build `npm ci && npm run build`, publish `dist/`. The app is installable as a
PWA; offline reads are served from the persisted query cache.

## History

Until 2026 this repository also contained a Flet (Flutter-for-Python)
desktop/web UI (`app/`, `main.py`, `tests/`, …) with machine-locked licensing
and a local JSON database. It was removed in commit `62b9272` because the
server-driven UI round-tripped every interaction through Python; the web app
replaced it without a data migration (same Supabase project). Recover anything
from git history if needed.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes (run `npm run build && npm run lint && npm test` in `web/`)
4. Submit a pull request

## License

This project is licensed under the MIT License.

---

**Developed for Lensy Optical Shop** 🏪👓
