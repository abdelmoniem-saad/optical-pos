import { usePermissions } from '../../data/permissions'
import { SalePayments } from '../history/SalePayments'
import { useToast } from '../../components/Feedback'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  formatWait,
  useInfiniteLabSales,
  useLabQueue,
  useUpdateLabStatus,
  LAB_STATUSES,
  LAB_STATUS_COLORS,
} from '../../data/sales'
import { useOrderExaminations } from '../../data/examinations'
import { useI18n } from '../../i18n/LanguageContext'
import { OrderReceiptDialog } from '../../components/OrderReceiptDialog'
import type { Sale } from '../../lib/database.types'

const statusColor = LAB_STATUS_COLORS

/** How long a job has been sitting in its current status (migration 019).
 *
 *  Amber past a day, red past a week. The thresholds are a guess at an optical
 *  shop's rhythm rather than a rule - the point is that the number is now
 *  VISIBLE, so the shop can set its own. What was not acceptable was a screen
 *  where every overdue job looked exactly like a fresh one. */
function WaitBadge({ hours }: { hours: number }) {
  const { t } = useI18n()
  if (!Number.isFinite(hours) || hours <= 0) return null
  const tone =
    hours >= 24 * 7
      ? 'bg-danger text-white'
      : hours >= 24
        ? 'bg-warning-bg text-warning'
        : 'bg-surface text-muted'
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${tone}`}
    >
      {t('Waiting')} {formatWait(hours)}
    </span>
  )
}

function ExamLines({ saleId }: { saleId: string }) {
  const exams = useOrderExaminations(saleId)
  if (!exams.data?.length) return <div className="text-faint">-</div>
  return (
    <div className="space-y-1">
      {exams.data.map((e) => (
        <div key={e.id} className="text-xs text-muted">
          OD {e.sphere_od || '-'}/{e.cylinder_od || '-'}x{e.axis_od || '-'} · OS{' '}
          {e.sphere_os || '-'}/{e.cylinder_os || '-'}x{e.axis_os || '-'} · {e.lens_info || '-'} ·{' '}
          {e.frame_info || '-'}
        </div>
      ))}
    </div>
  )
}

export function LabPage() {
  const { t } = useI18n()
  const updateStatus = useUpdateLabStatus()
  const [params, setParams] = useSearchParams()
  const filter = params.get('status') ?? 'All'
  const saleId = params.get('sale')
  const setFilter = (status: string) => setParams({ status }, { replace: true })
  const perms = usePermissions()
  const notify = useToast()
  const [collecting, setCollecting] = useState<string | null>(null)
  const [reprint, setReprint] = useState<Sale | null>(null)


  // Paged server feed - only orders WITH a lab status, 50 at a time.
  const query = useInfiniteLabSales(filter, saleId)
  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.rows) ?? [],
    [query.data],
  )
  const total = query.data?.pages[query.data.pages.length - 1]?.count ?? 0

  // Dwell times (migration 019), joined onto the paged list by sale id. The list
  // still comes from useInfiniteLabSales rather than being replaced: that one
  // pages, and 019's function is a fixed 200-row snapshot. The badge is an
  // enrichment, so a database without 019 renders without it rather than failing
  // the whole screen.
  const queue = useLabQueue(null)
  const waitBySale = useMemo(() => {
    const m = new Map<string, number>()
    for (const q of queue.data ?? []) m.set(q.sale_id, q.hours_in_status)
    return m
  }, [queue.data])

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
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Lab Orders')}</h1>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand"
        >
          <option value="All">{t('All')}</option><option value="Pending">{t('Pending Lab')}</option>
          {LAB_STATUSES.map((s) => (
            <option key={s} value={s}>{t(s)}</option>
          ))}
        </select>
      </div>

      <p className="mb-4 text-sm text-muted">
        {query.isLoading
          ? t('Loading…')
          : `${rows.length}${total > rows.length ? ` / ${total}` : ''} ${t('orders')}`}
      </p>

      {query.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t("Couldn't load sales:")} {String(query.error)}
        </div>
      )}

      {rows.length === 0 && !query.isLoading ? (
        <p className="text-sm text-faint">{t('No lab orders.')}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <div key={s.id} className="rounded-xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">
                    #{s.invoice_no}{' '}
                    <span className="font-normal text-muted">
                      {s.customer_id
                        ? s.customers?.name ?? t('Customer')
                        : t('Walk-in')}
                    </span>
                  </div>
                  <div className="text-xs text-faint">{(s.order_date ?? '').slice(0, 10)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {/* How long it has been stuck in THIS status (migration 019).
                      Hidden without the badge when the query is unavailable, which
                      is the pre-019 state - not a zero, which would read as
                      "just started". */}
                  <WaitBadge hours={waitBySale.get(s.id) ?? 0} />
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusColor[s.lab_status ?? ''] ?? 'bg-surface'}`}>
                    {t(s.lab_status ?? '')}
                  </span>
                  <select
                    value={s.lab_status ?? 'Not Started'}
                    disabled={!perms.can('lab.edit') || updateStatus.isPending}
                    aria-label={`${t('Lab Status')}: ${s.invoice_no}`}
                    onChange={(e) => updateStatus.mutate({ id: s.id, status: e.target.value }, { onError: error => notify(error.message) })}
                    className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
                  >
                    {LAB_STATUSES.map((st) => (
                      <option key={st} value={st}>{t(st)}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setReprint(s)}
                    title={t('Print')}
                    className="rounded-lg border border-line px-2 py-1.5 text-sm hover:bg-surface"
                  >
                    🖨
                  </button>
                </div>
              </div>
              <div className="mt-2 border-t border-line/40 pt-2">
                <ExamLines saleId={s.id} />
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  <span className={Number(s.net_amount)-Number(s.amount_paid)>0 ? 'text-danger':'text-success'}>{t('Balance')}: {(Number(s.net_amount)-Number(s.amount_paid)).toFixed(2)}</span>
                  {perms.can('history.view') && <Link className="text-brand hover:underline" to={`/history?sale=${s.id}`}>{t('Open invoice')}</Link>}
                  {s.customer_id && perms.can('customers.view') && <Link className="text-brand hover:underline" to={`/customers/${s.customer_id}`}>{t('Customer')}</Link>}
                  {s.lab_status==='Ready' && perms.can('history.view') && <button className="rounded-lg border border-line px-3 py-1.5" onClick={() => setCollecting(collecting===s.id ? null:s.id)}>{t('Payments')}</button>}
                </div>
                {collecting===s.id && perms.can('history.view') && <SalePayments sale={s} balance={Number(s.net_amount)-Number(s.amount_paid)}/>}
              </div>
            </div>
          ))}
        </div>
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
