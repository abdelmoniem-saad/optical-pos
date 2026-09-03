import { useRef, useState } from 'react'
import { usePOS, type CustomerDraft } from '../POSContext'
import { useI18n } from '../../../i18n/LanguageContext'
import { needsExamination } from '../types'
import { ExamSection } from './ExamSection'
import { enterMovesNext } from '../enterNav'
import { usePermissions } from '../../../data/permissions'
import { prescriptionImageUrl, uploadOrderImage } from '../../../lib/storage'

function money(n: number) {
  return n.toFixed(2)
}

export function CartStep() {
  const { t } = useI18n()
  const {
    state,
    totals,
    back,
    quickAdd,
    changeQty,
    removeFromCart,
    goToAdditional,
    setDiscount,
    setAmountPaid,
    setGross,
    finishOrder,
  } = usePOS()
  const [quick, setQuick] = useState('')
  const showExam = needsExamination(state.category)

  async function onQuickAdd() {
    await quickAdd(quick)
    setQuick('')
  }

  const field = 'w-32 rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'
  const stepTitle = showExam ? t('Step 3: Order & Payment') : t('Step 3: Cart & Payment')

  return (
    <div className="mx-auto max-w-6xl p-6" onKeyDown={enterMovesNext}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-xl font-bold text-brand-dark">{stepTitle}</h2>
        <div className="flex items-baseline gap-3">
          {/* The customer's name stays visible while selling - highlighted,
              no longer the tiny muted line it used to be. */}
          {state.customer && (
            <span className="text-lg font-bold text-brand-dark">
              {state.customerDraft.name.trim() || state.customer.name}
            </span>
          )}
          <span className="text-sm font-semibold text-brand">
            {t('Invoice')} #{state.invoiceNo}
          </span>
        </div>
      </div>

      {/* Editable customer details: changes save straight to the SAME
          customer record (on blur) and reflect everywhere instantly. */}
      {state.customer && (
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-line bg-white p-3 shadow-sm sm:grid-cols-3 lg:grid-cols-5">
          <CustomerField label={t('Name')} field="name" />
          <CustomerField label={t('Mobile Phone')} field="phone" />
          <CustomerField label={t('City')} field="city" />
          <CustomerField label={t('Email')} field="email" />
          <CustomerField label={t('Address')} field="address" />
        </div>
      )}

      {/* Order photos: the prescriptions paper and the frame picture. Attach
          here from the PC, or scan the QR shown in the receipt dialog after
          checkout to take both photos directly with the phone. */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white p-3 shadow-sm">
        <span className="text-xs font-semibold text-faint">{t('Order images')}</span>
        <OrderImageSlot slot="rx" label={t('Rx paper photo')} />
        <OrderImageSlot slot="frame" label={t('Frame photo')} />
      </div>

      {showExam && <ExamSection />}

      {!showExam && (
        <>
          <div className="mb-4 flex gap-2">
            <input
              data-skip-enter
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onQuickAdd()}
              placeholder={t('Quick add by SKU or name…')}
              className="flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
            />
            <button onClick={onQuickAdd} className="rounded-lg bg-brand px-4 py-2.5 font-semibold text-white">
              {t('Add')}
            </button>
            <button onClick={goToAdditional} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
              {t('Browse')}
            </button>
          </div>

          <div className="mb-4 overflow-hidden rounded-xl border border-line bg-white">
            <table className="w-full text-sm">
              <thead className="bg-surface text-start text-muted">
                <tr>
                  <th className="px-4 py-2">{t('Product')}</th>
                  <th className="px-4 py-2 text-center">{t('Qty')}</th>
                  <th className="px-4 py-2 text-end">{t('Price')}</th>
                  <th className="px-4 py-2 text-end">{t('Total')}</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/40">
                {state.cartItems.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-faint">
                      {t('Cart is empty.')}
                    </td>
                  </tr>
                )}
                {state.cartItems.map((i) => (
                  <tr key={i.product_id}>
                    <td className="px-4 py-2">{i.name}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => changeQty(i.product_id, i.qty - 1)}
                          className="h-7 w-7 rounded-md border border-line text-muted hover:bg-surface"
                        >
                          −
                        </button>
                        <span className="w-6 text-center font-semibold">{i.qty}</span>
                        <button
                          onClick={() => changeQty(i.product_id, i.qty + 1)}
                          className="h-7 w-7 rounded-md border border-line text-muted hover:bg-surface"
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-end">{money(i.unit_price)}</td>
                    <td className="px-4 py-2 text-end">{money(i.total_price)}</td>
                    <td className="px-4 py-2 text-end">
                      <button
                        onClick={() => removeFromCart(i.product_id)}
                        className="text-danger hover:underline"
                      >
                        {t('Remove')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
          <div className="font-semibold">{t('Pricing')}</div>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col text-xs text-faint">
              {t('Total Price')}
              <input
                type="number"
                className={field}
                value={totals.gross}
                onChange={(e) => setGross(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col text-xs text-faint">
              {t('Discount')}
              <input
                type="number"
                className={field}
                value={state.discount}
                onChange={(e) => setDiscount(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col text-xs text-faint">
              {t('Amount Paid')}
              <input
                type="number"
                className={field}
                value={state.amountPaid}
                onChange={(e) => setAmountPaid(Number(e.target.value))}
              />
            </label>
          </div>
        </div>

        <div className="space-y-1.5 rounded-xl bg-white p-4 shadow-sm text-sm">
          <Row label={t('Gross Total')} value={money(totals.gross)} bold />
          <Row label={t('Discount')} value={`- ${money(totals.discount)}`} />
          <div className="my-1 border-t border-line/40" />
          <Row label={t('Net Amount')} value={money(totals.net)} big success />
          <Row label={t('Amount Paid')} value={money(totals.amountPaid)} />
          <div className="my-1 border-t border-line/40" />
          <Row
            label={t('Remaining Balance')}
            value={money(totals.balance)}
            big
            danger={totals.balance > 0}
            success={totals.balance <= 0}
          />
        </div>
      </div>

      {state.error && (
        <div className="mt-4 whitespace-pre-line rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t(state.error)}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <button onClick={back} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
          {t('← Back')}
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => finishOrder()}
            disabled={state.busy}
            className="rounded-lg bg-success px-5 py-2.5 font-semibold text-white disabled:opacity-60"
          >
            {state.busy ? t('Saving…') : t('Finish Checkout →')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  bold,
  big,
  success,
  danger,
}: {
  label: string
  value: string
  bold?: boolean
  big?: boolean
  success?: boolean
  danger?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold || big ? 'font-semibold' : 'text-muted'}>{label}</span>
      <span
        className={[
          big ? 'text-lg font-bold' : bold ? 'font-semibold' : '',
          success ? 'text-success' : '',
          danger ? 'text-danger' : '',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}

/** Inline editable customer detail for the order step; saves to the DB on blur. */
function CustomerField({ label, field }: { label: string; field: keyof CustomerDraft }) {
  const { state, setCustomerDraft, saveCustomerEdits } = usePOS()
  return (
    <label className="flex flex-col">
      <span className="mb-0.5 text-[10px] font-semibold text-faint">{label}</span>
      <input
        className="rounded-md border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
        value={state.customerDraft[field]}
        onChange={(e) => setCustomerDraft({ [field]: e.target.value } as Partial<CustomerDraft>)}
        onBlur={(e) => saveCustomerEdits({ [field]: e.target.value } as Partial<CustomerDraft>)}
      />
    </label>
  )
}

/**
 * One of the two order photo slots (prescriptions paper / frame picture).
 * Attaching is free while the order is being made; replacing an attached
 * photo AFTER checkout is admin-only.
 */
function OrderImageSlot({ slot, label }: { slot: 'rx' | 'frame'; label: string }) {
  const { t } = useI18n()
  const perms = usePermissions()
  const { state, setOrderImage } = usePOS()
  const path = slot === 'rx' ? state.rxImagePath : state.frameImagePath
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const replaceLocked = !!path && !!state.savedSale && !perms.isAdmin

  return (
    <div className="flex items-center gap-2">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (!f) return
          setBusy(true)
          try {
            const p = await uploadOrderImage(f, state.invoiceNo, slot)
            setOrderImage(slot, p)
          } catch (err) {
            alert(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
            e.target.value = ''
          }
        }}
      />
      <button
        type="button"
        disabled={busy || replaceLocked}
        title={replaceLocked ? t('Replace requires admin') : label}
        onClick={() => fileRef.current?.click()}
        className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${
          path ? 'border-success/50 text-success' : 'border-line text-muted'
        } hover:bg-surface`}
      >
        📎 {busy ? '…' : label}
        {path ? ' ✓' : ''}
      </button>
      {path && (
        <a
          href={prescriptionImageUrl(path)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-brand hover:underline"
        >
          {t('View Image')}
        </a>
      )}
    </div>
  )
}
