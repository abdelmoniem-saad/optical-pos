import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCustomer, useUpdateCustomer } from '../../data/customers'
import { useCustomerOrders } from '../../data/sales'
import { useI18n } from '../../i18n/LanguageContext'
import { ExamList } from '../../components/ExamView'
import { OrderReceiptDialog } from '../../components/OrderReceiptDialog'
import type { Customer, Sale } from '../../lib/database.types'

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
  const [showEdit, setShowEdit] = useState(false)

  const c = customer.data
  const orderList = orders.data ?? []

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link to="/customers" className="text-sm text-brand hover:underline">
        ← {t('Customers')}
      </Link>
      <div className="mt-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-brand-dark">
            {c?.name ?? t('Loading…')}
          </h1>
          {/* Address intentionally omitted — city is enough per requirements. */}
          <div className="mb-6 text-sm text-muted">
            {[c?.phone, c?.city, c?.email].filter(Boolean).join(' · ')}
          </div>
        </div>
        {c && (
          <button
            onClick={() => setShowEdit(true)}
            className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-brand hover:bg-surface"
          >
            ✎ {t('Edit')}
          </button>
        )}
      </div>

      {/* Orders — prescriptions live inside each order's expanded panel, so
          the standalone "Prescriptions" section is no longer shown here. */}
      <h2 className="mb-2 text-lg font-semibold text-brand-dark">
        {t('Orders')}{' '}
        {orderList.length > 0 && (
          <span className="text-sm text-faint">({orderList.length})</span>
        )}
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
                  {/* Compact one-row layout — multiple Rx on the same order
                      don't need much space per the updated design. */}
                  <ExamList exams={o.order_examinations ?? []} compact />
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

      {reprint && <OrderReceiptDialog sale={reprint} onClose={() => setReprint(null)} />}
      {showEdit && c && (
        <EditCustomerDialog customer={c} onClose={() => setShowEdit(false)} />
      )}
    </div>
  )
}

/** Edit a customer's contact details. Address is intentionally not offered
 *  here — the shop only tracks city per the updated requirements. */
function EditCustomerDialog({
  customer,
  onClose,
}: {
  customer: Customer
  onClose: () => void
}) {
  const { t } = useI18n()
  const update = useUpdateCustomer()
  const [form, setForm] = useState({
    name: customer.name ?? '',
    phone: customer.phone ?? '',
    city: customer.city ?? '',
    email: customer.email ?? '',
  })
  const [error, setError] = useState<string | null>(null)

  // Refresh local state if a background refetch replaces the customer.
  useEffect(() => {
    setForm({
      name: customer.name ?? '',
      phone: customer.phone ?? '',
      city: customer.city ?? '',
      email: customer.email ?? '',
    })
  }, [customer])

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value })

  async function submit() {
    const name = form.name.trim()
    if (!name) {
      setError(t('Please enter customer name.'))
      return
    }
    setError(null)
    try {
      await update.mutateAsync({
        id: customer.id,
        patch: {
          name,
          phone: form.phone,
          city: form.city,
          email: form.email,
        },
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const field =
    'w-full rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-lg">
        <h2 className="mb-3 text-lg font-semibold text-brand-dark">{t('Edit Customer')}</h2>
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs text-faint">{t('Name')}</span>
            <input className={field} value={form.name} onChange={set('name')} autoFocus />
          </label>
          <label className="block">
            <span className="text-xs text-faint">{t('Mobile Phone')}</span>
            <input className={field} value={form.phone} onChange={set('phone')} />
          </label>
          <label className="block">
            <span className="text-xs text-faint">{t('City')}</span>
            <input className={field} value={form.city} onChange={set('city')} />
          </label>
          <label className="block">
            <span className="text-xs text-faint">{t('Email')}</span>
            <input className={field} value={form.email} onChange={set('email')} />
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
            disabled={update.isPending}
            className="rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-60"
          >
            {update.isPending ? t('Saving…') : t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
