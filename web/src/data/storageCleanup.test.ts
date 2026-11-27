import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The photo sweep's keep-list (031). It used to be one select of every sale,
 *  capped by PostgREST at 1,000 rows, so live photos past that went missing
 *  from it and were offered for deletion. It is now walked page by page, and
 *  any error fails the scan rather than returning a partial list. */
const rpc = vi.fn()
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }))
vi.mock('../lib/licensing', () => ({ useIsPlatformAdminQuery: vi.fn() }))

const { referencedPaths } = await import('./storageCleanup')

const page = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `store/s/orders/p-${String(from + i).padStart(5, '0')}.jpg` }))

beforeEach(() => rpc.mockReset())

describe('referencedPaths', () => {
  it('walks every page until a short one, passing the last path as the cursor', async () => {
    rpc
      .mockResolvedValueOnce({ data: page(0, 1000), error: null })
      .mockResolvedValueOnce({ data: page(1000, 500), error: null })
    const paths = await referencedPaths('s')
    expect(paths).toHaveLength(1500)
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls[0]).toEqual(['referenced_image_paths', { p_store: 's', p_after: null, p_limit: 1000 }])
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_after: 'store/s/orders/p-00999.jpg' })
  })

  it('asks once more after an exactly full page and stops on the empty one', async () => {
    rpc
      .mockResolvedValueOnce({ data: page(0, 1000), error: null })
      .mockResolvedValueOnce({ data: [], error: null })
    expect(await referencedPaths('s')).toHaveLength(1000)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('throws on an error in any page - never a partial keep-list', async () => {
    rpc
      .mockResolvedValueOnce({ data: page(0, 1000), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'platform admin only' } })
    await expect(referencedPaths('s')).rejects.toMatchObject({ message: 'platform admin only' })
  })
})
