import { describe, expect, it } from 'vitest'
import { checkoutErrorMessage, recheckoutProblem, refundFirstMessage } from './checkoutErrors'

// Identity "translation": the tests read the English keys.
const t = (k: string) => k

describe('checkoutErrorMessage (030 server errors)', () => {
  it("turns 'refund first' into a how-to keeping the amount", () => {
    const msg = checkoutErrorMessage({
      message: 'refund first: 200.00 of the 1000.00 paid would go back; record the refund from History, then reopen the invoice',
    }, t)
    expect(msg).toBe(refundFirstMessage(200, t))
    expect(msg).toContain('200.00')
    expect(msg).toContain('History')
  })

  it('translates the stale-invoice and invalid-method refusals', () => {
    expect(checkoutErrorMessage({ message: 'invoice changed since it was opened; reload it' }, t))
      .toMatch(/^This invoice changed since it was opened/)
    expect(checkoutErrorMessage({ message: 'Invalid payment method' }, t)).toBe('Invalid payment method')
  })

  it('keeps the 012 guards and passes anything else through', () => {
    expect(checkoutErrorMessage({ message: 'insufficient stock: Frame X' }, t)).toBe('Insufficient stock for: Frame X')
    expect(checkoutErrorMessage({ message: 'price changed: Lens' }, t)).toBe('Price changed for: Lens')
    expect(checkoutErrorMessage({ message: 'something else' }, t)).toBe('something else')
    expect(checkoutErrorMessage(null, t)).toBe('Error saving order')
  })
})

describe('recheckoutProblem (caught before the server)', () => {
  const saved = [{ method: 'cash', amount: 1000 }]

  it('lowering what was paid (an item removed from a paid invoice) is refund first', () => {
    expect(recheckoutProblem({ saved, savedAmountPaid: 1000, next: [{ method: 'cash', amount: 800 }], canRefund: true }, t))
      .toBe(refundFirstMessage(200, t))
  })

  it('an unchanged or higher tender list goes on', () => {
    expect(recheckoutProblem({ saved, savedAmountPaid: 1000, next: saved, canRefund: false }, t)).toBeNull()
    expect(recheckoutProblem({
      saved: [{ method: 'cash', amount: 600 }], savedAmountPaid: 600,
      next: [{ method: 'cash', amount: 600 }, { method: 'card', amount: 200 }], canRefund: false,
    }, t)).toBeNull()
  })

  it('moving money off a tender needs history.refund', () => {
    const p = { saved, savedAmountPaid: 1000, next: [{ method: 'cash', amount: 600 }, { method: 'card', amount: 400 }] }
    expect(recheckoutProblem({ ...p, canRefund: false }, t)).toMatch(/refund permission/)
    expect(recheckoutProblem({ ...p, canRefund: true }, t)).toBeNull()
  })

  it('a legacy tender takes no new money', () => {
    expect(recheckoutProblem({
      saved: [{ method: 'cash + instapay', amount: 500 }], savedAmountPaid: 500,
      next: [{ method: 'cash + instapay', amount: 1000 }], canRefund: true,
    }, t)).toBe('Invalid payment method')
  })
})
