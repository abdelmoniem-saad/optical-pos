import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { isMissingRpc, type RpcErrorLike } from './rpc'

/** Customer balances and the debtor list (migration 018).
 *
 *  `sale_payments` has been the authoritative record of money since 011, and
 *  nothing aggregated it: the README claimed customers had balances and there
 *  was no way to ask. These read the aggregate from Postgres for the same
 *  reason 016 moved reporting there — the answer is scoped, fixed-size and
 *  cannot be computed differently by two screens. */

/** What one customer owes. `balance_due` is the debt; `lifetime` is everything
 *  ever sold to them. They are not interchangeable, so both are returned. */
export type CustomerBalance = {
  customer_id: string
  balance_due: number
  lifetime: number
  invoice_count: number
  last_activity: string | null
}

export type Debtor = {
  customer_id: string
  name: string
  phone: string
  balance_due: number
  last_activity: string | null
}

/** PostgREST wraps a `returns table` function in an array even when it returns
 *  one row, so the field must be read off `[0]`. 016 shipped this bug and it
 *  rendered a confident row of zeros, because `Number(undefined ?? 0)` is 0 and
 *  nothing throws — `oneRow` makes that shape explicit. Exported for the test,
 *  which pins the unwrap in both directions. */
export function oneRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null
  return (data as T) ?? null
}

function n(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** PostgREST returns `numeric` as a JSON number or string depending on the
 *  column, so both are coerced here rather than trusted to one shape. Exported
 *  for the test: this coercion is the exact thing that produced Phase 4's
 *  silent zeros, so it is worth pinning directly. */
export function toBalance(row: Record<string, unknown> | null): CustomerBalance | null {
  if (!row) return null
  return {
    customer_id: String(row.customer_id ?? ''),
    balance_due: n(row.balance_due),
    lifetime: n(row.lifetime),
    invoice_count: n(row.invoice_count),
    last_activity: (row.last_activity as string | null) ?? null,
  }
}

/** True when the balance functions are not installed yet (018 unapplied). */
function isMissingLedger(error: RpcErrorLike): boolean {
  return isMissingRpc('customer_balance', error)
}

/** What ONE customer owes. `null` rather than zeros when unknown, because a
 *  stale id must be visibly absent instead of looking like a settled account. */
export function useCustomerBalance(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-balance', customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<CustomerBalance | null> => {
      const { data, error } = await supabase.rpc('customer_balance', {
        p_customer: customerId,
      })
      // A database without 018 has no function. That is a schema state, not a
      // customer with no debt, so it surfaces as an error and the screen shows
      // "not available" rather than a confident zero.
      if (isMissingLedger(error)) throw new Error('Balances need migration 018_purchase_stock.sql.')
      if (error) throw error
      return toBalance(oneRow<Record<string, unknown>>(data))
    },
  })
}

/** Customers who owe money, largest first.
 *
 *  `to` is an EXCLUSIVE bound, the same convention `usePaymentsRange` and the
 *  016 report functions use. Passing a bare date here means "up to midnight at
 *  the START of that day" against a timestamptz, which silently drops the rest
 *  of the day — the exact mistake Phase 4 had to undo in Reports. */
export function useCustomerDebtors(to: string | null) {
  return useQuery({
    queryKey: ['customer-debtors', to],
    queryFn: async (): Promise<Debtor[]> => {
      const { data, error } = await supabase.rpc('customer_debtors', {
        p_from: null,
        p_to: to,
        p_limit: 50,
      })
      if (isMissingLedger(error)) throw new Error('Balances need migration 018_purchase_stock.sql.')
      if (error) throw error
      const rows = (data as Record<string, unknown>[] | null) ?? []
      return rows.map((r) => ({
        customer_id: String(r.customer_id ?? ''),
        name: String(r.name ?? ''),
        phone: String(r.phone ?? ''),
        balance_due: n(r.balance_due),
        last_activity: (r.last_activity as string | null) ?? null,
      }))
    },
  })
}
