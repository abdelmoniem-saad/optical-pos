import { describe, expect, it } from 'vitest'
import {
  clampPaymentLines,
  legacyMethodKey,
  methodLabelKey,
  methodSummary,
  normalizeLines,
  paymentsTotal,
  removeLine,
  round2,
  setLine,
  upsertLine,
} from './payments'

describe('paymentsTotal', () => {
  it('is 0 for no lines', () => {
    expect(paymentsTotal([])).toBe(0)
  })

  it('sums split tenders', () => {
    expect(
      paymentsTotal([
        { method: 'cash', amount: 600 },
        { method: 'instapay', amount: 400 },
      ]),
    ).toBe(1000)
  })

  it('never leaks float noise', () => {
    expect(
      paymentsTotal([
        { method: 'cash', amount: 0.1 },
        { method: 'wallet', amount: 0.2 },
      ]),
    ).toBe(0.3)
  })
})

describe('normalizeLines', () => {
  it('merges duplicate methods (case/space-insensitive)', () => {
    const out = normalizeLines([
      { method: 'Cash', amount: 100 },
      { method: ' cash ', amount: 250 },
    ])
    expect(out).toEqual([{ method: 'cash', amount: 350 }])
  })

  it('drops zero, negative and non-finite amounts', () => {
    expect(
      normalizeLines([
        { method: 'cash', amount: 0 },
        { method: 'wallet', amount: -5 },
        { method: 'instapay', amount: Number.NaN },
        { method: 'cash', amount: 10 },
      ]),
    ).toEqual([{ method: 'cash', amount: 10 }])
  })
})

describe('setLine', () => {
  it('adds a new line', () => {
    expect(setLine([], 'wallet', 300)).toEqual([{ method: 'wallet', amount: 300 }])
  })

  it('replaces an existing line instead of adding a second one', () => {
    expect(
      setLine(
        [
          { method: 'cash', amount: 100 },
          { method: 'wallet', amount: 200 },
        ],
        'cash',
        500,
      ),
    ).toEqual([
      { method: 'wallet', amount: 200 },
      { method: 'cash', amount: 500 },
    ])
  })

  it('removes the line when the amount is 0 or negative', () => {
    expect(
      setLine(
        [
          { method: 'cash', amount: 100 },
          { method: 'wallet', amount: 200 },
        ],
        'cash',
        0,
      ),
    ).toEqual([{ method: 'wallet', amount: 200 }])
  })
})

describe('removeLine', () => {
  it('removes only the requested method (any casing)', () => {
    expect(
      removeLine(
        [
          { method: 'cash', amount: 100 },
          { method: 'instapay', amount: 200 },
        ],
        'INSTAPAY',
      ),
    ).toEqual([{ method: 'cash', amount: 100 }])
  })
})

describe('upsertLine (mid-edit input rows)', () => {
  it('keeps a 0-amount line so the input being typed in does not vanish', () => {
    expect(upsertLine([], 'cash', 0)).toEqual([{ method: 'cash', amount: 0 }])
  })

  it('replaces the row for the same method instead of appending', () => {
    expect(
      upsertLine(
        [
          { method: 'cash', amount: 100 },
          { method: 'wallet', amount: 50 },
        ],
        'cash',
        250,
      ),
    ).toEqual([
      { method: 'wallet', amount: 50 },
      { method: 'cash', amount: 250 },
    ])
  })

  it('never allows a negative amount', () => {
    expect(upsertLine([], 'wallet', -30)).toEqual([{ method: 'wallet', amount: 0 }])
  })
})

describe('clampPaymentLines', () => {
  it('keeps lines untouched when they fit', () => {
    const lines = [
      { method: 'cash', amount: 300 },
      { method: 'wallet', amount: 200 },
    ]
    expect(clampPaymentLines(lines, 1000)).toEqual(lines)
  })

  it('trims from the END so the first tender is honored first', () => {
    expect(
      clampPaymentLines(
        [
          { method: 'cash', amount: 600 },
          { method: 'instapay', amount: 500 },
        ],
        1000,
      ),
    ).toEqual([
      { method: 'cash', amount: 600 },
      { method: 'instapay', amount: 400 },
    ])
  })

  it('drops lines that no longer fit and never exceeds the cap', () => {
    const out = clampPaymentLines(
      [
        { method: 'cash', amount: 800 },
        { method: 'wallet', amount: 300 },
      ],
      800,
    )
    expect(out).toEqual([{ method: 'cash', amount: 800 }])
    expect(paymentsTotal(out)).toBeLessThanOrEqual(800)
  })

  it('yields nothing when the cap is 0 (fully unpaid order)', () => {
    expect(clampPaymentLines([{ method: 'cash', amount: 500 }], 0)).toEqual([])
  })
})

describe('methodSummary / legacyMethodKey (legacy sales.payment_method)', () => {
  it('defaults to Cash when nothing was paid', () => {
    expect(methodSummary([])).toBe('Cash')
  })

  it('joins unique methods in order', () => {
    expect(
      methodSummary([
        { method: 'cash', amount: 100 },
        { method: 'instapay', amount: 50 },
        { method: 'cash', amount: 25 },
      ]),
    ).toBe('Cash + InstaPay')
  })

  it('passes unknown future methods through', () => {
    expect(methodSummary([{ method: 'card', amount: 10 }])).toBe('card')
  })

  it('maps legacy free-text values to canonical keys', () => {
    expect(legacyMethodKey(null)).toBe('cash')
    expect(legacyMethodKey('')).toBe('cash')
    expect(legacyMethodKey('Cash')).toBe('cash')
    expect(legacyMethodKey(' InstaPay ')).toBe('instapay')
    expect(legacyMethodKey('كاش')).toBe('كاش')
  })
})

describe('methodLabelKey (i18n)', () => {
  it('maps canonical keys to translation keys', () => {
    expect(methodLabelKey('cash')).toBe('Cash')
    expect(methodLabelKey('wallet')).toBe('Wallet')
    expect(methodLabelKey('instapay')).toBe('InstaPay')
  })

  it('passes unknown methods through', () => {
    expect(methodLabelKey('card')).toBe('card')
  })
})

describe('round2', () => {
  it('rounds to cents', () => {
    expect(round2(10.005)).toBe(10.01)
    expect(round2(10.004)).toBe(10)
  })
})
