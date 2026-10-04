import { describe, it, expect } from 'vitest'
import { buildPlatformReport, toNumber, EMPTY_REPORT } from '../lib/platformReportShape'

const row = (over: Record<string, unknown> = {}) => ({
  store_id: 's1',
  store_name: 'Cairo',
  time_zone: 'Africa/Cairo',
  is_active: true,
  from_at: '2026-09-19T21:00:00Z',
  to_at: '2026-09-20T21:00:00Z',
  revenue: 1000,
  paid: 1300,
  order_count: 3,
  ...over,
})

describe('toNumber', () => {
  it('accepts both shapes Postgres numeric arrives in', () => {
    // PostgREST returns numeric as a number on some paths and a string on
    // others; treating only one of them silently zeroes a store.
    expect(toNumber(1500)).toBe(1500)
    expect(toNumber('1500.25')).toBe(1500.25)
  })

  it('reads an absent figure as zero rather than NaN', () => {
    expect(toNumber(null)).toBe(0)
    expect(toNumber(undefined)).toBe(0)
    expect(toNumber('')).toBe(0)
    expect(toNumber('not a number')).toBe(0)
  })
})

describe('buildPlatformReport (pure shaping)', () => {
  it('totals the rows it was given', () => {
    const r = buildPlatformReport([
      row({ store_id: 'a', store_name: 'Cairo', revenue: 1500, paid: 1300, order_count: 3 }),
      row({ store_id: 'b', store_name: 'UTC', time_zone: 'UTC', revenue: 2000, paid: 2000, order_count: 1 }),
    ])
    expect(r.totals).toEqual({ revenue: 3500, paid: 3300, orders: 4, stores: 2 })
    expect(r.inDatabase).toBe(true)
  })

  // The total must be the arithmetic of the column above it. A separately
  // fetched total can disagree with its own parts without anything failing.
  it('the total is exactly the sum of the rows', () => {
    const rows = [row({ revenue: 111 }), row({ store_id: 'b', revenue: 222 }), row({ store_id: 'c', revenue: 333 })]
    const r = buildPlatformReport(rows)
    const manual = rows.reduce((a, x) => a + Number(x.revenue), 0)
    expect(r.totals.revenue).toBe(manual)
  })

  it('keeps a shop that sold nothing as a row of zeros', () => {
    // 008 seeds a 'Main Store', so a real database has stores with no sales.
    // A vendor needs "sold nothing" to be different from "no such shop".
    const r = buildPlatformReport([row({ revenue: 0, paid: 0, order_count: 0 })])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].revenue).toBe(0)
    expect(r.totals.stores).toBe(1)
  })

  it('treats a non-array payload as no rows rather than throwing', () => {
    const r = buildPlatformReport(null)
    expect(r.rows).toEqual([])
    expect(r.totals.revenue).toBe(0)
  })

  it('does not alias EMPTY_REPORT, so one caller cannot poison another', () => {
    const a = buildPlatformReport([row()])
    const b = buildPlatformReport([])
    a.rows[0].revenue = 999
    expect(b.rows).toHaveLength(0)
    expect(EMPTY_REPORT.rows).toHaveLength(0)
  })

  it('defaults a missing zone to UTC rather than rendering blank', () => {
    const r = buildPlatformReport([row({ time_zone: null })])
    expect(r.rows[0].time_zone).toBe('UTC')
  })
})
