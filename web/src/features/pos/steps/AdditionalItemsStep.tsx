import { useMemo, useState } from 'react'
import { usePOS } from '../POSContext'
import { useInventory } from '../../../data/inventory'

const cats = ['All', 'Frame', 'Sunglasses', 'Accessory', 'Other'] as const

export function AdditionalItemsStep() {
  const { addProduct, back, saveExamsAndProceed, state } = usePOS()
  const [cat, setCat] = useState<(typeof cats)[number]>('All')
  const [term, setTerm] = useState('')

  const inv = useInventory(cat === 'All' ? undefined : cat)

  const products = useMemo(() => {
    const t = term.trim().toLowerCase()
    const list = inv.data ?? []
    if (!t) return list
    return list.filter(
      (p) =>
        (p.name ?? '').toLowerCase().includes(t) ||
        (p.sku ?? '').toLowerCase().includes(t),
    )
  }, [inv.data, term])

  const inCart = (id: string) => state.cartItems.some((i) => i.product_id === id)

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h2 className="text-xl font-bold text-brand-dark">Step 3: Add More Items</h2>
      <p className="mb-4 text-sm text-muted">Add accessories or other products to this order.</p>

      <div className="mb-4 flex flex-wrap gap-2">
        <select
          value={cat}
          onChange={(e) => setCat(e.target.value as (typeof cats)[number])}
          className="rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        >
          {cats.map((c) => (
            <option key={c} value={c}>
              {c === 'All' ? 'All Categories' : c}
            </option>
          ))}
        </select>
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search products…"
          className="flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        />
      </div>

      <div className="mb-4 max-h-80 overflow-auto rounded-xl border border-line bg-white">
        {inv.isLoading && <p className="p-4 text-sm text-muted">Loading…</p>}
        {!inv.isLoading && products.length === 0 && (
          <p className="p-4 text-sm text-faint">No products.</p>
        )}
        <ul className="divide-y divide-line/40">
          {products.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-2.5">
              <div>
                <div className="font-medium">
                  {p.name} <span className="text-xs text-faint">{p.sku}</span>
                </div>
                <div className="text-sm text-muted">
                  Price: {Number(p.sale_price ?? 0).toFixed(2)} · Stock: {p.stock_qty ?? 0}
                </div>
              </div>
              <button
                onClick={() => addProduct(p)}
                className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
              >
                {inCart(p.id) ? 'Add +1' : 'Add'}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between">
        <button onClick={back} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
          ← Back to Examination
        </button>
        <button
          onClick={() => saveExamsAndProceed()}
          disabled={state.busy}
          className="rounded-lg bg-success px-4 py-2.5 font-semibold text-white disabled:opacity-60"
        >
          Continue to Payment →
        </button>
      </div>
    </div>
  )
}
