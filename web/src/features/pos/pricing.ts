import type { CartLine } from '../../data/sales'

export type PricingInput = {
  discount: number
  amountPaid: number
  // The gross is ALWAYS editable in the cart. null = "use the items total";
  // a number = the seller typed a custom total (for negotiations / round prices).
  grossOverride: number | null
}

export type Totals = {
  itemsTotal: number
  gross: number
  discount: number
  net: number
  amountPaid: number
  balance: number
}

/**
 * Order totals. gross defaults to the items total but the seller can always
 * override it with a custom price. Discount is clamped to gross; amount paid is
 * clamped to net; balance is net − paid.
 */
export function computeTotals(items: CartLine[], p: PricingInput): Totals {
  // Line-level discounts (migration 013) are already off the table by the time
  // it reaches the server; the POS mirrors that so the cashier sees the same
  // number the database will store. total_price stays the GROSS line
  // (qty x unit_price) - the discount is its own column.
  const lineDiscounts = items.reduce((sum, i) => sum + (i.discount ?? 0), 0)
  const itemsTotal = items.reduce((sum, i) => sum + (i.total_price || 0), 0) - lineDiscounts
  const gross = p.grossOverride !== null ? Math.max(0, p.grossOverride) : itemsTotal
  const discount = Math.min(Math.max(0, p.discount), gross)
  const net = Math.max(0, gross - discount)
  const amountPaid = Math.min(Math.max(0, p.amountPaid), net)
  const balance = net - amountPaid
  return { itemsTotal, gross, discount, net, amountPaid, balance }
}

/**
 * Set (or clear) one line's discount, immutably.
 *
 * Clamped to the line's own gross value, because that is exactly what the
 * database refuses ('line discount exceeds the line') - clamping here means the
 * cashier can never type something the server will reject. A discount of 0
 * clears the field and its reason together, so no stale reason lingers.
 */
export function setLineDiscount(
  items: CartLine[],
  productId: string,
  amount: number,
  reason?: string | null,
): CartLine[] {
  return items.map((i) => {
    if (i.product_id !== productId) return i
    const gross = i.total_price || 0
    const value = Math.min(Math.max(0, Number.isFinite(amount) ? amount : 0), gross)
    return {
      ...i,
      discount: value,
      discount_reason: value > 0 ? (reason ?? i.discount_reason ?? null) : null,
    }
  })
}

/** Add a product to a cart immutably, incrementing qty if already present. */
export function addLine(items: CartLine[], product: {
  id: string
  name?: string | null
  sale_price?: number | null
}): CartLine[] {
  const idx = items.findIndex((i) => i.product_id === product.id)
  if (idx >= 0) {
    const next = [...items]
    const line = { ...next[idx], qty: next[idx].qty + 1 }
    line.total_price = line.qty * line.unit_price
    next[idx] = line
    return next
  }
  const price = Number(product.sale_price ?? 0)
  return [
    ...items,
    {
      product_id: product.id,
      name: product.name ?? '',
      qty: 1,
      unit_price: price,
      total_price: price,
    },
  ]
}

/** Change a line's quantity (min 1) immutably. */
export function setQty(items: CartLine[], productId: string, qty: number): CartLine[] {
  return items.map((i) =>
    i.product_id === productId
      ? { ...i, qty: Math.max(1, qty), total_price: Math.max(1, qty) * i.unit_price }
      : i,
  )
}

export function removeLine(items: CartLine[], productId: string): CartLine[] {
  return items.filter((i) => i.product_id !== productId)
}
