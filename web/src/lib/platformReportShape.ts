/**
 * Pure shaping for the consolidated multi-store report (migration 025).
 *
 * DELIBERATELY IN ITS OWN MODULE, and the reason is the one Phase 3 already hit:
 * importing the data module pulls in lib/supabase, which throws at load time
 * without VITE_SUPABASE_* in the environment. A test file that imports it cannot
 * run at all. lib/createUserAuthz.ts exists for exactly this reason - "pure, so
 * tsc -b checks them and vitest covers them" - and this follows it rather than
 * mocking the client.
 *
 * Nothing here touches the network, so the arithmetic a vendor reads off the
 * screen is testable without a database.
 */

export type PlatformStoreRow = {
  store_id: string
  store_name: string
  time_zone: string
  is_active: boolean
  from_at: string
  to_at: string
  revenue: number
  paid: number
  order_count: number
}

export type PlatformReport = {
  rows: PlatformStoreRow[]
  totals: { revenue: number; paid: number; orders: number; stores: number }
  /** False when the database is not migrated yet - the screen then explains
   *  instead of showing an empty table that reads as "every shop sold nothing". */
  inDatabase: boolean
}

/** Postgres `numeric` arrives over PostgREST as a number OR a string depending on
 *  the path, and `Number(null)` is 0, so an absent figure and a genuine zero are
 *  indistinguishable unless they are handled apart. */
export function toNumber(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Normalise the RPC payload and total it.
 *
 * THE TOTAL IS THE SUM OF THE ROWS, computed here, not a second figure from the
 * server. The SQL gate (G-A7) asserts the same property; repeating it client
 * side is because a vendor comparing shops needs the bottom line to be visibly
 * the arithmetic of the column above it, and a separately fetched total can
 * disagree with its own parts without anything failing.
 */
export function buildPlatformReport(payload: unknown): PlatformReport {
  const raw = Array.isArray(payload) ? (payload as Record<string, unknown>[]) : []
  const rows: PlatformStoreRow[] = raw.map((r) => ({
    store_id: String(r.store_id ?? ''),
    store_name: String(r.store_name ?? ''),
    time_zone: String(r.time_zone ?? 'UTC'),
    is_active: r.is_active !== false,
    from_at: String(r.from_at ?? ''),
    to_at: String(r.to_at ?? ''),
    revenue: toNumber(r.revenue),
    paid: toNumber(r.paid),
    order_count: toNumber(r.order_count),
  }))
  return {
    rows,
    totals: {
      revenue: rows.reduce((a, r) => a + r.revenue, 0),
      paid: rows.reduce((a, r) => a + r.paid, 0),
      orders: rows.reduce((a, r) => a + r.order_count, 0),
      stores: rows.length,
    },
    inDatabase: true,
  }
}

/** The pre-025 answer. Distinct from an empty result set, which is a real reply. */
export const EMPTY_REPORT: PlatformReport = {
  rows: [],
  totals: { revenue: 0, paid: 0, orders: 0, stores: 0 },
  inDatabase: false,
}
