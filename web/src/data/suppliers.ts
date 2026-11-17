import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo, type PurchaseInsert, type PurchasePaymentInsert, type SupplierInsert } from '../lib/repository'

// Re-exported so existing imports from './suppliers' keep working.
export type {
  Supplier,
  SupplierInsert,
  Purchase,
  PurchaseInsert,
  PurchasePayment,
  PurchasePaymentInsert,
} from '../lib/repository'

const SKEY = ['suppliers'] as const
const PURCHASES_KEY = ['purchases'] as const
const PAYMENTS_KEY = ['purchase_payments'] as const

export function useSuppliers() {
  return useQuery({
    queryKey: SKEY,
    queryFn: () => getRepo().getSuppliers(),
  })
}

export function useAddSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SupplierInsert) => getRepo().addSupplier(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: SKEY }),
  })
}

export function useUpdateSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<SupplierInsert> }) =>
      getRepo().updateSupplier(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: SKEY }),
  })
}

/**
 * Delete a supplier AND their shipments. The FK has no ON DELETE CASCADE, so
 * deleting only the supplier fails whenever shipments exist - we therefore
 * remove the shipments ourselves first (their purchase_items/payments cascade
 * server-side). Returns how many shipments were removed for the confirm flow.
 */
export function useDeleteSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => getRepo().deleteSupplier(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SKEY })
      qc.invalidateQueries({ queryKey: PURCHASES_KEY })
      qc.invalidateQueries({ queryKey: PAYMENTS_KEY })
    },
  })
}

/** Shipments / purchases, optionally scoped to one supplier. */
export function usePurchases(supplierId?: string) {
  return useQuery({
    queryKey: [...PURCHASES_KEY, supplierId ?? 'all'],
    queryFn: () => getRepo().getPurchases(supplierId),
  })
}

export function useAddPurchase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: PurchaseInsert) => getRepo().addPurchase(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: PURCHASES_KEY }),
  })
}

// ---- payment ledger (migration 003) ----

/** Every recorded payment - powers the per-supplier outstanding badges. */
export function useAllPurchasePayments() {
  return useQuery({
    queryKey: [...PAYMENTS_KEY, 'all'],
    queryFn: () => getRepo().getAllPurchasePayments(),
  })
}

/** Payments of ONE shipment, oldest first (reads like a running ledger). */
export function usePurchasePayments(purchaseId: string | null) {
  return useQuery({
    queryKey: [...PAYMENTS_KEY, purchaseId],
    enabled: !!purchaseId,
    queryFn: () => getRepo().getPurchasePayments(purchaseId as string),
  })
}

export function useAddPurchasePayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: PurchasePaymentInsert) => getRepo().addPurchasePayment(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PAYMENTS_KEY })
    },
  })
}

export function useDeletePurchasePayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => getRepo().deletePurchasePayment(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: PAYMENTS_KEY }),
  })
}
