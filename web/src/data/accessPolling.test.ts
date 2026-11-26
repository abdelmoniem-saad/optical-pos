// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'

// The access reads used to poll every 15 s for as long as a tab was visible
// (about 2,880 calls a day per open register). Enforcement lives in the
// database (029: resolve_can / auth_store_id read the live state on every
// call), so the UI only needs to refresh on load, navigation, tab return,
// reconnect and - the replacement for the poll - any server denial.
const m = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: { is_admin: false, active: true, assigned: true, codes: ['pos.view'] }, error: null })),
  maybeSingle: vi.fn(async () => ({ data: { id: 'u1', is_active: true, roles: { name: 'Seller' } }, error: null })),
}))
vi.mock('../lib/supabase', () => ({
  supabase: { rpc: m.rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: m.maybeSingle }) }) }) },
}))
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import { myPermissionsQuery, ACCESS_STALE_MS, effectiveReady } from './permissions'
import { currentUserQuery } from './staff'

afterEach(() => {
  vi.useRealTimers()
  m.rpc.mockClear()
  m.maybeSingle.mockClear()
})

describe('access reads do not poll', () => {
  it('my_permissions is fetched once, not every 15 s, while a visible tab idles 10 min', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    const unsub = new QueryObserver(qc, myPermissionsQuery('u1')).subscribe(() => {})
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(m.rpc).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('current-user is fetched once while Notes/Staff stays open 10 min', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    const unsub = new QueryObserver(qc, currentUserQuery('u1')).subscribe(() => {})
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(m.maybeSingle).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('options keep the security refreshes but drop the interval', () => {
    const o = myPermissionsQuery('u1')
    expect(o.refetchInterval).toBeFalsy()
    expect(o.staleTime).toBe(ACCESS_STALE_MS)
    expect(ACCESS_STALE_MS).toBeGreaterThanOrEqual(5 * 60_000)
    expect(o.refetchOnWindowFocus).toBe(true) // stale-respecting, not 'always'
    expect(o.refetchOnReconnect).toBe(true)
    expect(currentUserQuery('u1').refetchInterval).toBeFalsy()
  })

  it('a denial from the server refreshes access immediately (replaces the poll)', async () => {
    const { queryClient } = await import('../lib/queryClient')
    queryClient.setQueryData(['my-permissions', 'u1'], { is_admin: false, active: true, assigned: true, codes: ['pos.view'] })
    queryClient.setQueryData(['current-user', 'u1'], { id: 'u1' })
    const mut = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => { throw Object.assign(new Error('insufficient permission'), { code: '42501' }) },
    })
    await mut.execute(undefined).catch(() => {})
    expect(queryClient.getQueryState(['my-permissions', 'u1'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['current-user', 'u1'])?.isInvalidated).toBe(true)
  })

  it('one failed refetch keeps the last good access instead of locking the till', () => {
    const v = { active: true, assigned: true, is_admin: false, codes: ['pos.view'] }
    expect(effectiveReady(v, { isError: false, errorCode: undefined })).toBe(true)
    expect(effectiveReady(v, { isError: true, errorCode: undefined })).toBe(true) // network blip
    expect(effectiveReady(v, { isError: true, errorCode: '42501' })).toBe(false) // real denial
    expect(effectiveReady({ ...v, active: false }, { isError: false, errorCode: undefined })).toBe(false)
    expect(effectiveReady(undefined, { isError: true, errorCode: undefined })).toBe(false)
  })
})
