import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'
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
    queryFn: () => getRepo().getInventory(category),
  })
}

/**
 * Find an existing Frame product by name (case-insensitive) or create a
 * zero-priced one, so a free-typed frame name becomes a first-class option in
 * every frame dropdown afterwards. Mirrors what POS checkout does for New
 * frames - exposed here so other screens (History order editor) reuse it.
 */
export async function ensureFrameProduct(name: string): Promise<Product | null> {
  return getRepo().ensureFrameProduct(name)
}

/** Current stock for a single product. Mirrors repo.getProductStock(). */
export function useProductStock(productId: string | null) {
  return useQuery({
    queryKey: ['stock', productId],
    enabled: !!productId,
    queryFn: () => getRepo().getProductStock(productId as string),
  })
}

export function useAddProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ProductInsert) => getRepo().addProduct(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useUpdateProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Omit<ProductInsert, 'stock_qty'>> }) =>
      getRepo().updateProduct(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

/** Adjust stock by recording a movement. Mirrors repo.adjustStock(). */
export function useAdjustStock() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      productId: string
      qtyChange: number
      type?: string
      note?: string
      refNo?: string
    }) => getRepo().adjustStock(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['stock'] })
    },
  })
}
