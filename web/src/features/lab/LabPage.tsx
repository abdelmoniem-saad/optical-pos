import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useInfiniteLabSales,
  useUpdateLabStatus,
  LAB_STATUSES,
  LAB_STATUS_COLORS,
} from '../../data/sales'
import { useOrderExaminations } from '../../data/examinations'
import { useI18n } from '../../i18n/LanguageContext'
import { OrderReceiptDialog } from '../../components/OrderReceiptDialog'
import type { Sale } from '../../lib/database.types'

const statusColor = LAB_STATUS_COLORS

function ExamLines({ saleId }: { saleId: string }) {
  const exams = useOrderExaminations(saleId)
  if (!exams.data?.length) return <div className="text-faint">—</div>
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
  const [filter, setFilter] = useState<string>('All')
  const [reprint, setReprint] = useState<Sale | null>(null)

  // Paged server feed — only orders WITH a lab status, 50 at a time.
  const query = useInfiniteLabSales(filter)
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
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Lab Orders')}</h1>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand"
        >
          <option value="All">{t('All')}</option>
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
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusColor[s.lab_status ?? ''] ?? 'bg-surface'}`}>
                    {t(s.lab_status ?? '')}
                  </span>
                  <select
                    value={s.lab_status ?? 'Not Started'}
                    onChange={(e) => updateStatus.mutate({ id: s.id, status: e.target.value })}
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
