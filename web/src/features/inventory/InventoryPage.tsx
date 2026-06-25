import { useMemo, useState } from 'react'
import {
  useAddProduct,
  useAdjustStock,
  useInventory,
  useUpdateProduct,
} from '../../data/inventory'
import type { Product } from '../../lib/database.types'

const CATEGORIES = ['Frame', 'Sunglasses', 'ContactLens', 'Lens', 'Accessory', 'Other']

type FormState = {
  name: string
  sku: string
  barcode: string
  category: string
  sale_price: string
  cost_price: string
  stock_qty: string
}

function blankForm(): FormState {
  return { name: '', sku: '', barcode: '', category: 'Frame', sale_price: '0', cost_price: '0', stock_qty: '0' }
}

function ProductModal({
  editing,
  onClose,
}: {
  editing: Product | null
  onClose: () => void
}) {
  const add = useAddProduct()
  const update = useUpdateProduct()
  const [form, setForm] = useState<FormState>(
    editing
      ? {
          name: editing.name ?? '',
          sku: editing.sku ?? '',
          barcode: editing.barcode ?? '',
          category: String(editing.category ?? 'Frame'),
          sale_price: String(editing.sale_price ?? 0),
          cost_price: String(editing.cost_price ?? 0),
          stock_qty: '0',
        }
      : blankForm(),
  )
  const [err, setErr] = useState<string | null>(null)

  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const cls = 'w-full rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'

  async function submit() {
    if (!form.name.trim()) {
      setErr('Name is required')
      return
    }
    try {
      const fields = {
        name: form.name.trim(),
        sku: form.sku.trim() || null,
        barcode: form.barcode.trim() || null,
        category: form.category,
        sale_price: Number(form.sale_price) || 0,
        cost_price: Number(form.cost_price) || 0,
      }
      if (editing) {
        await update.mutateAsync({ id: editing.id, patch: fields })
      } else {
        await add.mutateAsync({ ...fields, stock_qty: Number(form.stock_qty) || 0 })
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold text-brand-dark">
          {editing ? 'Edit Product' : 'New Product'}
        </h2>
        <div className="space-y-2">
          <input className={cls} placeholder="Name *" value={form.name} onChange={(e) => set('name', e.target.value)} />
          <div className="flex gap-2">
            <input className={cls} placeholder="SKU" value={form.sku} onChange={(e) => set('sku', e.target.value)} />
            <input className={cls} placeholder="Barcode" value={form.barcode} onChange={(e) => set('barcode', e.target.value)} />
          </div>
          <select className={cls} value={form.category} onChange={(e) => set('category', e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-faint">
              Sale Price
              <input type="number" className={cls} value={form.sale_price} onChange={(e) => set('sale_price', e.target.value)} />
            </label>
            <label className="flex-1 text-xs text-faint">
              Cost Price
              <input type="number" className={cls} value={form.cost_price} onChange={(e) => set('cost_price', e.target.value)} />
            </label>
            {!editing && (
              <label className="flex-1 text-xs text-faint">
                Initial Stock
                <input type="number" className={cls} value={form.stock_qty} onChange={(e) => set('stock_qty', e.target.value)} />
              </label>
            )}
          </div>
        </div>
        {err && <div className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-muted hover:bg-surface">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={add.isPending || update.isPending}
            className="rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export function InventoryPage() {
  const inv = useInventory()
  const adjust = useAdjustStock()
  const [term, setTerm] = useState('')
  const [modal, setModal] = useState<{ open: boolean; editing: Product | null }>({
    open: false,
    editing: null,
  })

  const products = useMemo(() => {
    const t = term.trim().toLowerCase()
    const list = inv.data ?? []
    if (!t) return list
    return list.filter(
      (p) =>
        (p.name ?? '').toLowerCase().includes(t) ||
        (p.sku ?? '').toLowerCase().includes(t) ||
        (p.barcode ?? '').toLowerCase().includes(t),
    )
  }, [inv.data, term])

  async function quickAdjust(p: Product, delta: number) {
    await adjust.mutateAsync({ productId: p.id, qtyChange: delta, note: 'Manual adjustment' })
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">Inventory</h1>
        <button
          onClick={() => setModal({ open: true, editing: null })}
          className="rounded-lg bg-brand px-4 py-2.5 font-semibold text-white"
        >
          + New Product
        </button>
      </div>

      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search name, SKU, barcode…"
        className="mb-4 w-full rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
      />

      {inv.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          Couldn't load inventory: {String(inv.error)}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th className="px-4 py-2">Product</th>
              <th className="px-4 py-2">Category</th>
              <th className="px-4 py-2 text-right">Price</th>
              <th className="px-4 py-2 text-center">Stock</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {products.length === 0 && !inv.isLoading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-faint">
                  No products.
                </td>
              </tr>
            )}
            {products.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-2">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-faint">{p.sku}</div>
                </td>
                <td className="px-4 py-2 text-muted">{p.category}</td>
                <td className="px-4 py-2 text-right">{Number(p.sale_price ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center justify-center gap-1.5">
                    <button onClick={() => quickAdjust(p, -1)} className="h-6 w-6 rounded border border-line text-muted hover:bg-surface">−</button>
                    <span className={`w-8 text-center font-semibold ${(p.stock_qty ?? 0) < 5 ? 'text-danger' : ''}`}>
                      {p.stock_qty ?? 0}
                    </span>
                    <button onClick={() => quickAdjust(p, 1)} className="h-6 w-6 rounded border border-line text-muted hover:bg-surface">+</button>
                  </div>
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => setModal({ open: true, editing: p })} className="text-brand hover:underline">
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal.open && (
        <ProductModal editing={modal.editing} onClose={() => setModal({ open: false, editing: null })} />
      )}
    </div>
  )
}
