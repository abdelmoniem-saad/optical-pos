import { useMemo, useState } from 'react'
import { useSales, useUpdateLabStatus } from '../../data/sales'
import { useCustomers } from '../../data/customers'
import { useOrderExaminations } from '../../data/examinations'
import { useI18n } from '../../i18n/LanguageContext'
import { OrderReceiptDialog } from '../../components/OrderReceiptDialog'
import type { Sale } from '../../lib/database.types'

const STATUSES = ['Not Started', 'In Lab', 'Ready', 'Received']

const statusColor: Record<string, string> = {
  'Not Started': 'bg-surface text-muted',
  'In Lab': 'bg-warning-bg text-warning',
  Ready: 'bg-success-bg text-success',
  Received: 'bg-brand-bg text-brand-dark',
}

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
  const sales = useSales()
  const customers = useCustomers()
  const updateStatus = useUpdateLabStatus()
  const [filter, setFilter] = useState<string>('All')
  const [reprint, setReprint] = useState<Sale | null>(null)

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of customers.data ?? []) m.set(c.id, c.name)
    return m
  }, [customers.data])

  const labOrders = useMemo(() => {
    const list = (sales.data ?? []).filter((s) => s.lab_status)
    return filter === 'All' ? list : list.filter((s) => s.lab_status === filter)
  }, [sales.data, filter])

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
          {STATUSES.map((s) => (
            <option key={s} value={s}>{t(s)}</option>
          ))}
        </select>
      </div>

      {sales.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t("Couldn't load sales:")} {String(sales.error)}
        </div>
      )}

      {labOrders.length === 0 ? (
        <p className="text-sm text-faint">{t('No lab orders.')}</p>
      ) : (
        <div className="space-y-2">
          {labOrders.map((s) => (
            <div key={s.id} className="rounded-xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">
                    #{s.invoice_no}{' '}
                    <span className="font-normal text-muted">
                      {s.customer_id ? nameById.get(s.customer_id) ?? t('Customer') : t('Walk-in')}
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
                    {STATUSES.map((st) => (
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

      {reprint && <OrderReceiptDialog sale={reprint} onClose={() => setReprint(null)} />}
    </div>
  )
}
