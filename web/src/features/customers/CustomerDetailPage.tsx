import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCustomer } from '../../data/customers'
import { useAddStandalonePrescription, useCustomerOrders } from '../../data/sales'
import { useI18n } from '../../i18n/LanguageContext'
import { ExamList } from '../../components/ExamView'
import { OrderReceiptDialog } from '../../components/OrderReceiptDialog'
import { emptyExam, type Exam } from '../pos/types'
import type { Sale } from '../../lib/database.types'

function fmt(n: number | null | undefined) {
  return Number(n ?? 0).toFixed(2)
}

export function CustomerDetailPage() {
  const { t } = useI18n()
  const { id } = useParams()
  const customer = useCustomer(id ?? null)
  const orders = useCustomerOrders(id ?? null)
  const [open, setOpen] = useState<string | null>(null)
  const [reprint, setReprint] = useState<Sale | null>(null)
  const [showAddRx, setShowAddRx] = useState(false)

  const c = customer.data
  const orderList = orders.data ?? []

  // Flatten every prescription across the customer's orders, newest first.
  const prescriptions = orderList.flatMap((o) =>
    (o.order_examinations ?? []).map((exam) => ({
      exam,
      order: o,
      date: o.order_date ?? '',
      invoice: o.invoice_no,
    })),
  )

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link to="/customers" className="text-sm text-brand hover:underline">
        ← {t('Customers')}
      </Link>
      <h1 className="mt-2 text-2xl font-semibold text-brand-dark">{c?.name ?? t('Loading…')}</h1>
      <div className="mb-6 text-sm text-muted">
        {[c?.phone, c?.city, c?.email, c?.address].filter(Boolean).join(' · ')}
      </div>

      {/* Orders */}
      <h2 className="mb-2 text-lg font-semibold text-brand-dark">
        {t('Orders')} {orderList.length > 0 && <span className="text-sm text-faint">({orderList.length})</span>}
      </h2>
      {orders.isLoading && <p className="text-sm text-muted">{t('Loading…')}</p>}
      {!orders.isLoading && orderList.length === 0 && (
        <p className="text-sm text-faint">{t('No orders.')}</p>
      )}
      <div className="mb-8 space-y-2">
        {orderList.map((o) => {
          const net = Number(o.net_amount ?? 0)
          const paid = Number(o.amount_paid ?? 0)
          const bal = net - paid
          const expanded = open === o.id
          return (
            <div key={o.id} className="overflow-hidden rounded-xl border border-line bg-white">
              <button
                onClick={() => setOpen(expanded ? null : o.id)}
                className="flex w-full items-center justify-between px-4 py-3 text-start hover:bg-surface"
              >
                <div>
                  <div className="font-semibold">#{o.invoice_no}</div>
                  <div className="text-xs text-faint">{(o.order_date ?? '').slice(0, 10)}</div>
                </div>
                <div className="text-end">
                  <div className="font-semibold">{fmt(net)}</div>
                  {bal > 0 && <div className="text-xs text-danger">{t('due')} {fmt(bal)}</div>}
                </div>
              </button>
              {expanded && (
                <div className="border-t border-line/40 bg-surface/40 px-4 py-3 text-sm">
                  {(o.sale_items?.length ?? 0) > 0 && (
                    <table className="mb-2 w-full">
                      <tbody>
                        {o.sale_items!.map((it) => (
                          <tr key={it.id}>
                            <td className="py-1">{it.name}</td>
                            <td className="py-1 text-center text-muted">×{it.qty}</td>
                            <td className="py-1 text-end">{fmt(it.total_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="mb-2 flex justify-between text-muted">
                    <span>{t('Paid')} {fmt(paid)}</span>
                    <span>{t('Balance')} {fmt(bal)}</span>
                  </div>
                  <ExamList exams={o.order_examinations ?? []} />
                  <button
                    onClick={() => setReprint(o)}
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

      {/* Prescription history */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-brand-dark">
          {t('Prescriptions')} {prescriptions.length > 0 && <span className="text-sm text-faint">({prescriptions.length})</span>}
        </h2>
        {c && (
          <button
            onClick={() => setShowAddRx(true)}
            className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white"
          >
            + {t('Add Prescription')}
          </button>
        )}
      </div>
      {prescriptions.length === 0 ? (
        <p className="text-sm text-faint">{t('No prescriptions.')}</p>
      ) : (
        <div className="space-y-3">
          {prescriptions.map(({ exam, order, date, invoice }) => (
            <div key={exam.id}>
              <div className="mb-1 flex items-center justify-between text-xs text-faint">
                <span>{(date || '').slice(0, 10)} · #{invoice}</span>
                <button
                  onClick={() => setReprint(order)}
                  title={t('Print')}
                  className="rounded-lg border border-line px-2 py-1 hover:bg-surface"
                >
                  🖨 {t('Print')}
                </button>
              </div>
              <ExamList exams={[exam]} />
            </div>
          ))}
        </div>
      )}

      {reprint && <OrderReceiptDialog sale={reprint} onClose={() => setReprint(null)} />}
      {showAddRx && c && (
        <AddPrescriptionDialog customerId={c.id} onClose={() => setShowAddRx(false)} />
      )}
    </div>
  )
}

/** Standalone prescription entry — persisted as a zero-total sale so the
 *  customer's exam history query keeps working without a schema change. */
function AddPrescriptionDialog({
  customerId,
  onClose,
}: {
  customerId: string
  onClose: () => void
}) {
  const { t } = useI18n()
  const add = useAddStandalonePrescription()
  const [exam, setExam] = useState<Exam>(emptyExam())
  const [doctor, setDoctor] = useState('')
  const [error, setError] = useState<string | null>(null)

  const upd = (p: Partial<Exam>) => setExam({ ...exam, ...p })

  const small = 'rounded-md border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-brand'
  const num = (label: string, key: keyof Exam, w = 'w-20') => (
    <label className="flex flex-col">
      <span className="mb-0.5 text-[10px] font-semibold text-faint">{label}</span>
      <input
        className={`${small} ${w}`}
        value={String(exam[key] ?? '')}
        onChange={(e) => upd({ [key]: e.target.value } as Partial<Exam>)}
      />
    </label>
  )

  async function submit() {
    setError(null)
    try {
      await add.mutateAsync({ customerId, exam, doctorName: doctor })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-lg" dir="ltr">
        <h2 className="mb-3 text-lg font-semibold text-brand-dark">{t('Add Prescription')}</h2>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col">
            <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Exam Type')}</span>
            <select
              className={`${small} w-36`}
              value={String(exam.exam_type ?? 'Distance')}
              onChange={(e) => upd({ exam_type: e.target.value })}
            >
              <option value="Distance">{t('Distance')}</option>
              <option value="Reading">{t('Reading')}</option>
              <option value="Contact Lenses">{t('Contact Lenses')}</option>
            </select>
          </label>
          <label className="flex flex-col">
            <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Doctor Name')}</span>
            <input
              className={`${small} w-48`}
              value={doctor}
              onChange={(e) => setDoctor(e.target.value)}
            />
          </label>
        </div>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div className="flex items-end gap-1 rounded-md bg-surface/60 p-1">
            {num('R.SPH', 'sphere_od')}
            {num('R.CYL', 'cylinder_od')}
            {num('R.AX', 'axis_od', 'w-16')}
          </div>
          <div className="flex items-end gap-1 rounded-md bg-surface/60 p-1">
            {num('L.SPH', 'sphere_os')}
            {num('L.CYL', 'cylinder_os')}
            {num('L.AX', 'axis_os', 'w-16')}
          </div>
          {num('IPD', 'ipd', 'w-16')}
        </div>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col">
            <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Lens Type')}</span>
            <input
              className={`${small} w-40`}
              value={String(exam.lens_info ?? '')}
              onChange={(e) => upd({ lens_info: e.target.value })}
            />
          </label>
          <label className="flex flex-col">
            <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Frame')}</span>
            <input
              className={`${small} w-40`}
              value={String(exam.frame_info ?? '')}
              onChange={(e) => upd({ frame_info: e.target.value })}
            />
          </label>
          <label className="flex flex-col">
            <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Color')}</span>
            <input
              className={`${small} w-28`}
              value={String(exam.frame_color ?? '')}
              onChange={(e) => upd({ frame_color: e.target.value })}
            />
          </label>
        </div>
        {error && (
          <div className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{error}</div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-2 text-muted hover:bg-surface"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={submit}
            disabled={add.isPending}
            className="rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-60"
          >
            {add.isPending ? t('Saving…') : t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
