import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSales } from '../../data/sales'
import { useCustomers } from '../../data/customers'
import { useI18n } from '../../i18n/LanguageContext'
import { OrderExamsLazy } from '../../components/ExamView'
import { OrderReceiptDialog } from '../../components/OrderReceiptDialog'
import type { Sale } from '../../lib/database.types'

type Range = 'all' | 'today' | 'month'

function fmt(n: number | null | undefined) {
  return Number(n ?? 0).toFixed(2)
}

const labColor: Record<string, string> = {
  'Not Started': 'bg-surface text-muted',
  'In Progress': 'bg-warning-bg text-warning',
  Ready: 'bg-success-bg text-success',
  Delivered: 'bg-brand-bg text-brand-dark',
}

export function HistoryPage() {
  const { t } = useI18n()
  const sales = useSales()
  const customers = useCustomers()
  const [params] = useSearchParams()
  const [term, setTerm] = useState(params.get('q') ?? '')
  const [range, setRange] = useState<Range>((params.get('range') as Range) || 'all')
  const [open, setOpen] = useState<string | null>(null)
  const [reprint, setReprint] = useState<Sale | null>(null)

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of customers.data ?? []) m.set(c.id, c.name)
    return m
  }, [customers.data])

  const rows = useMemo(() => {
    const todayIso = new Date().toISOString().slice(0, 10)
    const monthStart = todayIso.slice(0, 8) + '01'
    let list = sales.data ?? []
    if (range === 'today') list = list.filter((s) => (s.order_date ?? '').startsWith(todayIso))
    else if (range === 'month') list = list.filter((s) => (s.order_date ?? '') >= monthStart)
    const tt = term.trim().toLowerCase()
    if (!tt) return list
    return list.filter((s) => {
      const cust = s.customer_id ? (nameById.get(s.customer_id) ?? '') : ''
      return (
        (s.invoice_no ?? '').toLowerCase().includes(tt) ||
        cust.toLowerCase().includes(tt)
      )
    })
  }, [sales.data, term, range, nameById])

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">{t('Sales History')}</h1>
      <p className="mb-4 text-sm text-muted">
        {sales.data ? `${sales.data.length} ${t('orders')}` : t('Loading…')}
      </p>

      <div className="mb-4 flex gap-2">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t('Search invoice # or customer…')}
          className="flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        />
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
          className="rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        >
          <option value="all">{t('All Time')}</option>
          <option value="today">{t('Today')}</option>
          <option value="month">{t('This Month')}</option>
        </select>
      </div>

      {sales.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t("Couldn't load sales:")} {String(sales.error)}
        </div>
      )}

      <div className="space-y-2">
        {rows.map((s) => {
          const net = Number(s.net_amount ?? 0)
          const paid = Number(s.amount_paid ?? 0)
          const balance = net - paid
          const expanded = open === s.id
          return (
            <div key={s.id} className="overflow-hidden rounded-xl border border-line bg-white">
              <button
                onClick={() => setOpen(expanded ? null : s.id)}
                className="flex w-full items-center justify-between px-4 py-3 text-start hover:bg-surface"
              >
                <div>
                  <div className="font-semibold">
                    #{s.invoice_no}{' '}
                    <span className="font-normal text-muted">
                      {s.customer_id ? nameById.get(s.customer_id) ?? t('Customer') : t('Walk-in')}
                    </span>
                  </div>
                  <div className="text-xs text-faint">{(s.order_date ?? '').slice(0, 16).replace('T', ' ')}</div>
                </div>
                <div className="flex items-center gap-3">
                  {s.lab_status && (
                    <span className={`rounded-full px-2 py-0.5 text-xs ${labColor[s.lab_status] ?? 'bg-surface text-muted'}`}>
                      {t(s.lab_status)}
                    </span>
                  )}
                  <div className="text-end">
                    <div className="font-semibold">{fmt(net)}</div>
                    {balance > 0 && <div className="text-xs text-danger">{t('due')} {fmt(balance)}</div>}
                  </div>
                </div>
              </button>
              {expanded && (
                <div className="border-t border-line/40 bg-surface/40 px-4 py-3 text-sm">
                  {(s.sale_items?.length ?? 0) === 0 ? (
                    <div className="text-faint">{t('No line items.')}</div>
                  ) : (
                    <table className="w-full">
                      <tbody>
                        {s.sale_items!.map((it) => (
                          <tr key={it.id}>
                            <td className="py-1">{it.name}</td>
                            <td className="py-1 text-center text-muted">×{it.qty}</td>
                            <td className="py-1 text-end">{fmt(it.total_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="mt-2 flex justify-between text-muted">
                    <span>{t('Paid')} {fmt(paid)}</span>
                    <span>{t('Balance')} {fmt(balance)}</span>
                  </div>
                  <OrderExamsLazy saleId={s.id} />
                  <button
                    onClick={() => setReprint(s)}
                    className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface"
                  >
                    🖨 {t('Print')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {reprint && <OrderReceiptDialog sale={reprint} onClose={() => setReprint(null)} />}
    </div>
  )
}
