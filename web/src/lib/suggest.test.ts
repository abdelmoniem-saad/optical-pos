import { describe, it, expect } from 'vitest'
import { filterOptions, type SuggestOption } from './suggest'

// Ordered as a real lens catalogue would be, with deliberately colliding
// prefixes - the case that motivated ranking starts-with first.
const LENSES: SuggestOption[] = [
  { id: '1', name: 'Single Vision' },
  { id: '2', name: 'Photochromic Blue' },
  { id: '3', name: 'Progressive Standard' },
  { id: '4', name: 'Progressive Premium' },
  { id: '5', name: 'Semi-Rimless' },
  { id: '6', name: 'Blue Light Filter' },
]

const names = (r: SuggestOption[]) => r.map((o) => o.name)

describe('filterOptions', () => {
  it('returns everything for an empty term, preserving catalogue order', () => {
    expect(names(filterOptions(LENSES, ''))).toEqual(names(LENSES))
    expect(names(filterOptions(LENSES, '   '))).toEqual(names(LENSES))
  })

  it('matches case-insensitively', () => {
    expect(names(filterOptions(LENSES, 'PROGRESSIVE'))).toEqual([
      'Progressive Standard',
      'Progressive Premium',
    ])
  })

  it('ranks starts-with matches above merely-contains matches', () => {
    // "Blue" is a fair test of the ranking: it opens "Blue Light Filter" but
    // only occurs mid-name in "Photochromic Blue", which must therefore rank
    // below it even though Photochromic comes first in the catalogue.
    expect(names(filterOptions(LENSES, 'blue'))).toEqual([
      'Blue Light Filter',
      'Photochromic Blue',
    ])
  })

  it('matches mid-name fragments, because people search "chromic"', () => {
    expect(names(filterOptions(LENSES, 'chromic'))).toEqual(['Photochromic Blue'])
    expect(names(filterOptions(LENSES, 'rimless'))).toEqual(['Semi-Rimless'])
  })

  it('is exact substring matching, not fuzzy', () => {
    // "pro" is NOT inside "Photochromic", and "p" is not in "Semi-Rimless".
    // Guarding this stops a future "be lenient" change from quietly widening
    // every result set.
    expect(names(filterOptions(LENSES, 'pro'))).toEqual([
      'Progressive Standard',
      'Progressive Premium',
    ])
  })

  it('keeps catalogue order within each rank group', () => {
    expect(names(filterOptions(LENSES, 'p'))).toEqual([
      'Photochromic Blue',
      'Progressive Standard',
      'Progressive Premium',
    ])
  })

  it('returns nothing when there is no match, so the popup stays closed', () => {
    expect(filterOptions(LENSES, 'titanium')).toEqual([])
  })

  it('handles an empty catalogue without throwing', () => {
    expect(filterOptions([], 'pro')).toEqual([])
  })

  it('does not mutate or alias the input list', () => {
    const out = filterOptions(LENSES, '')
    expect(out).not.toBe(LENSES)
    expect(LENSES).toHaveLength(6)
  })
})
