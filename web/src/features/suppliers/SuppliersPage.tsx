import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { localDateISO } from '../pos/POSContext'
import { usePermissions } from '../../data/permissions'
import { useInventory } from '../../data/inventory'
import { useConfirm } from '../../components/Feedback'
import {
  useAddPurchaseWithItems,
  useAddPurchasePayment,
  useAddSupplier,
  useAllPurchasePayments,
  useDeletePurchasePayment,
  useDeleteSupplier,
  usePurchaseItems,
  usePurchases,
  usePurchasePayments,
  useReceivePurchase,
  useSuppliers,
  type Purchase,
  type PurchaseItem,
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
  const items = usePurchaseItems(purchase.id)
  const receive = useReceivePurchase()
  const addPay = useAddPurchasePayment()
  const delPay = useDeletePurchasePayment()
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(localDateISO())

  const total = Number(purchase.total_amount ?? 0)
  const paidSum = (payments.data ?? []).reduce((sum, p) => sum + Number(p.amount ?? 0), 0)
  const remaining = total - paidSum
  const rows = payments.data ?? []

  // Receiving state. A shipment with no lines at all was recorded before 018
  // existed (or by the old total-only flow) and there is nothing to receive -
  // saying "not received" for it would be a permanent lie on a real row, so the
  // distinction is drawn explicitly.
  const itemRows = items.data ?? []
  const hasLines = itemRows.length > 0
  const outstanding = itemRows.filter((i) => !i.received_at).length
  const allReceived = hasLines && outstanding === 0

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

  async function doReceive() {
    if (!purchase.id || !outstanding) return
    await receive.mutateAsync(purchase.id)
  }

  const cls = 'w-24 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand'

  return (
    <li className="border-b border-line/40 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center justify-between gap-2 text-start text-sm hover:bg-surface/60">
          <span className="text-muted">{(purchase.purchase_date ?? '').slice(0, 10)}</span>
          <span className="font-semibold">{money(total)}</span>
          {/* Remaining: red while the supplier is still owed, green when settled. */}
          <span className={`text-xs font-semibold ${remaining > 0 ? 'text-danger' : 'text-success'}`}>
            {t('Remaining')}: {money(remaining)}
          </span>
          {/* Receiving state (migration 018). "Not received" is a money state,
              not a note: the shop has paid and the goods are not on the shelf. */}
          {hasLines && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                allReceived ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning'
              }`}
            >
              {allReceived
                ? t('Received')
                : `${t('Not received')} (${itemRows.length - outstanding}/${itemRows.length})`}
            </span>
          )}
          <span className="text-faint">{open ? '▲' : '▼'}</span>
        </button>

        {hasLines && !allReceived && (
          <button
            onClick={doReceive}
            disabled={receive.isPending}
            className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {receive.isPending ? t('Receiving…') : t('Receive into stock')}
          </button>
        )}
      </div>

      {receive.isError && (
        <div className="mx-3 mb-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t((receive.error as Error).message)}
        </div>
      )}

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

/** New shipment: which products arrived, how many, at what cost.
 *
 *  Before 018 this form had one field - a total - and no way to say WHAT was
 *  bought. That is why receiving could not work: there was no line item for the
 *  database to turn into stock. The total is now DERIVED from the lines rather
 *  than typed beside them, so the two cannot disagree: a shop can no longer
 *  record a 5000 EGP delivery with no products attached, which is precisely the
 *  state that made the inventory number wrong. */
function ShipmentForm({
  supplier,
  onClose,
}: {
  supplier: Supplier
  onClose: () => void
}) {
  const { t } = useI18n()
  const products = useInventory()
  const add = useAddPurchaseWithItems()
  const [lines, setLines] = useState<PurchaseItem[]>([])

  const total = lines.reduce((sum, l) => sum + l.qty * l.unit_cost, 0)
  const valid = lines.length > 0 && lines.every((l) => l.qty > 0 && !!l.product_id)

  function setLine(i: number, patch: Partial<PurchaseItem>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  async function submit() {
    if (!valid) return
    await add.mutateAsync({
      purchase: {
        supplier_id: supplier.id,
        total_amount: total,
        amount_paid: 0,
        purchase_date: new Date().toISOString(),
      },
      // total_cost is stored per line so the column is not a second source of
      // truth that can drift from qty * unit_cost.
      items: lines.map((l) => ({ ...l, total_cost: l.qty * l.unit_cost })),
    })
    onClose()
  }

  const input =
    'rounded-lg border border-line px-2 py-1.5 text-sm outline-none focus:border-brand'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-brand-dark">
          {t('+ Add Shipment')} - {supplier.name}
        </h2>
        <p className="mb-3 text-xs text-faint">
          {t('List what arrived so the stock can be counted in. The total is worked out for you.')}
        </p>

        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                className={`min-w-0 flex-1 ${input}`}
                value={l.product_id}
                onChange={(e) => setLine(i, { product_id: e.target.value })}
              >
                <option value="">{t('Choose a product…')}</option>
                {(products.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                step="1"
                className={`w-20 ${input}`}
                placeholder={t('Qty')}
                value={l.qty || ''}
                onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })}
              />
              <input
                type="number"
                min="0"
                step="any"
                className={`w-24 ${input}`}
                placeholder={t('Cost')}
                value={l.unit_cost || ''}
                onChange={(e) => setLine(i, { unit_cost: Number(e.target.value) || 0 })}
              />
              <span className="w-20 shrink-0 text-end text-sm tabular-nums text-muted">
                {(l.qty * l.unit_cost).toFixed(2)}
              </span>
              <button
                onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                className="shrink-0 text-sm text-danger hover:underline"
              >
                {t('Remove')}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              setLines((ls) => [...ls, { product_id: '', qty: 1, unit_cost: 0, total_cost: 0 }])
            }
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface"
          >
            {t('+ Add item')}
          </button>
          <span className="ms-auto text-sm">
            {t('Total')}:{' '}
            <span className="font-semibold tabular-nums">{total.toFixed(2)}</span>
          </span>
        </div>

        {add.isError && (
          <div className="mt-3 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
            {t((add.error as Error).message)}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-muted hover:bg-surface"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={submit}
            disabled={!valid || add.isPending}
            className="rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-60"
          >
            {add.isPending ? t('Saving…') : t('Save and receive')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Shipments({ supplier }: { supplier: Supplier }) {
  const { t } = useI18n()
  const purchases = usePurchases(supplier.id)
  const [adding, setAdding] = useState(false)

  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-semibold text-brand-dark">
          {t('Shipments')} - {supplier.name}
        </h3>
        {/* New shipments start UNPAID; any cash handed over at delivery is simply
            recorded as the first payment on the card below. */}
        <button
          onClick={() => setAdding(true)}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white"
        >
          {t('+ Add Shipment')}
        </button>
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

      {adding && <ShipmentForm supplier={supplier} onClose={() => setAdding(false)} />}
    </div>
  )
}

export function SuppliersPage() {
  const { t } = useI18n()
  const confirm = useConfirm()
  const suppliers = useSuppliers()
  const del = useDeleteSupplier()
  // Site-wide ledgers power the per-supplier outstanding badges.
  const allPurchases = usePurchases()
  const allPayments = useAllPurchasePayments()
  const perms = usePermissions()
  const canCreate = perms.isAdmin || perms.can('suppliers.create' as never)
  const canDelete = perms.isAdmin || perms.can('suppliers.delete' as never)
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

  async function remove(s: Supplier) {
    // The mutation cascades: shipments (and their payment history) go first.
    const ok = await confirm(`"${s.name}" - ${t('Delete supplier and all their shipments?')}`)
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
        {canCreate && (
          <button onClick={() => setAdding(true)} className="rounded-lg bg-brand px-4 py-2.5 font-semibold text-white">
            {t('+ Add Supplier')}
          </button>
        )}
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
                  <button onClick={() => remove(s)} disabled={del.isPending || !canDelete} className="shrink-0 text-sm text-danger hover:underline disabled:opacity-40">
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
