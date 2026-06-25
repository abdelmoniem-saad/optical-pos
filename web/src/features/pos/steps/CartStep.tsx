import { useState } from 'react'
import { usePOS } from '../POSContext'

function money(n: number) {
  return n.toFixed(2)
}

export function CartStep() {
  const {
    state,
    totals,
    back,
    quickAdd,
    changeQty,
    removeFromCart,
    clearCart,
    goToAdditional,
    setDiscount,
    setAmountPaid,
    setUseCustomPrice,
    setCustomGross,
    finishOrder,
  } = usePOS()
  const [quick, setQuick] = useState('')

  async function onQuickAdd() {
    await quickAdd(quick)
    setQuick('')
  }

  const field = 'w-32 rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xl font-bold text-brand-dark">Step 4: Cart &amp; Payment</h2>
        <span className="text-sm font-semibold text-brand">Invoice #{state.invoiceNo}</span>
      </div>
      <p className="mb-4 text-sm text-muted">{state.customer?.name ?? 'Walk-in'}</p>

      <div className="mb-4 flex gap-2">
        <input
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onQuickAdd()}
          placeholder="Quick add by SKU or name…"
          className="flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        />
        <button onClick={onQuickAdd} className="rounded-lg bg-brand px-4 py-2.5 font-semibold text-white">
          Add
        </button>
        <button onClick={goToAdditional} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
          Browse
        </button>
      </div>

      {/* Cart table */}
      <div className="mb-4 overflow-hidden rounded-xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th className="px-4 py-2">Product</th>
              <th className="px-4 py-2 text-center">Qty</th>
              <th className="px-4 py-2 text-right">Price</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {state.cartItems.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-faint">
                  Cart is empty.
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
                <td className="px-4 py-2 text-right">{money(i.unit_price)}</td>
                <td className="px-4 py-2 text-right">{money(i.total_price)}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => removeFromCart(i.product_id)}
                    className="text-danger hover:underline"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pricing + totals */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
          <div className="font-semibold">Pricing</div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={state.useCustomPrice}
              onChange={(e) => setUseCustomPrice(e.target.checked)}
            />
            Use custom gross price
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col text-xs text-faint">
              Custom Gross
              <input
                type="number"
                className={field}
                disabled={!state.useCustomPrice}
                value={state.useCustomPrice ? state.customGross : totals.gross}
                onChange={(e) => setCustomGross(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col text-xs text-faint">
              Discount
              <input
                type="number"
                className={field}
                value={state.discount}
                onChange={(e) => setDiscount(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col text-xs text-faint">
              Amount Paid
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
          <Row label="Gross Total" value={money(totals.gross)} bold />
          <Row label="Discount" value={`- ${money(totals.discount)}`} />
          <div className="my-1 border-t border-line/40" />
          <Row label="Net Amount" value={money(totals.net)} big success />
          <Row label="Amount Paid" value={money(totals.amountPaid)} />
          <div className="my-1 border-t border-line/40" />
          <Row
            label="Remaining Balance"
            value={money(totals.balance)}
            big
            danger={totals.balance > 0}
            success={totals.balance <= 0}
          />
        </div>
      </div>

      {state.error && (
        <div className="mt-4 whitespace-pre-line rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {state.error}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <button onClick={back} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
          ← Back
        </button>
        <div className="flex gap-2">
          <button onClick={clearCart} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
            Clear Cart
          </button>
          <button
            onClick={() => finishOrder()}
            disabled={state.busy}
            className="rounded-lg bg-success px-5 py-2.5 font-semibold text-white disabled:opacity-60"
          >
            {state.busy ? 'Saving…' : 'Finish Checkout →'}
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
