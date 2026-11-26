// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The queued checkout's replay is refused by the server.
const rpc = vi.fn(async (_fn: string, _args?: any) => ({ data: null, error: { message: 'price changed: Frame', code: 'P0001' } }))
vi.mock('./supabase', () => ({
  supabase: {
    rpc: (fn: string, args?: any) => fn === 'next_invoice_no' ? Promise.resolve({ data: 'INV-9', error: null }) : rpc(fn, args),
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}))

import { onlineManager } from '@tanstack/react-query'
import { queryClient, reconcileCheckoutJournal } from './queryClient'
import { CHECKOUT_MUTATION_KEY, findCheckout } from './offlineMutations'
import {
  CHECKOUT_JOURNAL_KEY, dismissJournalEntry, markQueued, markSaved, readJournal, wasQueued,
} from './checkoutJournal'

const input = {
  customerId: null, userId: null, items: [], invoiceNo: '000042',
  totals: { total_amount: 100, discount: 0, net_amount: 100, amount_paid: 100 },
  payments: [{ method: 'cash', amount: 100 }],
  idempotencyKey: '22222222-2222-2222-2222-222222222222',
  orderDate: '2026-11-18T20:59:00.000Z',
}

function queueOne() {
  onlineManager.setOnline(false)
  const m = queryClient.getMutationCache().build(queryClient, { mutationKey: CHECKOUT_MUTATION_KEY, retry: false })
  const p = m.execute(input).catch(() => {})
  return { m, p }
}

afterEach(() => {
  onlineManager.setOnline(true)
  queryClient.getMutationCache().clear()
  window.localStorage.removeItem(CHECKOUT_JOURNAL_KEY)
  rpc.mockClear()
})

describe('checkout journal', () => {
  it('records a checkout the moment it is queued, with its invoice and net', () => {
    queueOne()
    const [e] = readJournal()
    expect(e).toMatchObject({ key: input.idempotencyKey, invoiceNo: '000042', net: 100, status: 'queued' })
  })

  it('a queued checkout the server refuses on replay is kept as failed, with the reason', async () => {
    const { p } = queueOne()
    onlineManager.setOnline(true)
    await queryClient.resumePausedMutations()
    await p
    expect(rpc).toHaveBeenCalled()
    expect(readJournal()[0]).toMatchObject({ status: 'failed', message: 'price changed: Frame' })
    expect(findCheckout(queryClient, input.idempotencyKey)?.state.status).toBe('error')
  })

  it('a queue cleared before it synced (sign-out) is reported lost', () => {
    queueOne()
    queryClient.getMutationCache().clear()
    expect(readJournal()[0].status).toBe('lost')
  })

  it('an entry the restored cache no longer holds is lost on boot; one it holds stays queued', () => {
    markQueued({ key: 'gone' })
    queueOne()
    reconcileCheckoutJournal()
    const byKey = Object.fromEntries(readJournal().map((e) => [e.key, e.status]))
    expect(byKey).toEqual({ gone: 'lost', [input.idempotencyKey]: 'queued' })
  })

  it('a saved sale is forgotten, and dismissing removes an entry', () => {
    markQueued({ key: 'a' })
    markQueued({ key: 'b' })
    markSaved('a')
    expect(wasQueued('a')).toBe(false)
    dismissJournalEntry('b')
    expect(readJournal()).toEqual([])
  })

  it('an online checkout that never queued leaves no entry', async () => {
    const m = queryClient.getMutationCache().build(queryClient, { mutationKey: CHECKOUT_MUTATION_KEY, retry: false })
    await m.execute(input).catch(() => {})
    expect(readJournal()).toEqual([])
  })
})
