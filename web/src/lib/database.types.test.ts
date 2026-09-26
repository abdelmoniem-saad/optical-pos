import { describe, expect, it } from 'vitest'
import type { Sale, SaleItem, SalePayment } from './database.types'

/**
 * Phase 0 gate: `database.types.ts` is hand-maintained (see its header), so
 * nothing else stops it drifting from the real schema. These lists are checked
 * with `satisfies readonly (keyof T)[]`, which FAILS `tsc -b` — the CI step —
 * the moment a money-critical column disappears from an interface.
 *
 * Covers every column of the payment ledger added by 011_sale_payments.sql.
 */

const SALE_PAYMENT_011 = [
  'id',
  'sale_id',
  'amount',
  'method',
  'note',
  'paid_at',
  'recorded_by',
  'store_id',
  'created_at',
] as const satisfies readonly (keyof SalePayment)[]

const SALE_MONEY = [
  'id',
  'invoice_no',
  'total_amount',
  'discount',
  'net_amount',
  'amount_paid',
  'order_date',
] as const satisfies readonly (keyof Sale)[]

const SALE_ITEM_MONEY = [
  'sale_id',
  'product_id',
  'qty',
  'unit_price',
  'total_price',
] as const satisfies readonly (keyof SaleItem)[]

describe('database.types coverage (Phase 0 gate)', () => {
  it('SalePayment covers every 011 sale_payments column', () => {
    expect(SALE_PAYMENT_011).toContain('paid_at')
    expect(SALE_PAYMENT_011).toContain('recorded_by')
    expect(SALE_PAYMENT_011).toContain('store_id')
    expect(new Set(SALE_PAYMENT_011).size).toBe(SALE_PAYMENT_011.length)
  })

  it('Sale and SaleItem cover the money columns checkout writes', () => {
    for (const k of ['total_amount', 'discount', 'net_amount', 'amount_paid'] as const) {
      expect(SALE_MONEY).toContain(k)
    }
    for (const k of ['qty', 'unit_price', 'total_price'] as const) {
      expect(SALE_ITEM_MONEY).toContain(k)
    }
  })
})
