import { describe, expect, it } from 'vitest'
import type { CartLine } from '../../data/sales'
import { addLine, computeTotals, removeLine, setQty } from './pricing'

function line(over: Partial<CartLine> = {}): CartLine {
  return {
    product_id: 'p1',
    qty: 1,
    unit_price: 10,
    total_price: 10,
    name: 'Frame',
    ...over,
  }
}

const noAdj = { discount: 0, amountPaid: 0, grossOverride: null }

describe('computeTotals', () => {
  it('sums the cart when nothing is overridden', () => {
    const t = computeTotals([line(), line({ product_id: 'p2', total_price: 25 })], noAdj)
    expect(t.itemsTotal).toBe(35)
    expect(t.gross).toBe(35)
    expect(t.net).toBe(35)
    expect(t.balance).toBe(35)
  })

  it('returns zeros for an empty cart', () => {
    expect(computeTotals([], noAdj)).toEqual({
      itemsTotal: 0,
      gross: 0,
      discount: 0,
      net: 0,
      amountPaid: 0,
      balance: 0,
    })
  })

  it('uses the gross override instead of the items total', () => {
    const t = computeTotals([line()], { ...noAdj, grossOverride: 80 })
    expect(t.itemsTotal).toBe(10)
    expect(t.gross).toBe(80)
  })

  it('treats an override of 0 as a real price (free order)', () => {
    const t = computeTotals([line()], { ...noAdj, grossOverride: 0 })
    expect(t.gross).toBe(0)
    expect(t.net).toBe(0)
    expect(t.balance).toBe(0)
  })

  it('clamps the discount to the gross', () => {
    const t = computeTotals([line()], { ...noAdj, discount: 500 })
    expect(t.discount).toBe(10)
    expect(t.net).toBe(0)
  })

  it('never lets the discount go negative', () => {
    expect(computeTotals([line()], { ...noAdj, discount: -5 }).discount).toBe(0)
  })

  it('clamps the amount paid to the net and reports a zero balance', () => {
    const t = computeTotals([line()], { ...noAdj, discount: 2, amountPaid: 100 })
    expect(t.net).toBe(8)
    expect(t.amountPaid).toBe(8)
    expect(t.balance).toBe(0)
  })

  it('computes the balance of a partial payment', () => {
    expect(computeTotals([line()], { ...noAdj, amountPaid: 4 }).balance).toBe(6)
  })
})

describe('addLine', () => {
  it('adds a new line priced from sale_price', () => {
    const items = addLine([], { id: 'x', name: 'Lens', sale_price: 12.5 })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      product_id: 'x',
      qty: 1,
      unit_price: 12.5,
      total_price: 12.5,
    })
  })

  it('treats a missing price as 0', () => {
    const items = addLine([], { id: 'x', name: null, sale_price: null })
    expect(items[0].unit_price).toBe(0)
    expect(items[0].total_price).toBe(0)
  })

  it('increments an existing line and re-prices it (immutably)', () => {
    const first = addLine([], { id: 'x', name: 'Lens', sale_price: 10 })
    const second = addLine(first, { id: 'x', name: 'Lens', sale_price: 10 })
    expect(second[0].qty).toBe(2)
    expect(second[0].total_price).toBe(20)
    expect(first[0].qty).toBe(1)
  })
})

describe('setQty', () => {
  it('updates qty and total of the matching line only', () => {
    const items = [line(), line({ product_id: 'p2', unit_price: 5, total_price: 5 })]
    const next = setQty(items, 'p2', 3)
    expect(next.find((i) => i.product_id === 'p2')).toMatchObject({ qty: 3, total_price: 15 })
    expect(next.find((i) => i.product_id === 'p1')?.qty).toBe(1)
  })

  it('floors the quantity at 1', () => {
    expect(setQty([line()], 'p1', 0)[0]).toMatchObject({ qty: 1, total_price: 10 })
  })
})

describe('removeLine', () => {
  it('drops the matching line and keeps the rest', () => {
    const next = removeLine([line(), line({ product_id: 'p2' })], 'p1')
    expect(next.map((i) => i.product_id)).toEqual(['p2'])
  })
})
