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

/** Thrown by useDeleteCustomer when the customer still has related rows
 *  (sales / prescriptions). Callers should confirm with the user and retry
 *  with `cascade: true` to delete the customer along with their orders and
 *  prescriptions. */
export class CustomerHasRelatedRecordsError extends Error {
  readonly orderCount: number
  readonly prescriptionCount: number
  constructor(orderCount: number, prescriptionCount: number) {
    super(
      'Cannot delete this customer because they have existing orders or prescriptions.',
    )
    this.name = 'CustomerHasRelatedRecordsError'
    this.orderCount = orderCount
    this.prescriptionCount = prescriptionCount
  }
}

async function countRelated(customerId: string) {
  const [salesRes, presRes] = await Promise.all([
    supabase
      .from('sales')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId),
    supabase
      .from('prescriptions')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId),
  ])
  return {
    orderCount: salesRes.count ?? 0,
    prescriptionCount: presRes.count ?? 0,
  }
}

export type DeleteCustomerInput = { id: string; cascade?: boolean }

export function useDeleteCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: DeleteCustomerInput | string): Promise<void> => {
      const { id, cascade } =
        typeof input === 'string' ? { id: input, cascade: false } : input

      // When cascading, remove the child rows that don't cascade automatically
      // from `customers` (sales are ON DELETE NO ACTION in the schema, while
      // prescriptions and sale_items/order_examinations do cascade). Deleting
      // the sales rows first triggers ON DELETE CASCADE for sale_items and
      // order_examinations, then deleting the customer cascades prescriptions.
      if (cascade) {
        const { error: salesErr } = await supabase
          .from('sales')
          .delete()
          .eq('customer_id', id)
        if (salesErr) throw salesErr
      }

      const { error } = await supabase.from('customers').delete().eq('id', id)
      if (error) {
        const code = (error as { code?: string }).code
        const msg = error.message?.toLowerCase() ?? ''
        const isFk =
          code === '23503' ||
          msg.includes('foreign key') ||
          msg.includes('violates')
        if (isFk && !cascade) {
          const { orderCount, prescriptionCount } = await countRelated(id)
          throw new CustomerHasRelatedRecordsError(orderCount, prescriptionCount)
        }
        throw error
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
    },
  })
}
