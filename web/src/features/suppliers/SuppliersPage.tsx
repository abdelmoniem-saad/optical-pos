import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { localDateISO } from '../pos/POSContext'
import {
  useAddPurchase,
  useAddPurchasePayment,
  useAddSupplier,
  useAllPurchasePayments,
  useDeletePurchasePayment,
  useDeleteSupplier,
  usePurchases,
  usePurchasePayments,
  useSuppliers,
  type Purchase,
  type Supplier,
} from '../../data/suppliers'

function money(n: number) {
  return n.toFixed(2)
}

function SupplierForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const add = useAddSupplier()
  const [f, setF] = useState({ name: '', phone: '', email: '', address: '' })
  const cls = 'w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand'

  async function submit() {
    if (!f.name.trim()) return
    await add.mutateAsync({ name: f.name.trim(), phone: f.phone, email: f.email, address: f.address })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold text-brand-dark">{t('+ Add Supplier')}</h2>
        <div className="space-y-2">
          <input className={cls} placeholder={t('Name')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className={cls} placeholder={t('Phone')} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <input className={cls} placeholder={t('Email')} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <input className={cls} placeholder={t('Address')} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-muted hover:bg-surface">{t('Cancel')}</button>
          <button onClick={submit} disabled={add.isPending} className="rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-60">{t('Save')}</button>
        </div>
      </div>
    </div>
  )
}

/** One expandable shipment: total vs Σ(payments), plus its dated ledger. */
function ShipmentCard({ purchase }: { purchase: Purchase }) {
  const { t } = useI18n()
  const payments = usePurchasePayments(purchase.id)
  const addPay = useAddPurchasePayment()
  const delPay = useDeletePurchasePayment()
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(localDateISO())

  const total = Number(purchase.total_amount ?? 0)
  const paidSum = (payments.data ?? []).reduce((sum, p) => sum + Number(p.amount ?? 0), 0)
  const remaining = total - paidSum
  const rows = payments.data ?? []

  async function submitPayment() {
    const amt = Number(amount) || 0
    if (amt <= 0 || !purchase.id) return
    await addPay.mutateAsync({
      purchase_id: purchase.id,
      amount: amt,
      paid_at: date || localDateISO(),
      note: null,
    })
    setAmount('')
  }

  const cls = 'w-24 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand'

  return (
    <li className="border-b border-line/40 last:border-b-0">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-start text-sm hover:bg-surface/60">
        <span className="text-muted">{(purchase.purchase_date ?? '').slice(0, 10)}</span>
        <span className="font-semibold">{money(total)}</span>
        {/* Remaining: red while the supplier is still owed, green when settled. */}
        <span className={`text-xs font-semibold ${remaining > 0 ? 'text-danger' : 'text-success'}`}>
          {t('Remaining')}: {money(remaining)}
        </span>
        <span className="text-faint">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-line/40 bg-surface/40 px-3 py-2.5">
          {payments.isError && (
            <p className="mb-2 rounded-lg bg-warning-bg px-2 py-1.5 text-xs text-warning">
              {t((payments.error as Error).message)}
            </p>
          )}

          {rows.length === 0 && !payments.isLoading && (
            <p className="py-1 text-xs text-faint">{t('No payments yet.')}</p>
          )}

          <ul className="divide-y divide-line/30 text-xs">
            {rows.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="font-mono text-muted">{p.paid_at ?? ''}</span>
                {/* Known ledger notes are translated (e.g. migration backfill). */}
                <span className="text-faint">{p.note ? t(p.note) : ''}</span>
                <span className="font-semibold text-success">+{money(Number(p.amount ?? 0))}</span>
                <button
                  onClick={() => delPay.mutate(p.id)}
                  disabled={delPay.isPending}
                  title={t('Delete')}
                  className="px-1 text-danger hover:underline disabled:opacity-40"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          {/* Document a partial payment / deposit by amount + date. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="number"
              min="0"
              step="any"
              className={cls}
              placeholder={t('Amount Paid')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitPayment()}
            />
            <label className="flex items-center gap-1 text-xs text-faint">
              {t('Date')}
              <input type="date" className={`${cls} w-36`} value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <button
              onClick={submitPayment}
              disabled={addPay.isPending}
              className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            >
              {t('Add Payment')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function Shipments({ supplier }: { supplier: Supplier }) {
  const { t } = useI18n()
  const purchases = usePurchases(supplier.id)
  const add = useAddPurchase()
  const [total, setTotal] = useState('')

  async function addShipment() {
    const amt = Number(total) || 0
    if (amt <= 0) return
    await add.mutateAsync({
      supplier_id: supplier.id,
      total_amount: amt,
      amount_paid: 0,
      purchase_date: new Date().toISOString(),
    })
    setTotal('')
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <h3 className="mb-2 font-semibold text-brand-dark">
        {t('Shipments')} — {supplier.name}
      </h3>
      {/* New shipments start UNPAID; any cash handed over at delivery is simply
          recorded as the first payment on the card below. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="number"
          min="0"
          step="any"
          className="w-32 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          placeholder={t('Total')}
          value={total}
          onChange={(e) => setTotal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addShipment()}
        />
        <button
          onClick={addShipment}
          disabled={add.isPending}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {t('Add')}
        </button>
        <span className="text-xs text-faint">{t('Record each payment inside the shipment below.')}</span>
      </div>

      {(purchases.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-faint">{t('No shipments.')}</p>
      ) : (
        <ul className="-mx-3 divide-y divide-line/40 overflow-hidden rounded-lg border border-line/60">
          {purchases.data!.map((p) => (
            <ShipmentCard key={p.id} purchase={p} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function SuppliersPage() {
  const { t } = useI18n()
  const suppliers = useSuppliers()
  const del = useDeleteSupplier()
  // Site-wide ledgers power the per-supplier outstanding badges.
  const allPurchases = usePurchases()
  const allPayments = useAllPurchasePayments()
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<Supplier | null>(null)

  const paidByPurchase = new Map<string, number>()
  for (const p of allPayments.data ?? []) {
    paidByPurchase.set(p.purchase_id, (paidByPurchase.get(p.purchase_id) ?? 0) + Number(p.amount ?? 0))
  }
  const outstandingBySupplier = new Map<string, number>()
  for (const s of allPurchases.data ?? []) {
    if (!s.supplier_id) continue
    const rem = Number(s.total_amount ?? 0) - (paidByPurchase.get(s.id) ?? Number(s.amount_paid ?? 0))
    outstandingBySupplier.set(s.supplier_id, (outstandingBySupplier.get(s.supplier_id) ?? 0) + rem)
  }

  function remove(s: Supplier) {
    // The mutation cascades: shipments (and their payment history) go first.
    const ok = window.confirm(`"${s.name}" — ${t('Delete supplier and all their shipments?')}`)
    if (!ok) return
    del.mutate(s.id, {
      onSuccess: () => {
        if (selected?.id === s.id) setSelected(null)
      },
    })
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Suppliers')}</h1>
        <button onClick={() => setAdding(true)} className="rounded-lg bg-brand px-4 py-2.5 font-semibold text-white">
          {t('+ Add Supplier')}
        </button>
      </div>

      {suppliers.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t('Error')}: {String(suppliers.error)}
        </div>
      )}
      {allPayments.isError && (
        <div className="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t((allPayments.error as Error).message)}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          {(suppliers.data?.length ?? 0) === 0 && !suppliers.isLoading && (
            <p className="p-4 text-sm text-faint">{t('No suppliers found')}</p>
          )}
          <ul className="divide-y divide-line/40">
            {(suppliers.data ?? []).map((s) => {
              const outstanding = outstandingBySupplier.get(s.id) ?? 0
              return (
                <li key={s.id} className={`flex items-center justify-between gap-2 px-4 py-3 ${selected?.id === s.id ? 'bg-brand-bg' : ''}`}>
                  <button onClick={() => setSelected(s)} className="min-w-0 text-start">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      {outstanding > 0 && (
                        <span className="shrink-0 text-xs font-semibold text-danger">
                          {t('Remaining')}: {money(outstanding)}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-faint">
                      {s.phone || ''} {s.email ? `· ${s.email}` : ''}
                    </div>
                  </button>
                  <button onClick={() => remove(s)} disabled={del.isPending} className="shrink-0 text-sm text-danger hover:underline disabled:opacity-40">
                    {t('Delete')}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div>
          {selected ? (
            <Shipments supplier={selected} />
          ) : (
            <div className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-faint">
              {t('Select a supplier to view shipments.')}
            </div>
          )}
        </div>
      </div>

      {adding && <SupplierForm onClose={() => setAdding(false)} />}
    </div>
  )
}
