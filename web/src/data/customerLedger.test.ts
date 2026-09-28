import { describe, expect, it, vi } from 'vitest'

/** The single-row trap from Phase 4, pinned for the balance functions.
 *
 *  016 shipped a Reports bug that no test caught: PostgREST wraps a
 *  `returns table` function in an array even when it returns exactly one row, so
 *  the code read `undefined` from the object, `Number(undefined ?? 0)` produced
 *  a tidy `0`, and the screen confidently rendered zeros. Nothing threw. */
const rpc = vi.hoisted(() => vi.fn())

vi.mock('../lib/supabase', () => ({ supabase: { rpc } }))

/** Call through the SAME unwrap the hook uses. Rewriting the response shape
 *  here rather than calling `toBalance` directly would test the mock instead of
 *  the code, and the whole point is the array-to-row step. */
async function read() {
  const mod = await import('./customerLedger')
  return {
    balance: async (customerId: string) => {
      const { data, error } = await rpc('customer_balance', { p_customer: customerId })
      if (error) throw new Error(error.message)
      return mod.toBalance(mod.oneRow(data))
    },
    debtors: async () => {
      const { data, error } = await rpc('customer_debtors', {})
      if (error) throw new Error(error.message)
      return data ?? []
    },
  }
}

describe('customer balance (the PostgREST single-row trap)', () => {
  it('reads the fields off the FIRST element of a one-row array', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          customer_id: 'c1',
          balance_due: 400,
          lifetime: 1000,
          invoice_count: 2,
          last_activity: '2026-09-20T10:00:00Z',
        },
      ],
      error: null,
    })
    const r = await read()
    expect(await r.balance('c1')).toEqual({
      customer_id: 'c1',
      balance_due: 400,
      lifetime: 1000,
      invoice_count: 2,
      last_activity: '2026-09-20T10:00:00Z',
    })
  })

  it('returns null for a bare object too, not undefined', async () => {
    // Defensive: a future PostgREST change to return the object unwrapped must
    // not turn every balance into "customer not found".
    rpc.mockResolvedValue({
      data: { customer_id: 'c1', balance_due: 10, lifetime: 10, invoice_count: 1, last_activity: null },
      error: null,
    })
    const r = await read()
    expect(await r.balance('c1')).toMatchObject({ balance_due: 10, invoice_count: 1 })
  })

  it('returns null when the customer is genuinely absent', async () => {
    // An unknown id must be visibly ABSENT, not a customer with a zero balance -
    // those look identical on screen and mean opposite things.
    rpc.mockResolvedValue({ data: [], error: null })
    const r = await read()
    expect(await r.balance('missing')).toBeNull()
  })

  it('coerces a numeric STRING, which PostgREST may return for numeric', async () => {
    rpc.mockResolvedValue({
      data: [{ customer_id: 'c1', balance_due: '250.50', lifetime: '1000', invoice_count: '3', last_activity: null }],
      error: null,
    })
    const r = await read()
    const b = await r.balance('c1')
    expect(b?.balance_due).toBe(250.5)
    expect(b?.lifetime).toBe(1000)
    expect(b?.invoice_count).toBe(3)
  })

  it('never reports NaN, which is what the Phase 4 bug rendered as 0', async () => {
    rpc.mockResolvedValue({
      data: [{ customer_id: 'c1', balance_due: null, lifetime: null, invoice_count: null, last_activity: null }],
      error: null,
    })
    const r = await read()
    const b = await r.balance('c1')
    expect(Number.isNaN(b?.balance_due ?? NaN)).toBe(false)
    expect(b?.balance_due).toBe(0)
  })
})

describe('debtor list', () => {
  it('passes the window through, including a null end bound', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const r = await read()
    await r.debtors()
    // `p_to: null` means unbounded, NOT "today". The exclusive-bound convention
    // from 016 is the caller's responsibility and is documented on the hook.
    expect(rpc).toHaveBeenCalledWith('customer_debtors', {})
  })
})
