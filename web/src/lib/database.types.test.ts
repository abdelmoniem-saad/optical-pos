import { describe, expect, it } from 'vitest'
import type { Product, Sale, SaleItem, SalePayment } from './database.types'

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

// Migration 012 additions (kept honest by the same satisfies trick).
const SALE_012 = ['idempotency_key'] as const satisfies readonly (keyof Sale)[]
const PRODUCT_012 = ['stock_qty'] as const satisfies readonly (keyof Product)[]

// Migration 013 additions: voiding is an event on the header, the ledger can
// express money going back, and a line can carry its own discount.
const SALE_013 = [
  'voided_at',
  'voided_by',
  'void_reason',
] as const satisfies readonly (keyof Sale)[]
const SALE_ITEM_013 = [
  'discount',
  'discount_reason',
] as const satisfies readonly (keyof SaleItem)[]
const SALE_PAYMENT_013 = [
  'kind',
  'paid_at',
] as const satisfies readonly (keyof SalePayment)[]

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

  it('012 additions are present (idempotency key, stock read model)', () => {
    expect(SALE_012).toContain('idempotency_key')
    expect(PRODUCT_012).toContain('stock_qty')
  })

  it('013 additions are present (void stamp, line discount, refund kind)', () => {
    for (const k of ['voided_at', 'voided_by', 'void_reason'] as const) {
      expect(SALE_013).toContain(k)
    }
    for (const k of ['discount', 'discount_reason'] as const) {
      expect(SALE_ITEM_013).toContain(k)
    }
    // `kind` is what makes a negative amount meaningful; without it a refund
    // row is indistinguishable from a typo.
    expect(SALE_PAYMENT_013).toContain('kind')
    expect(SALE_PAYMENT_013).toContain('paid_at')
  })
})
