import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'
import type { CreateSaleInput, SalesRange, UpdateSaleFullInput } from '../lib/repository'
import type { OrderExaminationInsert, Sale } from '../lib/database.types'

// Re-exported so existing imports from './sales' keep working.
export type { CartLine, CreateSaleInput, SalesRange, UpdateSaleFullInput } from '../lib/repository'

const KEY = ['sales'] as const
const SALES_PAGE = 50

/** Lean sales feed for aggregate screens (Reports): header columns ONLY. */
export function useSalesSummary() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => getRepo().getSalesSummary(),
  })
}

/** Paged, server-filtered sales feed for History. */
export function useInfiniteSales(range: SalesRange, term: string) {
  // Same sanitization the repository applies, so the cache key matches the
  // effective filter (as it did before the repository seam).
  const t = term.replace(/[,()]/g, ' ').trim()
  return useInfiniteQuery({
    queryKey: [...KEY, 'paged', range, t],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getRepo().getSalesPage(range, t, (pageParam as number) * SALES_PAGE, SALES_PAGE),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((sum, p) => sum + p.rows.length, 0)
      return loaded < last.count ? all.length : undefined
    },
  })
}

/** Paged lab feed: only orders that have a lab status, filtered in Postgres. */
export function useInfiniteLabSales(status: string) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'lab', status],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getRepo().getLabSalesPage(status, (pageParam as number) * SALES_PAGE, SALES_PAGE),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((sum, p) => sum + p.rows.length, 0)
      return loaded < last.count ? all.length : undefined
    },
  })
}

/** All of one customer's orders, with line items AND examinations embedded. */
export function useCustomerOrders(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-orders', customerId],
    enabled: !!customerId,
    queryFn: () => getRepo().getCustomerOrders(customerId as string),
  })
}

/** Next zero-padded invoice number. Mirrors repo.getNextInvoiceNo(). */
export async function getNextInvoiceNo(): Promise<string> {
  return getRepo().getNextInvoiceNo()
}

export function useCreateSale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSaleInput) => getRepo().createSale(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

export function useUpdateSaleFull() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateSaleFullInput) => getRepo().updateSaleFull(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
      qc.invalidateQueries({ queryKey: ['past_examinations'] })
    },
  })
}

export function useUpdateLabStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => getRepo().updateLabStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

/** Attach/replace one of an order's two photo slots (prescriptions paper or
 *  frame picture). `path === null` clears the slot. */
export function useSetOrderImage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ saleId, slot, path }: { saleId: string; slot: 'rx' | 'frame'; path: string | null }) =>
      getRepo().setOrderImage(saleId, slot, path),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

// ---- lab workflow vocabulary (single source of truth) ----

/** The ONLY lab statuses the Lab tab understands. Every editor/badge/filter
 *  must use these so colors and filters stay aligned across screens. */
export const LAB_STATUSES = ['Not Started', 'In Lab', 'Ready', 'Received'] as const

/** Badge classes per status - kept next to the vocabulary so they can't drift. */
export const LAB_STATUS_COLORS: Record<string, string> = {
  'Not Started': 'bg-surface text-muted',
  'In Lab': 'bg-warning-bg text-warning',
  Ready: 'bg-success-bg text-success',
  Received: 'bg-brand-bg text-brand-dark',
}

/** Patch header fields of an existing sale (doctor, totals, status, dates…). */
export function useUpdateSale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Sale> }) => getRepo().updateSale(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
    },
  })
}

/** Insert a standalone prescription for a customer with no cart items. */
export function useAddStandalonePrescription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      customerId: string
      exam: Omit<OrderExaminationInsert, 'sale_id'>
      doctorName?: string
    }) => getRepo().addStandalonePrescription(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
      qc.invalidateQueries({ queryKey: ['past_examinations'] })
    },
  })
}
