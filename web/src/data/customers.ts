import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

/**
 * Extended search: customers matching name / city / phone, PLUS customers
 * whose SALES carry a matching doctor name. Everything runs server-side with
 * hard limits (50) so it stays fast no matter how large the tables grow — it
 * never downloads the full customers/sales tables.
 */
export type CustomerSearchHit = Customer & { matchedDoctors: string[] }

export function useCustomerSearchExtended(term: string) {
  const q = term.replace(/[,()]/g, ' ').trim()
  return useQuery({
    queryKey: [...KEY, 'search-ext', q],
    enabled: q.length >= 2,
    queryFn: async (): Promise<CustomerSearchHit[]> => {
      const like = `%${q}%`
      const [custRes, docRes] = await Promise.all([
        supabase
          .from('customers')
          .select('*')
          .or(`name.ilike.${like},city.ilike.${like},phone.ilike.${like}`)
          .order('name')
          .limit(50)
          .returns<Customer[]>(),
        supabase
          .from('sales')
          .select('customer_id, doctor_name')
          .ilike('doctor_name', like)
          .limit(50)
          .returns<{ customer_id: string | null; doctor_name: string | null }[]>(),
      ])
      if (custRes.error) throw custRes.error
      if (docRes.error) throw docRes.error

      const byId = new Map<string, Customer>()
      for (const c of custRes.data ?? []) byId.set(c.id, c)

      const doctorsByCustomer = new Map<string, string[]>()
      const missing: string[] = []
      for (const s of docRes.data ?? []) {
        if (!s.customer_id || !s.doctor_name) continue
        const list = doctorsByCustomer.get(s.customer_id) ?? []
        if (!list.includes(s.doctor_name)) list.push(s.doctor_name)
        doctorsByCustomer.set(s.customer_id, list)
        if (!byId.has(s.customer_id)) missing.push(s.customer_id)
      }

      if (missing.length) {
        const { data: extra, error } = await supabase
          .from('customers')
          .select('*')
          .in('id', missing)
          .returns<Customer[]>()
        if (error) throw error
        for (const c of extra ?? []) byId.set(c.id, c)
      }

      const hits: CustomerSearchHit[] = [...byId.values()].map((c) => ({
        ...c,
        matchedDoctors: doctorsByCustomer.get(c.id) ?? [],
      }))
      hits.sort((a, b) => a.name.localeCompare(b.name))
      return hits
    },
  })
}

/** Paged, name-ordered customer list — grows gracefully via "load more". */
export function useInfiniteCustomers(pageSize = 60) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'paged'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<{ rows: Customer[]; count: number }> => {
      const offset = (pageParam as number) * pageSize
      const { data, error, count } = await supabase
        .from('customers')
        .select('*', { count: 'exact' })
        .order('name')
        .range(offset, offset + pageSize - 1)
        .returns<Customer[]>()
      if (error) throw error
      return { rows: data ?? [], count: count ?? 0 }
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((sum, p) => sum + p.rows.length, 0)
      return loaded < last.count ? all.length : undefined
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
