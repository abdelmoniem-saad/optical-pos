import { useMemo, useState } from 'react'
import { useSales } from '../../data/sales'
import { useCustomers } from '../../data/customers'
import { useInventory } from '../../data/inventory'
import type { Customer, Product, Sale } from '../../lib/database.types'

type Period = 'today' | 'month' | 'all'

function computeReport(
  allSales: Sale[],
  customers: Customer[],
  products: Product[],
  period: Period,
) {
  const todayIso = new Date().toISOString().slice(0, 10)
  const monthStart = todayIso.slice(0, 8) + '01'

  let sales = allSales
  if (period === 'today') sales = sales.filter((s) => (s.order_date ?? '').startsWith(todayIso))
  else if (period === 'month') sales = sales.filter((s) => (s.order_date ?? '') >= monthStart)

  const sum = (arr: Sale[], k: 'net_amount' | 'amount_paid') =>
    arr.reduce((t, s) => t + Number(s[k] ?? 0), 0)

  const totalRevenue = sum(sales, 'net_amount')
  const totalPaid = sum(sales, 'amount_paid')

  const todaySales = sales.filter((s) => (s.order_date ?? '').startsWith(todayIso))
  const monthSales = sales.filter((s) => (s.order_date ?? '') >= monthStart)

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
    .map(([id, total]) => ({ name: customers.find((c) => c.id === id)?.name ?? '—', total }))

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
  }
}

function Kpi({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <div className="text-2xl font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-sm text-muted">{label}</div>
      {sub && <div className="text-xs text-faint">{sub}</div>}
    </div>
  )
}

export function ReportsPage() {
  const sales = useSales()
  const customers = useCustomers()
  const inv = useInventory()
  const [period, setPeriod] = useState<Period>('all')

  const r = useMemo(
    () => computeReport(sales.data ?? [], customers.data ?? [], inv.data ?? [], period),
    [sales.data, customers.data, inv.data, period],
  )

  const m = (n: number) => n.toFixed(0)

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">Reports &amp; Analytics</h1>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          className="rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand"
        >
          <option value="today">Today</option>
          <option value="month">This Month</option>
          <option value="all">All Time</option>
        </select>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Total Revenue" value={m(r.totalRevenue)} color="#388e3c" />
        <Kpi label="Total Paid" value={m(r.totalPaid)} color="#00796b" />
        <Kpi label="Balance Due" value={m(r.balanceDue)} color="#d32f2f" />
        <Kpi label="Total Orders" value={String(r.orderCount)} color="#1976d2" />
        <Kpi label="Today's Revenue" value={m(r.todayRevenue)} color="#f57c00" sub={`${r.todayOrders} orders`} />
        <Kpi label="This Month" value={m(r.monthRevenue)} color="#7b1fa2" sub={`${r.monthOrders} orders`} />
        <Kpi label="Pending Lab" value={String(r.pendingLab)} color="#f57c00" />
        <Kpi label="Ready for Pickup" value={String(r.readyLab)} color="#388e3c" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-warning/30 bg-warning-bg/40 p-4">
          <h2 className="mb-2 font-semibold text-warning">Low Stock Alert</h2>
          {r.lowStock.length === 0 ? (
            <p className="text-sm text-success">All products in stock.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {r.lowStock.slice(0, 10).map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.name}</span>
                  <span className="font-semibold text-danger">{p.stock_qty ?? 0} left</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-brand/20 bg-brand-bg/40 p-4">
          <h2 className="mb-2 font-semibold text-brand-dark">Top Customers</h2>
          {r.topCustomers.length === 0 ? (
            <p className="text-sm text-faint">No customer data.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {r.topCustomers.map((c, i) => (
                <li key={i} className="flex justify-between">
                  <span>
                    {i + 1}. {c.name}
                  </span>
                  <span className="font-semibold text-success">{c.total.toFixed(0)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
