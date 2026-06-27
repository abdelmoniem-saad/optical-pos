import { useMemo, useState } from 'react'
import { usePOS } from '../POSContext'
import { useI18n } from '../../../i18n/LanguageContext'
import { useInventory } from '../../../data/inventory'

const cats = ['All', 'Frame', 'Sunglasses', 'Accessory', 'Other'] as const

export function AdditionalItemsStep() {
  const { t } = useI18n()
  const { addProduct, back, saveExamsAndProceed, state } = usePOS()
  const [cat, setCat] = useState<(typeof cats)[number]>('All')
  const [term, setTerm] = useState('')

  const inv = useInventory(cat === 'All' ? undefined : cat)

  const products = useMemo(() => {
    const tt = term.trim().toLowerCase()
    const list = inv.data ?? []
    if (!tt) return list
    return list.filter(
      (p) =>
        (p.name ?? '').toLowerCase().includes(tt) ||
        (p.sku ?? '').toLowerCase().includes(tt),
    )
  }, [inv.data, term])

  const inCart = (id: string) => state.cartItems.some((i) => i.product_id === id)

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h2 className="text-xl font-bold text-brand-dark">{t('Step 3: Add More Items')}</h2>
      <p className="mb-4 text-sm text-muted">{t('Add accessories or other products to this order.')}</p>

      <div className="mb-4 flex flex-wrap gap-2">
        <select
          value={cat}
          onChange={(e) => setCat(e.target.value as (typeof cats)[number])}
          className="rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        >
          {cats.map((c) => (
            <option key={c} value={c}>
              {c === 'All' ? t('All Categories') : t(c)}
            </option>
          ))}
        </select>
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t('Search products…')}
          className="flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
        />
      </div>

      <div className="mb-4 max-h-80 overflow-auto rounded-xl border border-line bg-white">
        {inv.isLoading && <p className="p-4 text-sm text-muted">{t('Loading…')}</p>}
        {!inv.isLoading && products.length === 0 && (
          <p className="p-4 text-sm text-faint">{t('No products.')}</p>
        )}
        <ul className="divide-y divide-line/40">
          {products.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-2.5">
              <div>
                <div className="font-medium">
                  {p.name} <span className="text-xs text-faint">{p.sku}</span>
                </div>
                <div className="text-sm text-muted">
                  {t('Price')}: {Number(p.sale_price ?? 0).toFixed(2)} · {t('Stock')}: {p.stock_qty ?? 0}
                </div>
              </div>
              <button
                onClick={() => addProduct(p)}
                className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
              >
                {inCart(p.id) ? t('Add +1') : t('Add')}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between">
        <button onClick={back} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
          {t('← Back to Examination')}
        </button>
        <button
          onClick={() => saveExamsAndProceed()}
          disabled={state.busy}
          className="rounded-lg bg-success px-4 py-2.5 font-semibold text-white disabled:opacity-60"
        >
          {t('Continue to Payment →')}
        </button>
      </div>
    </div>
  )
}
