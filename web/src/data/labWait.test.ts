import { describe, expect, it, vi } from 'vitest'

/** Dwell-time formatting is a small pure function, and small pure functions are
 *  where "it looks right" hides a wrong threshold. The Lab screen's whole claim
 *  is "this job has been here too long" - a badge that rounds a 13-day job to
 *  "2w" or shows 0 for a negative value would make the screen lie quietly. */
vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))

const { formatWait } = await import('./sales')

describe('formatWait', () => {
  it('shows sub-hour waits as "<1h" rather than "0h"', () => {
    // "0h" reads as "no wait", which is a different claim from "under an hour".
    expect(formatWait(0.4)).toBe('<1h')
  })

  it('shows hours below a day', () => {
    expect(formatWait(1)).toBe('1h')
    expect(formatWait(23.9)).toBe('23h')
  })

  it('switches to days at 24 hours, not at 23', () => {
    // 23.9h is still "today" in any shop's language; 24h is a day behind.
    expect(formatWait(23.99)).toBe('23h')
    expect(formatWait(24)).toBe('1d')
  })

  it('shows days below two weeks', () => {
    expect(formatWait(24 * 6.9)).toBe('6d')
    expect(formatWait(24 * 13.9)).toBe('13d')
  })

  it('switches to weeks at 14 days, matching the red threshold', () => {
    // The WaitBadge turns red at 7 days but changes UNIT at 14. They are
    // deliberately different numbers; if they ever agreed it would be an
    // accident, so the boundary is pinned here.
    expect(formatWait(24 * 13.99)).toBe('13d')
    expect(formatWait(24 * 14)).toBe('2w')
  })

  it('floors rather than rounds, so a job never looks fresher than it is', () => {
    // Rounding 23.6h to "24h" -> "1d" would claim a day has passed an hour early.
    expect(formatWait(23.99)).toBe('23h')
    expect(formatWait(24 * 6.99)).toBe('6d')
  })

  it('returns empty for a value it cannot trust', () => {
    // NaN from a bad RPC answer must not render as a badge at all. An empty
    // string is hidden by WaitBadge; "NaNh" would not be.
    expect(formatWait(NaN)).toBe('')
    expect(formatWait(-5)).toBe('')
    expect(formatWait(Infinity)).toBe('')
  })

  it('handles zero as no wait, which is a real state for a just-started job', () => {
    expect(formatWait(0)).toBe('')
  })
})
