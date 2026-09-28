import { describe, expect, it } from 'vitest'
import { computeReport, isLive } from './computeReport'
import type { Customer, Product, Sale } from '../../lib/database.types'

/**
 * The bug these guard against: `void_sale` stamps `voided_at` and deliberately
 * LEAVES the money columns intact, so a report that sums `net_amount` without
 * excluding voided rows counts a void as revenue. Voiding a 5,000 EGP invoice
 * made the shop look 5,000 richer.
 */
function sale(over: Partial<Sale> = {}): Sale {
  return {
    id: over.id ?? crypto.randomUUID(),
    invoice_no: '0001',
    total_amount: 0,
    discount: 0,
    net_amount: 0,
    amount_paid: 0,
    order_date: '2026-09-28T12:00:00Z',
    customer_id: null,
    ...over,
  } as Sale
}

const NOW = new Date('2026-09-28T20:00:00Z')
const customers: Customer[] = [
  { id: 'c1', name: 'Ahmed' },
  { id: 'c2', name: 'Mona' },
] as Customer[]
const products: Product[] = [] as Product[]

describe('isLive', () => {
  it('treats a row with no void as live', () => {
    expect(isLive({ voided_at: null })).toBe(true)
    expect(isLive({ voided_at: undefined })).toBe(true)
  })

  it('treats a voided row as not live', () => {
    expect(isLive({ voided_at: '2026-09-28T13:00:00Z' })).toBe(false)
  })
})

describe('computeReport excludes voided sales', () => {
  const live = sale({ id: 'live', net_amount: 1000, amount_paid: 1000, customer_id: 'c1' })
  const voided = sale({
    id: 'void',
    net_amount: 5000,
    amount_paid: 0,
    customer_id: 'c2',
    voided_at: '2026-09-28T13:00:00Z',
  })

  it('counts revenue from live sales only', () => {
    const r = computeReport([live, voided], customers, products, 'all', NOW)
    expect(r.totalRevenue).toBe(1000)
    expect(r.totalPaid).toBe(1000)
    expect(r.balanceDue).toBe(0)
    expect(r.orderCount).toBe(1)
  })

  it('does not let a void inflate the balance due', () => {
    const r = computeReport([live, voided], customers, products, 'all', NOW)
    // The real failure mode: revenue 6000, paid 1000, "5000 owed" that nobody owes.
    expect(r.balanceDue).not.toBe(5000)
  })

  it('reports the void rather than hiding it', () => {
    const r = computeReport([live, voided], customers, products, 'all', NOW)
    expect(r.voidedCount).toBe(1)
    expect(r.voidedNet).toBe(5000)
  })

  it('keeps a voided sale out of the top customers', () => {
    const r = computeReport([live, voided], customers, products, 'all', NOW)
    expect(r.topCustomers.map((c) => c.name)).toEqual(['Ahmed'])
  })

  it('keeps a voided sale out of the lab counters', () => {
    const voidedInLab = sale({ id: 'v2', net_amount: 100, lab_status: 'Ready', voided_at: '2026-09-28T13:00:00Z' })
    const r = computeReport([live, voidedInLab], customers, products, 'all', NOW)
    expect(r.readyLab).toBe(0)
    expect(r.pendingLab).toBe(0)
  })

  it('a voided sale does not count toward today either', () => {
    const r = computeReport([sale({ id: 'v3', net_amount: 900, voided_at: '2026-09-28T13:00:00Z' })], customers, products, 'today', NOW)
    expect(r.todayRevenue).toBe(0)
    expect(r.todayOrders).toBe(0)
  })
})

describe('computeReport is unchanged for the ordinary case', () => {
  it('sums revenue, paid and balance across live sales', () => {
    const r = computeReport(
      [
        sale({ id: 'a', net_amount: 300, amount_paid: 300, customer_id: 'c1' }),
        sale({ id: 'b', net_amount: 200.5, amount_paid: 100, customer_id: 'c2' }),
      ],
      customers,
      products,
      'all',
      NOW,
    )
    expect(r.totalRevenue).toBe(500.5)
    expect(r.totalPaid).toBe(400)
    expect(r.balanceDue).toBe(100.5)
    expect(r.orderCount).toBe(2)
    expect(r.voidedCount).toBe(0)
  })

  it('ranks the top customers by revenue', () => {
    const r = computeReport(
      [
        sale({ id: 'a', net_amount: 100, customer_id: 'c1' }),
        sale({ id: 'b', net_amount: 900, customer_id: 'c2' }),
      ],
      customers,
      products,
      'all',
      NOW,
    )
    expect(r.topCustomers.map((c) => c.name)).toEqual(['Mona', 'Ahmed'])
  })

  it('lists low stock', () => {
    const r = computeReport([], customers, [{ id: 'p', name: 'Frame', stock_qty: 2 } as Product], 'all', NOW)
    expect(r.lowStock).toHaveLength(1)
  })
})
