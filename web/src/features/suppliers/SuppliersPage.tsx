import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import {
  useAddPurchase,
  useAddSupplier,
  useDeleteSupplier,
  usePurchases,
  useSuppliers,
  type Supplier,
} from '../../data/suppliers'

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

function Shipments({ supplier }: { supplier: Supplier }) {
  const { t } = useI18n()
  const purchases = usePurchases(supplier.id)
  const add = useAddPurchase()
  const [total, setTotal] = useState('')
  const [paid, setPaid] = useState('')

  async function addShipment() {
    const amt = Number(total) || 0
    if (amt <= 0) return
    await add.mutateAsync({
      supplier_id: supplier.id,
      total_amount: amt,
      amount_paid: Number(paid) || 0,
      purchase_date: new Date().toISOString(),
    })
    setTotal('')
    setPaid('')
  }

  const cls = 'w-28 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand'

  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <h3 className="mb-2 font-semibold text-brand-dark">{t('Shipments')} — {supplier.name}</h3>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input type="number" className={cls} placeholder={t('Total')} value={total} onChange={(e) => setTotal(e.target.value)} />
        <input type="number" className={cls} placeholder={t('Amount Paid')} value={paid} onChange={(e) => setPaid(e.target.value)} />
        <button onClick={addShipment} disabled={add.isPending} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {t('Add')}
        </button>
      </div>
      {(purchases.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-faint">{t('No shipments.')}</p>
      ) : (
        <ul className="divide-y divide-line/40 text-sm">
          {purchases.data!.map((p) => (
            <li key={p.id} className="flex justify-between py-1.5">
              <span className="text-muted">{(p.purchase_date ?? '').slice(0, 10)}</span>
              <span>
                {Number(p.total_amount ?? 0).toFixed(2)}
                <span className="text-faint"> · {t('Paid')} {Number(p.amount_paid ?? 0).toFixed(2)}</span>
              </span>
            </li>
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
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<Supplier | null>(null)

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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          {(suppliers.data?.length ?? 0) === 0 && !suppliers.isLoading && (
            <p className="p-4 text-sm text-faint">{t('No suppliers found')}</p>
          )}
          <ul className="divide-y divide-line/40">
            {(suppliers.data ?? []).map((s) => (
              <li key={s.id} className={`flex items-center justify-between px-4 py-3 ${selected?.id === s.id ? 'bg-brand-bg' : ''}`}>
                <button onClick={() => setSelected(s)} className="text-start">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-faint">{s.phone || ''} {s.email ? `· ${s.email}` : ''}</div>
                </button>
                <button onClick={() => del.mutate(s.id)} className="text-sm text-danger hover:underline">
                  {t('Delete')}
                </button>
              </li>
            ))}
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
