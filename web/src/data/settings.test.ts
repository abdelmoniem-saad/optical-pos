import { describe, expect, it, vi } from 'vitest'

/** Settings are per store since 031: the upsert must target (store_id, key).
 *  Upserting on (key) alone would make a second store's "shop_name" collide
 *  with the first store's row instead of getting its own. */
const upsert = vi.fn(async () => ({ error: null }))
vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn(() => ({ upsert })) } }))

const { saveSetting, SETTINGS_CONFLICT } = await import('./settings')

describe('saveSetting (031)', () => {
  it('upserts on (store_id, key), never on the global key', async () => {
    await saveSetting({ key: 'shop_name', value: 'Lensy' })
    expect(SETTINGS_CONFLICT).toBe('store_id,key')
    expect(upsert).toHaveBeenCalledWith({ key: 'shop_name', value: 'Lensy' }, { onConflict: 'store_id,key' })
  })

  it('does not send a store id: the tenant trigger fills the caller\'s own', async () => {
    await saveSetting({ key: 'currency', value: 'EGP' })
    const [row] = upsert.mock.calls.at(-1) as unknown as [Record<string, unknown>]
    expect(row).not.toHaveProperty('store_id')
  })
})
