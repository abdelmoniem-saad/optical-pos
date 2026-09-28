import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A TRANSPORT contract, not a SQL one - which is exactly why the database gate
 * could not catch it.
 *
 * PostgREST wraps a set-returning function's result in an array even when the
 * function returns a single row. `report_sales_window` is
 * `returns table (revenue numeric, ...)`, so it always answers
 * `[{revenue: 11500, paid: ...}]`. Reading `data.revenue` off that array is
 * `undefined`, and `Number(undefined ?? 0)` is `0` - so Reports printed a full
 * row of zeros from a perfectly healthy database, while Top Customers (the one
 * call that used `.map()`) showed real names. Nothing threw; the screen lied.
 *
 * The gate stayed green because SQL sees the function, not PostgREST's JSON:
 * `select revenue from report_sales_window(...)` is a row, and always was. Only
 * a test that stands in for the HTTP layer can see the difference, which is
 * what this file is.
 */
const state = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: state.data, error: state.error }),
  },
}))

import { fetchReportTotals, fetchStoreDay, fetchTopCustomers, fetchVoidSummary } from './sales'

const totalsRow = {
  revenue: 11500,
  paid: 8000,
  balance_due: 3500,
  order_count: 7,
  pending_lab: 2,
  ready_lab: 1,
}

beforeEach(() => {
  state.data = null
  state.error = null
})

describe('single-row report RPCs', () => {
  it('reads the row, not the array that carries it', async () => {
    state.data = [totalsRow]
    await expect(fetchReportTotals(null, null)).resolves.toEqual({
      revenue: 11500,
      paid: 8000,
      balanceDue: 3500,
      orderCount: 7,
      pendingLab: 2,
      readyLab: 1,
    })
  })

  it('reads a void summary the same way', async () => {
    state.data = [{ voided_count: 3, voided_net: 9000 }]
    await expect(fetchVoidSummary(null, null)).resolves.toEqual({
      voidedCount: 3,
      voidedNet: 9000,
    })
  })

  it('keeps a numeric string from the DB as a number, not as 0', async () => {
    // Postgres numeric arrives as a JSON string; `Number(undefined ?? 0)` and
    // `Number('250.50' ?? 0)` are very different outcomes for the same screen.
    state.data = [{ ...totalsRow, revenue: '250.50' }]
    const totals = await fetchReportTotals(null, null)
    expect(totals?.revenue).toBe(250.5)
  })

  it('returns null when 016 is not installed, so the screen falls back', async () => {
    state.error = { code: 'PGRST202', message: 'Could not find the function' }
    expect(await fetchReportTotals(null, null)).toBeNull()
  })

  it('returns null rather than a row of zeros when no row comes back', async () => {
    state.data = []
    expect(await fetchReportTotals(null, null)).toBeNull()
  })

  it('rethrows an error that is not "the function is missing"', async () => {
    state.error = { code: '57014', message: 'canceling statement due to statement timeout' }
    await expect(fetchReportTotals(null, null)).rejects.toMatchObject({ code: '57014' })
  })
})

describe('the store day window', () => {
  it('returns the instants the database computed', async () => {
    // Cairo midnight, which is 21:00 UTC the day before - the whole point of
    // asking the database instead of letting the session zone guess.
    state.data = [{ from_at: '2026-09-27T21:00:00+00:00', to_at: '2026-09-28T21:00:00+00:00' }]
    await expect(fetchStoreDay('2026-09-28')).resolves.toEqual({
      from: '2026-09-27T21:00:00+00:00',
      to: '2026-09-28T21:00:00+00:00',
    })
  })

  it('falls back to the bare date when 016 is absent', async () => {
    state.error = { code: '42883', message: 'function does not exist' }
    expect(await fetchStoreDay('2026-09-28')).toBeNull()
  })

  it('refuses a row with no usable bounds', async () => {
    state.data = [{ from_at: null, to_at: null }]
    expect(await fetchStoreDay('2026-09-28')).toBeNull()
  })
})

describe('multi-row report RPCs', () => {
  it('maps every top-customer row', async () => {
    state.data = [
      { full_name: 'Ahmed', revenue: 900 },
      { full_name: 'Mona', revenue: 400 },
    ]
    await expect(fetchTopCustomers(null, null, 5)).resolves.toEqual([
      { name: 'Ahmed', total: 900 },
      { name: 'Mona', total: 400 },
    ])
  })

  it('names a customer-less row rather than dropping it', async () => {
    state.data = [{ full_name: null, revenue: 400 }]
    await expect(fetchTopCustomers(null, null, 5)).resolves.toEqual([{ name: '-', total: 400 }])
  })
})
