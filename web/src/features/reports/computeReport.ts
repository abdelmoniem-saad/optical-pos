import type { Customer, Product, Sale } from '../../lib/database.types'

export type Period = 'today' | 'month' | 'all'

/**
 * A voided sale is still a row, and its money columns are deliberately left
 * intact so the audit trail reads true. That makes it the caller's job to
 * exclude it - which is exactly what the Reports screen got wrong: voiding a
 * 5,000 EGP invoice *added* 5,000 to revenue instead of removing it, because
 * the flag was never selected and never filtered.
 *
 * `voided_at is null` is the single definition of "live", and `sales_live_idx`
 * (013) is a partial index on exactly that predicate, so filtering in the
 * database is free.
 */
export function isLive(s: Pick<Sale, 'voided_at'>): boolean {
  return !s.voided_at
}

function periodOf(orderDate: string | null | undefined): string {
  return (orderDate ?? '').slice(0, 10)
}

export function computeReport(
  allSales: Sale[],
  customers: Customer[],
  products: Product[],
  period: Period,
  now: Date = new Date(),
) {
  const todayIso = localDate(now)
  const monthStart = todayIso.slice(0, 8) + '01'

  // Excluded before any arithmetic happens, so no KPI can be inflated by a
  // void: a voided sale contributes to none of them.
  const live = allSales.filter(isLive)
  const voided = allSales.filter((s) => !isLive(s))

  let sales = live
  if (period === 'today') sales = sales.filter((s) => periodOf(s.order_date) === todayIso)
  else if (period === 'month') sales = sales.filter((s) => periodOf(s.order_date) >= monthStart)

  const sum = (arr: Sale[], k: 'net_amount' | 'amount_paid') =>
    arr.reduce((t, s) => t + Number(s[k] ?? 0), 0)

  const totalRevenue = sum(sales, 'net_amount')
  const totalPaid = sum(sales, 'amount_paid')

  const todaySales = sales.filter((s) => periodOf(s.order_date) === todayIso)
  const monthSales = sales.filter((s) => periodOf(s.order_date) >= monthStart)

  const lab = sales.filter((s) => s.lab_status)
  const pendingLab = lab.filter((s) => ['Not Started', 'In Lab', 'In Progress'].includes(s.lab_status ?? '')).length
  const readyLab = lab.filter((s) => s.lab_status === 'Ready').length

  const lowStock = products.filter((p) => (p.stock_qty ?? 0) < 5)

  const totals = new Map<string, number>()
  for (const s of sales) {
    if (s.customer_id) totals.set(s.customer_id, (totals.get(s.customer_id) ?? 0) + Number(s.net_amount ?? 0))
  }
  const topCustomers = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, total]) => ({ name: customers.find((c) => c.id === id)?.name ?? '-', total }))

  return {
    totalRevenue,
    totalPaid,
    balanceDue: totalRevenue - totalPaid,
    orderCount: sales.length,
    todayRevenue: sum(todaySales, 'net_amount'),
    todayOrders: todaySales.length,
    monthRevenue: sum(monthSales, 'net_amount'),
    monthOrders: monthSales.length,
    pendingLab,
    readyLab,
    lowStock,
    topCustomers,
    // Reported rather than hidden: excluding a void from revenue is correct,
    // but silently dropping it would let a mistaken void look like a quiet day.
    voidedCount: voided.length,
    voidedNet: sum(voided, 'net_amount'),
  }
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
