import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import type { Product, ProductInsert } from '../lib/database.types'

const KEY = ['inventory'] as const

/**
 * Inventory with stock_qty computed from stock_movements.
 *
 * repository.py does this per-item (N+1). We instead pull all movements once
 * and aggregate client-side - one extra query total, no N+1. A future
 * optimization is a Postgres view/RPC `inventory_with_stock` (Phase 7).
 */
export function useInventory(category?: string) {
  return useQuery({
    queryKey: [...KEY, category ?? 'all'],
    queryFn: async (): Promise<Product[]> => {
      let q = supabase.from('inventory').select('*')
      if (category) q = q.eq('category', category)
      const { data: items, error } = await q.order('name').returns<Product[]>()
      if (error) throw error

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

/** Current stock for a single product. Mirrors repo.get_product_stock(). */export function useProductStock(productId: string | null) {
  return useQuery({
    queryKey: ['stock', productId],
    enabled: !!productId,
    queryFn: async (): Promise<number> => {
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
