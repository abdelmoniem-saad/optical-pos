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

/** A single customer by id. */
export function useCustomer(id: string | null) {
  return useQuery({
    queryKey: [...KEY, id],
    enabled: !!id,
    queryFn: async (): Promise<Customer | null> => {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('id', id as string)
        .maybeSingle<Customer>()
      if (error) throw error
      return data
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

/** Extended search: matches a customer by name / city / phone, and also by
 *  the doctor name attached to any of their sales. Returns each matching
 *  customer with the list of unique doctor names that matched the term (used
 *  to render "Dr. …" under the phone). Client-side filtering is fine given
 *  the shop's data volume — mirrors what the Flet app does on the desktop. */
export type CustomerSearchHit = Customer & { matchedDoctors: string[] }

export function useCustomerSearchExtended(term: string) {
  const trimmed = term.trim()
  return useQuery({
    queryKey: [...KEY, 'search-ext', trimmed],
    enabled: trimmed.length >= 2,
    queryFn: async (): Promise<CustomerSearchHit[]> => {
      const q = trimmed.toLowerCase()
      const { data: customers, error: cErr } = await supabase
        .from('customers')
        .select('*')
        .order('name')
        .returns<Customer[]>()
      if (cErr) throw cErr
      const { data: sales, error: sErr } = await supabase
        .from('sales')
        .select('customer_id, doctor_name')
        .not('customer_id', 'is', null)
        .returns<{ customer_id: string; doctor_name: string | null }[]>()
      if (sErr) throw sErr

      // Group all doctor names per customer for doctor-name matching.
      const doctorsByCustomer = new Map<string, string[]>()
      for (const s of sales ?? []) {
        if (!s.customer_id || !s.doctor_name) continue
        const arr = doctorsByCustomer.get(s.customer_id) ?? []
        arr.push(s.doctor_name)
        doctorsByCustomer.set(s.customer_id, arr)
      }

      const hits: CustomerSearchHit[] = []
      for (const c of customers ?? []) {
        const inField = (v: string | null | undefined) =>
          !!v && v.toLowerCase().includes(q)
        const matched = (doctorsByCustomer.get(c.id) ?? []).filter((d) =>
          d.toLowerCase().includes(q),
        )
        // Preserve duplicates (same doctor across two orders is valid signal
        // per the requirement) but drop exact-duplicate strings only.
        const seen = new Set<string>()
        const matchedDoctors = matched.filter((d) => {
          const k = d.trim()
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        if (
          inField(c.name) ||
          inField(c.city) ||
          inField(c.phone) ||
          matchedDoctors.length > 0
        ) {
          hits.push({ ...c, matchedDoctors })
        }
      }
      return hits.slice(0, 50)
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
      if (error) {
        // Postgres FK violation → customer still referenced by sales /
        // prescriptions. Translate to something the shop staff can act on
        // instead of dumping the raw SQLSTATE.
        const code = (error as { code?: string }).code
        const msg = error.message?.toLowerCase() ?? ''
        if (code === '23503' || msg.includes('foreign key') || msg.includes('violates')) {
          throw new Error(
            'Cannot delete this customer because they have existing orders or prescriptions.',
          )
        }
        throw error
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
