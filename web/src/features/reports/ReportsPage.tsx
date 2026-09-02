import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSalesSummary } from '../../data/sales'
import { useCustomers } from '../../data/customers'
import { useInventory } from '../../data/inventory'
import { useI18n } from '../../i18n/LanguageContext'
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
  }
}

function Kpi({
  label,
  value,
  color,
  sub,
  to,
}: {
  label: string
  value: string
  color: string
  sub?: string
  to?: string
}) {
  const inner = (
    <>
      <div className="text-2xl font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-sm text-muted">{label}</div>
      {sub && <div className="text-xs text-faint">{sub}</div>}
    </>
  )
  if (to) {
    return (
      <Link to={to} className="block rounded-xl bg-white p-4 shadow-sm transition hover:shadow-md">
        {inner}
      </Link>
    )
  }
  return <div className="rounded-xl bg-white p-4 shadow-sm">{inner}</div>
}

export function ReportsPage() {
  const { t } = useI18n()
  // Lean header-only feed: Reports aggregates totals, it never needs the
  // (payload-heavy) line items, so this stays cheap as data grows.
  const sales = useSalesSummary()
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
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Reports & Analytics')}</h1>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          className="rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand"
        >
          <option value="today">{t('Today')}</option>
          <option value="month">{t('This Month')}</option>
          <option value="all">{t('All Time')}</option>
        </select>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label={t('Total Revenue')} value={m(r.totalRevenue)} color="#388e3c" to="/history" />
        <Kpi label={t('Total Paid')} value={m(r.totalPaid)} color="#00796b" />
        <Kpi label={t('Balance Due')} value={m(r.balanceDue)} color="#d32f2f" />
        <Kpi label={t('Total Orders')} value={String(r.orderCount)} color="#1976d2" to="/history" />
        <Kpi label={t("Today's Revenue")} value={m(r.todayRevenue)} color="#f57c00" sub={`${r.todayOrders} ${t('orders')}`} to="/history?range=today" />
        <Kpi label={t('This Month')} value={m(r.monthRevenue)} color="#7b1fa2" sub={`${r.monthOrders} ${t('orders')}`} to="/history?range=month" />
        <Kpi label={t('Pending Lab')} value={String(r.pendingLab)} color="#f57c00" to="/lab" />
        <Kpi label={t('Ready for Pickup')} value={String(r.readyLab)} color="#388e3c" to="/lab" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-warning/30 bg-warning-bg/40 p-4">
          <h2 className="mb-2 font-semibold text-warning">{t('Low Stock Alert')}</h2>
          {r.lowStock.length === 0 ? (
            <p className="text-sm text-success">{t('All products in stock.')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {r.lowStock.slice(0, 10).map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.name}</span>
                  <span className="font-semibold text-danger">{p.stock_qty ?? 0} {t('left')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-brand/20 bg-brand-bg/40 p-4">
          <h2 className="mb-2 font-semibold text-brand-dark">{t('Top Customers')}</h2>
          {r.topCustomers.length === 0 ? (
            <p className="text-sm text-faint">{t('No customer data.')}</p>
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
