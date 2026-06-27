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

const SKEY = ['suppliers'] as const

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

export function useDeleteSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('suppliers').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SKEY }),
  })
}

/** Shipments / purchases, optionally for one supplier. */
export function usePurchases(supplierId?: string) {
  return useQuery({
    queryKey: ['purchases', supplierId ?? 'all'],
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchases'] }),
  })
}
