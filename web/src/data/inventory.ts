import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import { isMissingRpc } from './rpc'
import type { Product, ProductInsert } from '../lib/database.types'

const KEY = ['inventory'] as const

/** True when the query failed because inventory.stock_qty doesn't exist yet
 *  (migration 012 unapplied - PostgREST answers PGRST204, plain SQL 42703). */
function isMissingStockColumn(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false
  return error.code === 'PGRST204' || error.code === '42703'
}

/** Cached answer to "does inventory.stock_qty exist?" (migration 012).
 *  One tiny probe per session: 012+ databases read the column and never
 *  download the movement ledger again; pre-012 databases keep the old
 *  browser-side aggregation (with a console warning) instead of showing 0. */
let stockColumnProbe: boolean | null = null
async function hasStockQtyColumn(): Promise<boolean> {
  if (stockColumnProbe !== null) return stockColumnProbe
  const { error } = await supabase.from('inventory').select('stock_qty').limit(1)
  if (error && isMissingStockColumn(error)) {
    stockColumnProbe = false
    console.warn(
      'inventory.stock_qty missing (run 012_integrity.sql) - aggregating movements in the browser',
    )
    return false
  }
  if (error) throw error
  stockColumnProbe = true
  return true
}

/**
 * Inventory list. Since migration 012 `stock_qty` is a real, DB-maintained
 * column, so this is ONE table query no matter how much history exists.
 * Pre-012 databases (probe fails) fall back to pulling all movements once and
 * aggregating client-side - the slow path 012 exists to remove.
 */
export function useInventory(category?: string) {
  return useQuery({
    queryKey: [...KEY, category ?? 'all'],
    queryFn: async (): Promise<Product[]> => {
      let q = supabase.from('inventory').select('*')
      if (category) q = q.eq('category', category)
      const { data: items, error } = await q.order('name').returns<Product[]>()
      if (error) throw error

      if (await hasStockQtyColumn()) return items ?? []

      const { data: movements, error: mErr } = await supabase
        .from('stock_movements')
        .select('product_id, qty')
        .returns<{ product_id: string; qty: number }[]>()
      if (mErr) throw mErr

      const stock = new Map<string, number>()
      for (const m of movements ?? []) {
        stock.set(m.product_id, (stock.get(m.product_id) ?? 0) + (m.qty ?? 0))
      }
      return (items ?? []).map((p) => ({ ...p, stock_qty: stock.get(p.id) ?? 0 }))
    },
  })
}

/**
 * Find an existing Frame product by name (case-insensitive) or create a
 * zero-priced one, so a free-typed frame name becomes a first-class option in
 * every frame dropdown afterwards. Mirrors what POS checkout does for New
 * frames - exposed here so other screens (History order editor) reuse it.
 */
export async function ensureFrameProduct(name: string): Promise<Product | null> {
  const raw = name.trim()
  if (!raw) return null
  const clean = raw.split(' (')[0].trim() || raw
  try {
    const { data: existing } = await supabase
      .from('inventory')
      .select('*')
      .eq('category', 'Frame')
      .ilike('name', clean)
      .limit(1)
      .returns<Product[]>()
    if (existing && existing.length) return existing[0]

    const { data: anyExisting } = await supabase
      .from('inventory')
      .select('*')
      .ilike('name', clean)
      .limit(1)
      .returns<Product[]>()
    if (anyExisting && anyExisting.length) return anyExisting[0]

    const { data: created, error } = await supabase
      .from('inventory')
      .insert({ name: clean, category: 'Frame', sale_price: 0, cost_price: 0 })
      .select()
      .maybeSingle<Product>()
    if (error) {
      console.warn('Could not auto-create frame product in inventory:', error)
      return null
    }
    void queryClient.invalidateQueries({ queryKey: KEY })
    return created
  } catch (e) {
    console.warn('ensureFrameProduct failed:', e)
    return null
  }
}

/** Current stock for a single product (012: the stock_qty read model;
 *  pre-012: sum of that product's movement rows). */
export function useProductStock(productId: string | null) {
  return useQuery({
    queryKey: ['stock', productId],
    enabled: !!productId,
    queryFn: async (): Promise<number> => {
      if (await hasStockQtyColumn()) {
        const { data, error } = await supabase
          .from('inventory')
          .select('stock_qty')
          .eq('id', productId as string)
          .maybeSingle<{ stock_qty: number | null }>()
        if (error) throw error
        return data?.stock_qty ?? 0
      }
      const { data, error } = await supabase
        .from('stock_movements')
        .select('qty')
        .eq('product_id', productId as string)
        .returns<{ qty: number }[]>()
      if (error) throw error
      return (data ?? []).reduce((sum, m) => sum + (m.qty ?? 0), 0)
    },
  })
}

export function useAddProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: ProductInsert): Promise<Product> => {
      const { stock_qty = 0, ...fields } = input

      // Preferred path (migration 012): product + opening stock in ONE
      // transaction, so a failure can never leave one without the other.
      const { data: created, error: rpcErr } = await supabase.rpc('add_inventory_item', {
        p_product: fields,
        p_initial_stock: stock_qty,
      })
      if (!rpcErr) {
        if (created) return created as Product
        throw new Error('add_inventory_item() returned nothing')
      }
      if (!isMissingRpc('add_inventory_item', rpcErr)) throw rpcErr

      // Legacy (pre-012): the historical two-step insert.
      const { data, error } = await supabase
        .from('inventory')
        .insert(fields)
        .select()
        .single<Product>()
      if (error) throw error
      if (stock_qty > 0) {
        await supabase.from('stock_movements').insert({
          product_id: data.id,
          qty: stock_qty,
          type: 'initial',
          note: 'Initial stock',
          created_at: new Date().toISOString(),
        })
      }
      return data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useUpdateProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string
      patch: Partial<Omit<ProductInsert, 'stock_qty'>>
    }): Promise<void> => {
      const { error } = await supabase.from('inventory').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

/** Adjust stock by recording a movement. Mirrors repo.adjust_stock(). */
export function useAdjustStock() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      productId,
      qtyChange,
      type = 'adjustment',
      note = '',
      refNo = '',
    }: {
      productId: string
      qtyChange: number
      type?: string
      note?: string
      refNo?: string
    }): Promise<void> => {
      const { error } = await supabase.from('stock_movements').insert({
        product_id: productId,
        qty: qtyChange,
        type,
        ref_no: refNo,
        note,
        created_at: new Date().toISOString(),
      })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['stock'] })
    },
  })
}
