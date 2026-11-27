// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const rpc = vi.fn(async (_fn: string, _args?: any) => ({ data: { id: 's1', invoice_no: 'INV-1' }, error: null }))
vi.mock('./supabase', () => ({
  supabase: {
    rpc: (fn: string, args?: any) => fn === 'next_invoice_no' ? Promise.resolve({ data: 'INV-1', error: null }) : rpc(fn, args),
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('Failed to fetch') }) },
  },
}))

import { QueryClient, dehydrate, hydrate, onlineManager } from '@tanstack/react-query'
import { queryClient } from './queryClient'
import { CHECKOUT_MUTATION_KEY, checkoutOutcomeAfterCall } from './offlineMutations'

const input = {
  customerId: null, userId: null, items: [],
  totals: { total_amount: 100, discount: 0, net_amount: 100, amount_paid: 100 },
  payments: [{ method: 'cash', amount: 100 }],
  idempotencyKey: '11111111-1111-1111-1111-111111111111',
  orderDate: '2026-11-18T20:59:00.000Z',
}

afterEach(() => {
  onlineManager.setOnline(true)
  queryClient.getMutationCache().clear()
  rpc.mockClear()
  vi.useRealTimers()
})

describe('offline checkout replay', () => {
  it('H6: the checkout key has a default mutationFn, so a reloaded queue can run', () => {
    expect(queryClient.getMutationDefaults(CHECKOUT_MUTATION_KEY).mutationFn).toBeTypeOf('function')
  })

  it('H6: a paused checkout persisted by page A is replayed by page B after reload', async () => {
    onlineManager.setOnline(false)
    const pageA = new QueryClient()
    pageA.setMutationDefaults(CHECKOUT_MUTATION_KEY, { networkMode: 'online', mutationFn: async () => ({}) })
    void pageA.getMutationCache().build(pageA, { mutationKey: CHECKOUT_MUTATION_KEY }).execute(input).catch(() => {})
    const persisted = JSON.parse(JSON.stringify(dehydrate(pageA)))
    expect(persisted.mutations).toHaveLength(1)
    hydrate(queryClient, persisted) // page B = the app's real client
    onlineManager.setOnline(true)
    await queryClient.resumePausedMutations()
    const [m] = queryClient.getMutationCache().getAll()
    expect(m.state.error).toBeNull()
    expect(m.state.status).toBe('success')
    expect(rpc).toHaveBeenCalledWith('create_sale_order', expect.objectContaining({ p_idempotency_key: input.idempotencyKey }))
  })

  it('H5: order_date and paid_at are the Finish-click time, not the replay time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-19T09:00:00Z')) // replay next morning
    const fn = queryClient.getMutationDefaults(CHECKOUT_MUTATION_KEY).mutationFn!
    await fn(input as any, {} as any)
    const args = rpc.mock.calls.find((c) => c[0] === 'create_sale_order')![1]
    expect(args.p_sale.order_date).toBe(input.orderDate)
    expect(args.p_payments[0].paid_at).toBe(input.orderDate)
  })
})

describe('checkout outcome (H7)', () => {
  it('offline but never handed to the queue is a failure, not "saved on this device"', () => {
    onlineManager.setOnline(false)
    const qc = new QueryClient()
    expect(checkoutOutcomeAfterCall(qc, input.idempotencyKey).kind).toBe('failed')
  })

  it('an actually paused checkout reports queued', () => {
    onlineManager.setOnline(false)
    const qc = new QueryClient()
    qc.setMutationDefaults(CHECKOUT_MUTATION_KEY, { networkMode: 'online', mutationFn: async () => ({}) })
    void qc.getMutationCache().build(qc, { mutationKey: CHECKOUT_MUTATION_KEY }).execute(input).catch(() => {})
    expect(checkoutOutcomeAfterCall(qc, input.idempotencyKey).kind).toBe('queued')
    // a paused checkout for a DIFFERENT attempt is not this one
    expect(checkoutOutcomeAfterCall(qc, 'another-key').kind).toBe('failed')
  })
})

// loadSale asked for the category of a table that does not exist ('products';
// the catalog is `inventory`), so a reopened invoice always landed on the wrong
// category and every load made a failing request.
describe('table names', () => {
  it("no source file queries .from('products')", () => {
    // vitest runs from web/ (jsdom gives import.meta.url a non-file scheme)
    const root = join(process.cwd(), 'src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') &&
                 /\.from\(\s*['"]products['"]\s*\)/.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
