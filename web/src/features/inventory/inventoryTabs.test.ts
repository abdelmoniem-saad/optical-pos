import { describe, expect, it } from 'vitest'
import { resolveTab } from './tabs'

/**
 * The tab is chosen by the URL, so every value that is not exactly 'optical'
 * has to land somewhere sensible. Getting this wrong does not throw - it shows
 * the wrong screen - which is the kind of failure nobody reports.
 *
 * Tested through ./tabs rather than through InventoryPage on purpose: importing
 * the page pulls in react-query, the Supabase client and window, and this test
 * needs none of them.
 */
describe('resolveTab', () => {
  it('honours the optical tab', () => {
    expect(resolveTab('optical')).toBe('optical')
  })

  it('defaults to products when no tab is given', () => {
    // The load-bearing case: every existing /inventory link has no ?tab, and
    // all of them must keep opening the stock list.
    expect(resolveTab(null)).toBe('products')
  })

  it('falls back to products for anything unrecognised', () => {
    // A mistyped or stale ?tab= should show the stock list, not a blank page.
    expect(resolveTab('optical')).toBe('optical')
    expect(resolveTab('Optical')).toBe('products')
    expect(resolveTab('OPTICAL')).toBe('products')
    expect(resolveTab('optics')).toBe('products')
    expect(resolveTab('')).toBe('products')
    expect(resolveTab('settings')).toBe('products')
  })
})
