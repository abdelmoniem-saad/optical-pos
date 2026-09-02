import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  useInfiniteSales,
  LAB_STATUS_COLORS,
  type SalesRange,
} from '../../data/sales'
import { useI18n } from '../../i18n/LanguageContext'
import { OrderExamsLazy } from '../../components/ExamView'
import { OrderReceiptDialog } from '../../components/OrderReceiptDialog'
import { EditOrderForm } from './EditOrderForm'
import { usePermissions } from '../../data/permissions'
import type { Sale } from '../../lib/database.types'

function fmt(n: number | null | undefined) {
  return Number(n ?? 0).toFixed(2)
}

// Same palette as the Lab tab, plus aliases for values written by older
// builds so legacy badges still render sensibly.
const labColor: Record<string, string> = {
  ...LAB_STATUS_COLORS,
  'In Progress': 'bg-warning-bg text-warning',
  Delivered: 'bg-brand-bg text-brand-dark',
}

export function HistoryPage() {
  const { t } = useI18n()
  const perms = usePermissions()
  const [params] = useSearchParams()
  const [termInput, setTermInput] = useState(params.get('q') ?? '')
  const [term, setTerm] = useState(termInput.trim())
  const [range, setRange] = useState<SalesRange>(
    (params.get('range') as SalesRange) || 'all',
  )
  const [open, setOpen] = useState<string | null>(null)
  const [reprint, setReprint] = useState<Sale | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  // Debounce so typing doesn't fire a Postgres query per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setTerm(termInput.trim()), 300)
    return () => clearTimeout(id)
  }, [termInput])

  // Server-filtered, paged feed — the browser only ever holds ~50 orders per
  // page and loads more as you scroll, so the tab stays fast for years.
  const query = useInfiniteSales(range, term)
  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.rows) ?? [],
    [query.data],
  )
  const total = query.data?.pages[query.data.pages.length - 1]?.count ?? 0

  // Auto-load the next page when the sentinel scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !query.hasNextPage || query.isFetchingNextPage) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) void query.fetchNextPage()
      },
      { rootMargin: '300px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [query])

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">{t('Sales History')}</h1>
      <p className="mb-4 text-sm text-muted">
        {query.isLoading
          ? t('Loading…')
          : `${rows.length}${total > rows.length ? ` / ${total}` : ''} ${t('orders')}`}
      </p>

      <div className="mb-4 flex gap-2">
        <input
          value={termInput}
          onChange={(e) => setTermInput(e.target.value)}
          placeholder={t('Search invoice # or customer…')}
          className="flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        />
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as SalesRange)}
          className="rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        >
          <option value="all">{t('All Time')}</option>
          <option value="today">{t('Today')}</option>
          <option value="month">{t('This Month')}</option>
        </select>
      </div>

      {query.isError && (
        <div className="mb-4 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t("Couldn't load sales:")} {String(query.error)}
        </div>
      )}

      <div className="space-y-2">
        {rows.map((s) => {
          const net = Number(s.net_amount ?? 0)
          const paid = Number(s.amount_paid ?? 0)
          const balance = net - paid
          const expanded = open === s.id
          const custName =
            s.customer_id
              ? s.customers?.name ?? t('Customer')
              : t('Walk-in')
          return (
            <div key={s.id} className="overflow-hidden rounded-xl border border-line bg-white">
              <button
                onClick={() => setOpen(expanded ? null : s.id)}
                className="flex w-full items-center justify-between px-4 py-3 text-start hover:bg-surface"
              >
                <div>
                  <div className="font-semibold">
                    #{s.invoice_no}{' '}
                    <span className="font-normal text-muted">{custName}</span>
                  </div>
                  <div className="text-xs text-faint">
                    {(s.order_date ?? '').slice(0, 16).replace('T', ' ')}
                    {/* Staff member who made the invoice (when known). */}
                    {s.users ? (
                      <span title={t('Staff')}> · 👤 {s.users.full_name || s.users.username}</span>
                    ) : null}
                  </div>
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
                  {/* Line items are intentionally not shown here: frame
                      purchases already live on the prescription row below. */}
                  <div className="flex justify-between text-muted">
                    <span>{t('Paid')} {fmt(paid)}</span>
                    <span>{t('Balance')} {fmt(balance)}</span>
                  </div>
                  <OrderExamsLazy saleId={s.id} />
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => setReprint(s)}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface"
                    >
                      🖨 {t('Print')}
                    </button>
                    {perms.can('history.edit' as never) && (
                      <button
                        onClick={() => setEditing(editing === s.id ? null : s.id)}
                        className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface"
                      >
                        ✎ {editing === s.id ? t('Cancel') : t('Edit')}
                      </button>
                    )}
                  </div>
                  {editing === s.id && <EditOrderForm sale={s} onDone={() => setEditing(null)} />}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!query.isLoading && !query.isError && rows.length === 0 && (
        <p className="mt-6 text-center text-sm text-faint">{t('No matches.')}</p>
      )}

      {/* Sentinel: entering the viewport loads the next page automatically. */}
      {query.hasNextPage && (
        <div ref={sentinelRef} className="p-4 text-center text-xs text-faint">
          {query.isFetchingNextPage ? t('Loading…') : ''}
        </div>
      )}

      {reprint && <OrderReceiptDialog sale={reprint} onClose={() => setReprint(null)} />}
    </div>
  )
}
