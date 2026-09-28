import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Invoice numbering is the historically buggiest path (duplicates, padding,
 * legacy non-numeric invoices), so it is tested against a hand-built stand-in
 * for the Supabase client rather than the real one.
 */
const state = vi.hoisted(() => ({
  invoiceRows: [] as { invoice_no: string }[],
  dateRows: [] as { invoice_no: string }[],
  count: 0 as number | null,
  taken: new Set<string>(),
  fail: false,
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => {
      if (state.fail) throw new Error('network down')
      const chain: {
        _order?: string
        _eq?: string
        select: () => unknown
        order: (col: string) => unknown
        limit: () => unknown
        eq: (_col: string, val: string) => unknown
        returns: () => Promise<{ data: { invoice_no: string }[]; error: null }>
        then: (resolve: (v: unknown) => unknown) => unknown
      } = {
        select: () => chain,
        order: (col: string) => {
          chain._order = col
          return chain
        },
        limit: () => chain,
        eq: (_col: string, val: string) => {
          chain._eq = val
          return chain
        },
        returns: () =>
          Promise.resolve({
            data: chain._order === 'invoice_no' ? state.invoiceRows : state.dateRows,
            error: null,
          }),
        then: (resolve: (v: unknown) => unknown) => {
          const result =
            chain._eq !== undefined
              ? {
                  data: state.taken.has(String(chain._eq)) ? [{ id: 'existing' }] : [],
                  error: null,
                }
              : { count: state.count, data: null, error: null }
          return Promise.resolve(result).then(resolve)
        },
      }
      return chain
    },
  },
}))

import { MONEY_COLUMNS, getNextInvoiceNo } from './sales'

beforeEach(() => {
  state.invoiceRows = []
  state.dateRows = []
  state.count = 0
  state.taken = new Set<string>()
  state.fail = false
})

describe('getNextInvoiceNo', () => {
  it('returns the highest numeric invoice + 1, zero-padded to 6 digits', async () => {
    state.invoiceRows = [{ invoice_no: '000042' }]
    await expect(getNextInvoiceNo()).resolves.toBe('000043')
  })

  it('ignores non-numeric legacy invoice numbers', async () => {
    state.invoiceRows = [{ invoice_no: 'INV-7' }, { invoice_no: '000005' }]
    await expect(getNextInvoiceNo()).resolves.toBe('000006')
  })

  it('takes the max across BOTH queries (invoice order and date order)', async () => {
    state.invoiceRows = [{ invoice_no: '000100' }]
    state.dateRows = [{ invoice_no: '000250' }]
    await expect(getNextInvoiceNo()).resolves.toBe('000251')
  })

  it('falls back to the row count when no invoice is numeric', async () => {
    state.invoiceRows = [{ invoice_no: 'A-1' }]
    state.count = 12
    await expect(getNextInvoiceNo()).resolves.toBe('000013')
  })

  it('skips a candidate that already exists (collision retry)', async () => {
    state.invoiceRows = [{ invoice_no: '000010' }]
    state.taken = new Set(['000011'])
    await expect(getNextInvoiceNo()).resolves.toBe('000012')
  })

  // This test used to assert the opposite: that a failed query yields a
  // timestamp-shaped number like '483920'. That fallback minted an invoice
  // number with no relation to the store's sequence, so one dropped
  // connection could write a plausible-looking, permanently wrong number into
  // the ledger - and a duplicate-invoice report would have no trace of where
  // it came from. The contract is now: an undeterminable number is an error,
  // never a guess.
  it('throws rather than inventing a number when the query fails', async () => {
    state.fail = true
    await expect(getNextInvoiceNo()).rejects.toThrow(
      /could not determine the next invoice number/i,
    )
  })

  it('keeps the original error as the cause, for diagnostics', async () => {
    state.fail = true
    // The thrown message is user-facing and generic on purpose; `cause` is
    // where the actual network/PostgREST detail survives for the console.
    await expect(getNextInvoiceNo()).rejects.toThrowError(
      expect.objectContaining({ cause: expect.objectContaining({ message: 'network down' }) }),
    )
  })

  it('does not swallow the failure silently', async () => {
    // Regression guard for the exact bug: any path here that returns a string
    // on total failure is re-introducing the invented number.
    const error = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.fail = true
    await expect(getNextInvoiceNo()).rejects.toThrow()
    // The old code warned AND invented a number. Warning is not enough on its
    // own - the number still reached the database.
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('MONEY_COLUMNS (migration 013 guard contract)', () => {
  it('names exactly the four columns the database refuses a direct write to', () => {
    // guard_sale_money() in 013_void_refunds.sql raises unless the row is not
    // changing one of these. If a fifth money column is ever added to `sales`
    // it must be added here too, or useUpdateSale will send it and the edit
    // will fail at runtime.
    expect([...MONEY_COLUMNS].sort()).toEqual(
      ['amount_paid', 'discount', 'net_amount', 'total_amount'],
    )
  })

  it('is a subset of the Sale columns it claims to protect', () => {
    const saleKeys: readonly string[] = [
      'total_amount',
      'discount',
      'net_amount',
      'amount_paid',
    ]
    for (const k of MONEY_COLUMNS) expect(saleKeys).toContain(k)
  })
})