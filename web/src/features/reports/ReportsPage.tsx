import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { computeReport, type Period } from './computeReport'
import { useSalesSummary, fetchReportTotals, fetchTopCustomers, fetchVoidSummary } from '../../data/sales'
import { useCustomers } from '../../data/customers'
import { useInventory } from '../../data/inventory'
import { useI18n } from '../../i18n/LanguageContext'
import { usePaymentsRange } from '../../data/salesPayments'
import { methodLabelKey, sumByMethod } from '../../lib/payments'

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

  // Period bounds, computed once and shared by the ledger and the report.
  const todayIso = useMemo(() => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }, [])
  // The SAME day the bounds use, so the report and the cash-up panel cannot
  // describe different days (and so the value is stable across renders).
  const now = useMemo(() => new Date(todayIso + 'T00:00:00'), [todayIso])
  const monthStart = todayIso.slice(0, 8) + '01'
  const from = period === 'today' ? todayIso : period === 'month' ? monthStart : null
  const to = period === 'today' ? todayIso : null

  // Preferred path (migration 016): the database does the arithmetic, so the
  // void exclusion is enforced by the schema rather than by this file. Falls
  // back to the client computation while 016 is unapplied, which is the
  // computeReport path above - and which now also excludes voids.
  const server = useQuery({
    queryKey: ['report-totals', from, to],
    queryFn: async () => {
      const [totals, tops, voids] = await Promise.all([
        fetchReportTotals(from, to),
        fetchTopCustomers(from, to, 5),
        fetchVoidSummary(from, to),
      ])
      if (!totals) return null
      return { totals, tops: tops ?? [], voids: voids ?? { voidedCount: 0, voidedNet: 0 } }
    },
  })

  const client = useMemo(
    () => computeReport(sales.data?.sales ?? [], customers.data ?? [], inv.data ?? [], period, now),
    [sales.data, customers.data, inv.data, period, now],
  )

  const s = server.data
  const r = s
    ? {
        totalRevenue: s.totals.revenue,
        totalPaid: s.totals.paid,
        balanceDue: s.totals.balanceDue,
        orderCount: s.totals.orderCount,
        pendingLab: s.totals.pendingLab,
        readyLab: s.totals.readyLab,
        lowStock: client.lowStock,
        topCustomers: s.tops,
        voidedCount: s.voids.voidedCount,
        voidedNet: s.voids.voidedNet,
        todayRevenue: client.todayRevenue,
        todayOrders: client.todayOrders,
        monthRevenue: client.monthRevenue,
        monthOrders: client.monthOrders,
      }
    : client

  const m = (n: number) => n.toFixed(0)

  // Cash-up: money RECEIVED in the period, by paid_at, from the ledger. The
  // same `from`/`to` bounds the report uses, so the two panels cannot disagree
  // about which day they are describing.
  const pays = usePaymentsRange(from, to)
  const byMethod = useMemo(() => sumByMethod(pays.data ?? []), [pays.data])

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

      {/* A void is excluded from every number above - correctly, since its
          money did not happen. It is shown here so a mistaken void cannot hide
          as a quiet day. */}
      {r.voidedCount > 0 && (
        <div className="mb-4 rounded-xl border border-line bg-white p-4">
          <p className="text-sm text-faint">
            {t('Excluded from these totals')}: {r.voidedCount} {t('voided invoice')}{' '}
            ({r.voidedNet.toFixed(2)})
          </p>
        </div>
      )}

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
              {r.topCustomers.map((c: { name: string; total: number }, i: number) => (
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

      {/* Cash-up view: money RECEIVED in the selected period, split by tender
          (sale_payments ledger, migration 011). */}
      <div className="mt-4 rounded-xl border border-line bg-white p-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold text-brand-dark">{t('By payment method')}</h2>
          <span className="text-xs text-faint">
            {t(period === 'today' ? 'Today' : period === 'month' ? 'This Month' : 'All Time')}
          </span>
        </div>
        {pays.isError ? (
          <p className="rounded bg-warning-bg px-3 py-2 text-sm text-warning">
            {t(pays.error.message)}
          </p>
        ) : pays.isLoading ? (
          <p className="text-sm text-faint">{t('Loading…')}</p>
        ) : byMethod.length === 0 ? (
          <p className="text-sm text-faint">{t('No payments in this period.')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {byMethod.map((row) => (
              <li key={row.method} className="flex justify-between">
                <span>{t(methodLabelKey(row.method))}</span>
                <span className="font-semibold text-success">{row.total.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
