import { describe, expect, it, vi } from 'vitest'

// zreport.ts reaches the Supabase client through its imports, and that client
// throws at import time when the env is absent - which it always is in CI. The
// same mock reportRpc.test.ts uses, so the pure helpers below can be tested
// without a network or a project.
vi.mock('../lib/supabase', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}))

import { computeVariance, parseCountedCash, varianceVerdict } from './zreport'

/**
 * The pure half of the day-close screen. The parts that matter are the ones
 * where a wrong answer would look like a fact about the business rather than a
 * bug: an empty box that reads as zero cash counted, and a rounding artefact
 * that reads as a discrepancy.
 */
describe('parseCountedCash', () => {
  it('reads a plain amount', () => {
    expect(parseCountedCash('1100')).toBe(1100)
    expect(parseCountedCash('1050.50')).toBe(1050.5)
  })

  it('tolerates surrounding whitespace, which a pasted figure brings', () => {
    expect(parseCountedCash('  250  ')).toBe(250)
  })

  it('treats an EMPTY box as "not counted yet", never as zero', () => {
    // This is the load-bearing case. Reading empty as 0 would produce a variance
    // equal to the whole expected total and put a catastrophic-looking shortfall
    // on screen for someone who has simply not counted yet.
    expect(parseCountedCash('')).toBeNull()
    expect(parseCountedCash('   ')).toBeNull()
  })

  it('refuses text rather than coercing it to a number', () => {
    expect(parseCountedCash('abc')).toBeNull()
    expect(parseCountedCash('10.5.5')).toBeNull()
    expect(parseCountedCash('-')).toBeNull()
  })

  it('keeps two decimal places, because money is stored at 2dp', () => {
    expect(parseCountedCash('10.005')).toBe(10.01)
    expect(parseCountedCash('10.004')).toBe(10)
  })
})

describe('computeVariance', () => {
  it('is counted MINUS expected, so a shortfall is negative', () => {
    // The sign is the direction a shop reads without thinking about it. The
    // opposite convention makes every over-report look like a loss.
    expect(computeVariance(1050, 1100)).toBe(-50)
    expect(computeVariance(1150, 1100)).toBe(50)
    expect(computeVariance(1100, 1100)).toBe(0)
  })

  it('is null until something has been counted', () => {
    expect(computeVariance(null, 1100)).toBeNull()
  })

  it('rounds to two places so a decimal cannot leak into the ledger view', () => {
    expect(computeVariance(1100.005, 1100)).toBe(0.01)
  })
})

describe('varianceVerdict', () => {
  it('calls a cent-level difference balanced', () => {
    // Rounding to 2dp can produce a fraction of a cent that is not a discrepancy
    // worth showing anyone.
    expect(varianceVerdict(0)).toBe('balanced')
    expect(varianceVerdict(0.004)).toBe('balanced')
    expect(varianceVerdict(-0.004)).toBe('balanced')
  })

  it('separates short from over', () => {
    expect(varianceVerdict(-50)).toBe('short')
    expect(varianceVerdict(50)).toBe('over')
  })

  it('is unknown before anything is counted', () => {
    expect(varianceVerdict(null)).toBe('unknown')
  })
})
