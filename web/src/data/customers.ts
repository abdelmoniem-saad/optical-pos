import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo, type DeleteCustomerInput } from '../lib/repository'
import type { CustomerInsert } from '../lib/database.types'

// Re-exported so existing imports from './customers' keep working.
export { CustomerHasRelatedRecordsError } from '../lib/repository'
export type { CustomerSearchHit, DeleteCustomerInput } from '../lib/repository'

const KEY = ['customers'] as const

/** All customers. Mirrors repo.getCustomers(). */
export function useCustomers() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => getRepo().getCustomers(),
  })
}

/** A single customer by id. */
export function useCustomer(id: string | null) {
  return useQuery({
    queryKey: [...KEY, id],
    enabled: !!id,
    queryFn: () => getRepo().getCustomer(id as string),
  })
}

/** Server-side name search. Mirrors repo.searchCustomers(). Pass a >=2 char term. */
export function useCustomerSearch(term: string) {
  const trimmed = term.trim()
  return useQuery({
    queryKey: [...KEY, 'search', trimmed],
    enabled: trimmed.length >= 2,
    queryFn: () => getRepo().searchCustomers(trimmed),
  })
}

/**
 * Extended search: customers matching name / city / phone, PLUS customers
 * whose SALES carry a matching doctor name. Everything runs server-side with
 * hard limits (50) so it stays fast no matter how large the tables grow - it
 * never downloads the full customers/sales tables.
 */
export function useCustomerSearchExtended(term: string) {
  const q = term.replace(/[,()]/g, ' ').trim()
  return useQuery({
    queryKey: [...KEY, 'search-ext', q],
    enabled: q.length >= 2,
    queryFn: () => getRepo().searchCustomersExtended(q),
  })
}

/** Paged, name-ordered customer list - grows gracefully via "load more". */
export function useInfiniteCustomers(pageSize = 60) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'paged'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getRepo().getCustomersPage(pageParam as number, pageSize),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((sum, p) => sum + p.rows.length, 0)
      return loaded < last.count ? all.length : undefined
    },
  })
}

export function useAddCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CustomerInsert) => getRepo().addCustomer(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useUpdateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<CustomerInsert> }) =>
      getRepo().updateCustomer(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: DeleteCustomerInput | string) => {
      const { id, cascade } = typeof input === 'string' ? { id: input, cascade: false } : input
      await getRepo().deleteCustomer(id, cascade)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
    },
  })
}
