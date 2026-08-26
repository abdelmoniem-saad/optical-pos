import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { OrderExamination, Sale } from '../lib/database.types'

/** Examinations for a single sale. Mirrors repo.get_order_examinations(sale_id). */
export function useOrderExaminations(saleId: string | null) {
  return useQuery({
    queryKey: ['order_examinations', saleId],
    enabled: !!saleId,
    queryFn: async (): Promise<OrderExamination[]> => {
      const { data, error } = await supabase
        .from('order_examinations')
        .select('*')
        .eq('sale_id', saleId as string)
        .returns<OrderExamination[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

export type PastExam = OrderExamination & { sale: Partial<Sale> }

/**
 * Replace ALL of one sale's examinations (History order editor). Non-atomic
 * delete+reinsert — same parity as the rest of the multi-step flows until the
 * RPC hardening lands. The customer profile reads these same rows, so edits
 * here are reflected there automatically.
 */
export function useReplaceOrderExaminations(saleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (
      exams: Omit<OrderExamination, 'id' | 'sale_id'>[],
    ): Promise<void> => {
      const { error: delErr } = await supabase
        .from('order_examinations')
        .delete()
        .eq('sale_id', saleId)
      if (delErr) throw delErr
      if (exams.length) {
        const rows = exams.map((e) => ({ ...e, sale_id: saleId }))
        const { error: insErr } = await supabase.from('order_examinations').insert(rows)
        if (insErr) throw insErr
      }
    },
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
 * Mirrors repo.get_customer_past_examinations(): two-step query (sales, then
 * exams by sale_id), newest first, capped at 10.
 */
export function usePastExaminations(customerId: string | null) {
  return useQuery({
    queryKey: ['past_examinations', customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<PastExam[]> => {
      const { data: sales, error: sErr } = await supabase
        .from('sales')
        .select('id, order_date, invoice_no, doctor_name')
        .eq('customer_id', customerId as string)
        .order('order_date', { ascending: false })
        .limit(20)
        .returns<Pick<Sale, 'id' | 'order_date' | 'invoice_no' | 'doctor_name'>[]>()
      if (sErr) throw sErr
      if (!sales?.length) return []

      const saleMap = new Map(sales.map((s) => [s.id, s]))
      const { data: exams, error: eErr } = await supabase
        .from('order_examinations')
        .select('*')
        .in(
          'sale_id',
          sales.map((s) => s.id),
        )
        .returns<OrderExamination[]>()
      if (eErr) throw eErr

      return (exams ?? [])
        .map((e): PastExam => ({ ...e, sale: saleMap.get(e.sale_id) ?? {} }))
        .sort((a, b) =>
          String(b.sale.order_date ?? '').localeCompare(String(a.sale.order_date ?? '')),
        )
        .slice(0, 10)
    },
  })
}
