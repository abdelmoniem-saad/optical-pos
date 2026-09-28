import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { isMissingRpc } from './rpc'

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
  // The message doubles as an i18n key - see translations.ts.
  return new Error(
    'Payments ledger missing - run web/supabase/003_purchase_payments.sql in the Supabase SQL editor.',
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
 * deleting only the supplier fails whenever shipments exist - we therefore
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

      // Migration 013 revoked the direct DELETE on purchases, so the cascade
      // goes through delete_purchase(), which re-checks tenancy and the licence.
      for (const pid of ids) {
        const { error: dErr } = await supabase.rpc('delete_purchase', { p_purchase: pid })
        if (dErr && !isMissingRpc('delete_purchase', dErr)) throw dErr
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

/** One line of a purchase: which product, how many, at what cost. */
export type PurchaseItem = {
  product_id: string
  qty: number
  unit_cost: number
  total_cost: number
}

export type PurchaseItemInsert = PurchaseItem & { purchase_id: string }

/** The line items of one shipment (migration 018).
 *
 *  `received_at` is what the Receive button keys off, and it is the only way a
 *  shop can tell "ordered" from "on the shelf". Null means paid for and not
 *  counted, which is the state that was previously invisible. */
export type PurchaseItemRow = PurchaseItem & {
  id: string
  received_at: string | null
  product_id: string | null
}

export function usePurchaseItems(purchaseId: string | null) {
  return useQuery({
    queryKey: ['purchase-items', purchaseId],
    enabled: !!purchaseId,
    queryFn: async (): Promise<PurchaseItemRow[]> => {
      const { data, error } = await supabase
        .from('purchase_items')
        .select('*')
        .eq('purchase_id', purchaseId as string)
        .order('created_at', { ascending: true })
        .returns<PurchaseItemRow[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

/** Receive a shipment into stock (migration 018).
 *
 *  Until this existed the app recorded a purchase as a bare TOTAL and never
 *  wrote a single `purchase_items` row, so there was no line for the database
 *  to receive and `stock_qty` never moved: the shop paid for frames, the money
 *  left, and the inventory screen disagreed with the delivery note. Returns how
 *  many lines were received so the UI can say "10 items" rather than implying
 *  the whole shipment was received. */
export function useReceivePurchase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (purchaseId: string): Promise<number> => {
      const { data, error } = await supabase.rpc('receive_purchase', { p_purchase: purchaseId })
      if (error) {
        // A pre-018 database has no such function. Say so by name rather than
        // surfacing a raw "does not exist" — the operator needs to know which
        // file to paste.
        if (isMissingRpc('receive_purchase', error)) {
          throw new Error('Receiving stock needs migration 018_purchase_stock.sql.')
        }
        throw error
      }
      return typeof data === 'number' ? data : 0
    },
    onSuccess: () => {
      // Stock moved and costs may have been re-averaged, so every inventory
      // view is now stale. Both keys, not just purchases.
      qc.invalidateQueries({ queryKey: PURCHASES_KEY })
      qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

/** Add the line items for a purchase, then receive them in one action.
 *
 *  Inserting the lines and receiving are two calls, so a failure between them
 *  would leave a shipment recorded but not on the shelf. That is recoverable —
 * `receive_purchase` skips lines already stamped, so pressing Receive again
 * picks up exactly what is outstanding — and the UI shows the difference. Doing
 * it in one mutation keeps the shop from counting frames twice. */
export function useAddPurchaseWithItems() {
  const qc = useQueryClient()
  const addPurchase = useAddPurchase()
  const receive = useReceivePurchase()
  return useMutation({
    mutationFn: async (input: {
      purchase: PurchaseInsert
      items: PurchaseItem[]
    }): Promise<{ purchase: Purchase; received: number }> => {
      const purchase = await addPurchase.mutateAsync(input.purchase)
      if (!input.items.length) return { purchase, received: 0 }

      const rows: PurchaseItemInsert[] = input.items.map((i) => ({
        ...i,
        purchase_id: purchase.id,
      }))
      const { error } = await supabase.from('purchase_items').insert(rows)
      if (error) throw error

      const received = await receive.mutateAsync(purchase.id)
      return { purchase, received }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PURCHASES_KEY }),
  })
}

// ---- payment ledger (migration 003) ----

/** Every recorded payment - powers the per-supplier outstanding badges. */
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
      // Migration 013 revoked the direct DELETE on purchase_payments too.
      const { error } = await supabase.rpc('delete_purchase_payment', { p_payment: id })
      if (error && !isMissingRpc('delete_purchase_payment', error)) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PAYMENTS_KEY }),
  })
}
