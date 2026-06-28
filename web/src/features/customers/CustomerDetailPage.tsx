import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCustomer } from '../../data/customers'
import { useCustomerOrders } from '../../data/sales'
import { useI18n } from '../../i18n/LanguageContext'
import { ExamList } from '../../components/ExamView'
import { OrderReceiptDialog } from '../../components/OrderReceiptDialog'
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

  const c = customer.data
  const orderList = orders.data ?? []

  // Flatten every prescription across the customer's orders, newest first.
  const prescriptions = orderList.flatMap((o) =>
    (o.order_examinations ?? []).map((exam) => ({
      exam,
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
      <h2 className="mb-2 text-lg font-semibold text-brand-dark">
        {t('Prescriptions')} {prescriptions.length > 0 && <span className="text-sm text-faint">({prescriptions.length})</span>}
      </h2>
      {prescriptions.length === 0 ? (
        <p className="text-sm text-faint">{t('No prescriptions.')}</p>
      ) : (
        <div className="space-y-3">
          {prescriptions.map(({ exam, date, invoice }) => (
            <div key={exam.id}>
              <div className="mb-1 text-xs text-faint">
                {(date || '').slice(0, 10)} · #{invoice}
              </div>
              <ExamList exams={[exam]} />
            </div>
          ))}
        </div>
      )}

      {reprint && <OrderReceiptDialog sale={reprint} onClose={() => setReprint(null)} />}
    </div>
  )
}
