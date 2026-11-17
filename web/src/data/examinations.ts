import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'
import type { OrderExamination } from '../lib/database.types'

// Re-exported so existing imports from './examinations' keep working.
export type { PastExam } from '../lib/repository'

/** Examinations for a single sale. Mirrors repo.getOrderExaminations(). */
export function useOrderExaminations(saleId: string | null) {
  return useQuery({
    queryKey: ['order_examinations', saleId],
    enabled: !!saleId,
    queryFn: () => getRepo().getOrderExaminations(saleId as string),
  })
}

/**
 * Replace ALL of one sale's examinations (History order editor). Non-atomic
 * delete+reinsert - same parity as the rest of the multi-step flows until the
 * RPC hardening lands. The customer profile reads these same rows, so edits
 * here are reflected there automatically.
 */
export function useReplaceOrderExaminations(saleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (exams: Omit<OrderExamination, 'id' | 'sale_id'>[]) =>
      getRepo().replaceOrderExaminations(saleId, exams),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['order_examinations', saleId] })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
      qc.invalidateQueries({ queryKey: ['past_examinations'] })
      qc.invalidateQueries({ queryKey: ['sales'] })
    },
  })
}

/**
 * A customer's recent examinations with sale info attached.
 * Mirrors repo.getPastExaminations(): two-step query (sales, then exams by
 * sale_id), newest first, capped at 10.
 */
export function usePastExaminations(customerId: string | null) {
  return useQuery({
    queryKey: ['past_examinations', customerId],
    enabled: !!customerId,
    queryFn: () => getRepo().getPastExaminations(customerId as string),
  })
}
