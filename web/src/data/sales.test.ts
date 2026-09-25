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

import { getNextInvoiceNo } from './sales'

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

  it('falls back to a timestamp sequence when the query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.fail = true
    await expect(getNextInvoiceNo()).resolves.toMatch(/^\d{6}$/)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
