/**
 * Payment tenders and the pure helpers that shape them (unit-tested).
 *
 * A shop takes the SAME order in several tenders (e.g. 600 cash + 400
 * InstaPay) and may collect the remainder later in a third tender. The ledger
 * table (migration 011, `sale_payments`) stores one row per money received;
 * these helpers normalize what the UI edits and what checkout sends.
 *
 * `method` is free text in the DB so a future tender (e.g. 'card') is a
 * one-line addition to PAYMENT_METHODS - no migration needed.
 */

export const PAYMENT_METHODS = ['cash', 'wallet', 'instapay'] as const
export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number]

export type PaymentLine = { method: string; amount: number }

/** 2-decimal money rounding - floats never leak into the ledger. */
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Sum of the lines (raw, unclamped - clamping to the payable happens later). */
export function paymentsTotal(lines: PaymentLine[]): number {
  return round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0))
}

/** Canonical key: trim + lowercase, so 'Cash ' and 'cash' are one line. */
function keyOf(method: string): string {
  return (method || 'cash').trim().toLowerCase()
}

/** Merge duplicate methods, drop <= 0 / non-finite amounts, round to cents. */
export function normalizeLines(lines: PaymentLine[]): PaymentLine[] {
  const out: PaymentLine[] = []
  for (const l of lines) {
    const amt = Number(l.amount)
    if (!Number.isFinite(amt) || amt <= 0) continue
    const method = keyOf(l.method)
    const prev = out.find((x) => x.method === method)
    if (prev) prev.amount = round2(prev.amount + amt)
    else out.push({ method, amount: round2(amt) })
  }
  return out
}

/** Set one method's amount (<= 0 / NaN removes its line). Duplicates merge. */
export function setLine(lines: PaymentLine[], method: string, amount: number): PaymentLine[] {
  const key = keyOf(method)
  const rest = lines.filter((l) => keyOf(l.method) !== key)
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) return normalizeLines(rest)
  return normalizeLines([...rest, { method: key, amount: amt }])
}

/** Drop one method's line, keep the rest. */
export function removeLine(lines: PaymentLine[], method: string): PaymentLine[] {
  const key = keyOf(method)
  return normalizeLines(lines.filter((l) => keyOf(l.method) !== key))
}

/** Upsert one line, KEEPING a 0 amount so an input being edited doesn't vanish
 *  mid-typing; zeros are dropped later by normalize/clamp at checkout. */
export function upsertLine(lines: PaymentLine[], method: string, amount: number): PaymentLine[] {
  const key = keyOf(method)
  const amt = Number(amount)
  const safe = Number.isFinite(amt) ? Math.max(0, round2(amt)) : 0
  return [...lines.filter((l) => keyOf(l.method) !== key), { method: key, amount: safe }]
}

/**
 * Fit the lines inside `max` (never overpay): keep order, trim from the END,
 * drop whatever no longer fits. Result always sums to <= max. Used so the
 * ledger can never disagree with the clamped `amount_paid` the pricing code
 * computes.
 */
export function clampPaymentLines(lines: PaymentLine[], max: number): PaymentLine[] {
  let remaining = Math.max(0, round2(Number(max) || 0))
  const out: PaymentLine[] = []
  for (const l of normalizeLines(lines)) {
    if (remaining <= 0) break
    const amt = Math.min(l.amount, remaining)
    out.push({ method: l.method, amount: round2(amt) })
    remaining = round2(remaining - amt)
  }
  return out
}

const LEGACY_LABEL: Record<string, string> = {
  cash: 'Cash',
  wallet: 'Wallet',
  instapay: 'InstaPay',
}

/**
 * Summary for the legacy `sales.payment_method` TEXT column so old readers
 * still see something sensible: 'Cash', 'Cash + InstaPay', ...
 */
export function methodSummary(lines: PaymentLine[]): string {
  const keys = normalizeLines(lines).map((l) => l.method)
  if (!keys.length) return 'Cash'
  const labels = [...new Set(keys.map((k) => LEGACY_LABEL[k] ?? k))]
  return labels.join(' + ')
}

/** Ledger method key from a legacy/free-text sales.payment_method value. */
export function legacyMethodKey(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase() || 'cash'
}

/** i18n key for a method key ('cash' -> 'Cash'); unknown methods pass through. */
export function methodLabelKey(method: string): string {
  const k = keyOf(method)
  return LEGACY_LABEL[k] ?? method
}

/** Group ledger rows into {method, total} pairs, biggest first (Reports /
 *  cash-up view). Coerces DB strings and nulls; merges case-insensitively. */
export function sumByMethod(
  rows: { method: string; amount: number | string | null }[],
): { method: string; total: number }[] {
  const totals = new Map<string, number>()
  for (const r of rows) {
    const k = keyOf(r.method)
    totals.set(k, round2((totals.get(k) ?? 0) + (Number(r.amount) || 0)))
  }
  return [...totals.entries()]
    .map(([method, total]) => ({ method, total }))
    .sort((a, b) => b.total - a.total)
}
