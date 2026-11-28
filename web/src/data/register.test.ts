import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))

const { parseRegisterStatus } = await import('./register')

/** The owner's "when did the PC last sync" line (design 2.8, owner decision
 *  12) reads register_status() (033). It must never invent a sync time. */
describe('parseRegisterStatus', () => {
  it('reads the last ingest and the pending count the PC reported', () => {
    expect(parseRegisterStatus({ last_ingest_at: '2026-11-27T09:30:00Z', pending_reported: 3 }))
      .toEqual({ lastSyncAt: '2026-11-27T09:30:00Z', pending: 3 })
  })

  it('accepts a one-row array and a numeric string', () => {
    expect(parseRegisterStatus([{ last_ingest_at: '2026-11-27T09:30:00Z', pending_reported: '0' }]))
      .toEqual({ lastSyncAt: '2026-11-27T09:30:00Z', pending: 0 })
  })

  it('falls back to the last contact when nothing was ingested yet', () => {
    expect(parseRegisterStatus({ last_ingest_at: null, last_contact_at: '2026-11-27T08:00:00Z' }))
      .toEqual({ lastSyncAt: '2026-11-27T08:00:00Z', pending: null })
  })

  it('is null for no register row, an empty set or an unknown shape', () => {
    expect(parseRegisterStatus(null)).toBeNull()
    expect(parseRegisterStatus([])).toBeNull()
    expect(parseRegisterStatus({})).toBeNull()
    expect(parseRegisterStatus('x')).toBeNull()
  })
})
