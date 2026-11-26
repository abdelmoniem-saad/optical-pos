import { isKnownMethod, paymentsTotal, round2, tenderDeltas, type PaymentLine } from '../../lib/payments'

type T = (key: string) => string

const money = (n: number) => round2(n).toFixed(2)

/** "Refund first", in the shop's language. Since 030 the server never decides
 *  which tender money went back on: a re-checkout that would give money back is
 *  refused until the cashier records the refund from History (tender + reason)
 *  and reopens the invoice. */
export function refundFirstMessage(amount: number, t: T): string {
  return `${t('This change gives money back to the customer:')} ${money(amount)}. ${t('Record the refund in History (on the tender it went back on), then reopen this invoice.')}`
}

/** A failed checkout in the shop's language instead of a raw Postgres message.
 *  The server's guards speak 'reason: detail' (012, 030). */
export function checkoutErrorMessage(e: unknown, t: T): string {
  const err = (e ?? {}) as { message?: string; error_description?: string; details?: string }
  const msg: string =
    err.message || err.error_description || err.details || (typeof e === 'string' ? e : 'Error saving order')
  const short = /^insufficient stock:\s*(.*)$/i.exec(msg)
  if (short) return `${t('Insufficient stock for:')} ${short[1]}`
  const stale = /^price changed:\s*(.*)$/i.exec(msg)
  if (stale) return `${t('Price changed for:')} ${stale[1]}`
  // 030: a payment or refund was recorded (e.g. from History) after this
  // invoice was opened here; re-checking out would reconcile the ledger to
  // tenders that never saw it.
  if (/invoice changed since it was opened/i.test(msg))
    return t('This invoice changed since it was opened (a payment or refund was recorded). Reopen it and try again.')
  // 030: 'refund first: 200.00 of the 1000.00 paid would go back; ...'
  const refund = /^refund first:\s*([\d.]+)/i.exec(msg)
  if (refund) return refundFirstMessage(Number(refund[1]), t)
  if (/^invalid payment method/i.test(msg)) return t('Invalid payment method')
  return msg
}

/** What the server would refuse in a re-checkout, caught before the call (and
 *  so also offline, where a re-checkout is never queued). `saved` is the tender
 *  state this wizard last saw (loaded from the ledger, or what its last
 *  checkout wrote); `next` the clamped lines about to be sent. Null = go on. */
export function recheckoutProblem(
  p: { saved: PaymentLine[]; savedAmountPaid: number; next: PaymentLine[]; canRefund: boolean },
  t: T,
): string | null {
  const back = round2(p.savedAmountPaid - paymentsTotal(p.next))
  if (back > 0.005) return refundFirstMessage(back, t)
  const deltas = tenderDeltas(p.saved, p.next)
  if (deltas.some((d) => d.delta > 0 && !isKnownMethod(d.method))) return t('Invalid payment method')
  if (!p.canRefund && deltas.some((d) => d.delta < 0))
    return t('Moving money from one tender to another is a refund on the first one. You need the refund permission.')
  return null
}
