import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

export type Supplier = {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
}
export type SupplierInsert = Omit<Supplier, 'id'> & { name: string }

export type Purchase = {
  id: string
  supplier_id: string | null
  total_amount: number | null
  amount_paid: number | null
  purchase_date: string | null
}
export type PurchaseInsert = Omit<Purchase, 'id'>

/** One dated installment/deposit toward a shipment's total. */
export type PurchasePayment = {
  id: string
  purchase_id: string
  amount: number | null
  paid_at: string | null
  note: string | null
}
export type PurchasePaymentInsert = Omit<PurchasePayment, 'id'>

const SKEY = ['suppliers'] as const
const PURCHASES_KEY = ['purchases'] as const
const PAYMENTS_KEY = ['purchase_payments'] as const

/** True when the payments ledger table isn't created yet (migration 003 not run). */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /purchase_payments/.test(error.message ?? '') && /(does not exist|schema cache|not found)/i.test(error.message ?? '')
}

function missingTableError(): Error {
  // The message doubles as an i18n key — see translations.ts.
  return new Error(
    'Payments ledger missing — run web/supabase/003_purchase_payments.sql in the Supabase SQL editor.',
  )
}

export function useSuppliers() {
  return useQuery({
    queryKey: SKEY,
    queryFn: async (): Promise<Supplier[]> => {
      const { data, error } = await supabase
        .from('suppliers')
        .select('*')
        .order('name')
        .returns<Supplier[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

export function useAddSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SupplierInsert): Promise<Supplier> => {
      const { data, error } = await supabase.from('suppliers').insert(input).select().single<Supplier>()
      if (error) throw error
      return data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SKEY }),
  })
}

export function useUpdateSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<SupplierInsert> }) => {
      const { error } = await supabase.from('suppliers').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SKEY }),
  })
}

/**
 * Delete a supplier AND their shipments. The FK has no ON DELETE CASCADE, so
 * deleting only the supplier fails whenever shipments exist — we therefore
 * remove the shipments ourselves first (their purchase_items/payments cascade
 * server-side). Returns how many shipments were removed for the confirm flow.
 */
export function useDeleteSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<number> => {
      const { data: rows, error: fErr } = await supabase
        .from('purchases')
        .select('id')
        .eq('supplier_id', id)
        .returns<{ id: string }[]>()
      if (fErr) throw fErr
      const ids = (rows ?? []).map((r) => r.id)

      if (ids.length) {
        const { error: dErr } = await supabase.from('purchases').delete().in('id', ids)
        if (dErr) throw dErr
      }

      const { error } = await supabase.from('suppliers').delete().eq('id', id)
      if (error) throw error
      return ids.length
    },
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
    queryFn: async (): Promise<Purchase[]> => {
      let q = supabase.from('purchases').select('*')
      if (supplierId) q = q.eq('supplier_id', supplierId)
      const { data, error } = await q.order('purchase_date', { ascending: false }).returns<Purchase[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

export function useAddPurchase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: PurchaseInsert): Promise<Purchase> => {
      const { data, error } = await supabase.from('purchases').insert(input).select().single<Purchase>()
      if (error) throw error
      return data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PURCHASES_KEY }),
  })
}

// ---- payment ledger (migration 003) ----

/** Every recorded payment — powers the per-supplier outstanding badges. */
export function useAllPurchasePayments() {
  return useQuery({
    queryKey: [...PAYMENTS_KEY, 'all'],
    queryFn: async (): Promise<PurchasePayment[]> => {
      const { data, error } = await supabase
        .from('purchase_payments')
        .select('*')
        .order('paid_at', { ascending: false })
        .returns<PurchasePayment[]>()
      if (isMissingTable(error)) throw missingTableError()
      if (error) throw error
      return data ?? []
    },
  })
}

/** Payments of ONE shipment, oldest first (reads like a running ledger). */
export function usePurchasePayments(purchaseId: string | null) {
  return useQuery({
    queryKey: [...PAYMENTS_KEY, purchaseId],
    enabled: !!purchaseId,
    queryFn: async (): Promise<PurchasePayment[]> => {
      const { data, error } = await supabase
        .from('purchase_payments')
        .select('*')
        .eq('purchase_id', purchaseId as string)
        .order('paid_at', { ascending: true })
        .order('created_at', { ascending: true })
        .returns<PurchasePayment[]>()
      if (isMissingTable(error)) throw missingTableError()
      if (error) throw error
      return data ?? []
    },
  })
}

export function useAddPurchasePayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: PurchasePaymentInsert): Promise<PurchasePayment> => {
      const { data, error } = await supabase
        .from('purchase_payments')
        .insert(input)
        .select()
        .single<PurchasePayment>()
      if (isMissingTable(error)) throw missingTableError()
      if (error) throw error
      return data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PAYMENTS_KEY })
    },
  })
}

export function useDeletePurchasePayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from('purchase_payments').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PAYMENTS_KEY }),
  })
}
