import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Customer, CustomerInsert } from '../lib/database.types'

const KEY = ['customers'] as const

/** All customers. Mirrors repo.get_customers(). */
export function useCustomers() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Customer[]> => {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('name')
        .returns<Customer[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

/** Server-side name search. Mirrors repo.search_customers(). Pass a >=2 char term. */
export function useCustomerSearch(term: string) {
  const trimmed = term.trim()
  return useQuery({
    queryKey: [...KEY, 'search', trimmed],
    enabled: trimmed.length >= 2,
    queryFn: async (): Promise<Customer[]> => {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .ilike('name', `%${trimmed}%`)
        .limit(10)
        .returns<Customer[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

export function useAddCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CustomerInsert): Promise<Customer> => {
      const { data, error } = await supabase
        .from('customers')
        .insert(input)
        .select()
        .single<Customer>()
      if (error) throw error
      return data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useUpdateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string
      patch: Partial<CustomerInsert>
    }): Promise<void> => {
      const { error } = await supabase.from('customers').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from('customers').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
