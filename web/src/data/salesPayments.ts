import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { SalePayment, SalePaymentInsert } from '../lib/database.types'

// ---- payment ledger (migration 011) ----
// One row per money received against an invoice: split tenders at checkout
// AND payments collected later for the remaining balance. The DB trigger
// (sale_payments_sync) keeps sales.amount_paid == SUM(its rows), so this
// ledger is the single source of truth.

const KEY = ['sale_payments'] as const

/** True when the ledger table isn't created yet (011_sale_payments.sql not run). */
export function isMissingPaymentLedger(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return (
    /sale_payments/.test(error.message ?? '') &&
    /(does not exist|schema cache|not found)/i.test(error.message ?? '')
  )
}

/** The message doubles as an i18n key - see translations.ts. */
export function paymentLedgerMissingError(): Error {
  return new Error(
    'Payment ledger missing - run web/supabase/011_sale_payments.sql in the Supabase SQL editor.',
  )
}

/** Payments of ONE invoice, oldest first (reads like a running ledger). */
export function useSalePayments(saleId: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, saleId ?? 'none'],
    enabled: !!saleId,
    queryFn: async (): Promise<SalePayment[]> => {
      const { data, error } = await supabase
        .from('sale_payments')
        .select('*')
        .eq('sale_id', saleId as string)
        .order('paid_at', { ascending: true })
        .order('created_at', { ascending: true })
        .returns<SalePayment[]>()
      if (isMissingPaymentLedger(error)) throw paymentLedgerMissingError()
      if (error) throw error
      return data ?? []
    },
  })
}

/** Append payment line(s) - "Record payment" on an existing invoice. */
export function useAddSalePayments() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (rows: SalePaymentInsert[]): Promise<SalePayment[]> => {
      if (!rows.length) return []
      const { data, error } = await supabase
        .from('sale_payments')
        .insert(rows)
        .select()
        .returns<SalePayment[]>()
      if (isMissingPaymentLedger(error)) throw paymentLedgerMissingError()
      if (error) throw error
      return data ?? []
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      // History badges (paid / due) read sales.amount_paid, which the DB
      // trigger just recomputed behind our back.
      qc.invalidateQueries({ queryKey: ['sales'] })
    },
  })
}

/**
 * Ledger rows within [from, to] (YYYY-MM-DD, inclusive) for Reports.
 * from/to = null → unbounded on that side. Powers the per-method
 * cash-up view (money actually RECEIVED, by paid_at).
 */
export function usePaymentsRange(from: string | null, to: string | null) {
  return useQuery({
    queryKey: [...KEY, 'range', from ?? '', to ?? ''],
    queryFn: async (): Promise<SalePayment[]> => {
      let q = supabase
        .from('sale_payments')
        .select('id, method, amount, paid_at')
        .order('paid_at', { ascending: true })
      if (from) q = q.gte('paid_at', from)
      if (to) q = q.lte('paid_at', to)
      const { data, error } = await q.returns<SalePayment[]>()
      if (isMissingPaymentLedger(error)) throw paymentLedgerMissingError()
      if (error) throw error
      return data ?? []
    },
  })
}

/**
 * Replace an invoice's whole ledger (re-checkout rewrites the tenders).
 * Legacy databases without the ledger table silently no-op - the header's
 * amount_paid (patched separately) keeps behaving exactly as before, and
 * running 011 later backfills the rows.
 */
export async function replaceSalePayments(
  saleId: string,
  rows: SalePaymentInsert[],
): Promise<void> {
  const { error: delErr } = await supabase.from('sale_payments').delete().eq('sale_id', saleId)
  if (delErr) {
    if (isMissingPaymentLedger(delErr)) return
    throw delErr
  }
  if (!rows.length) return
  const { error: insErr } = await supabase.from('sale_payments').insert(rows)
  if (insErr) {
    if (isMissingPaymentLedger(insErr)) return
    throw insErr
  }
}
