import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type {
  OrderExaminationInsert,
  Sale,
  SaleItemInsert,
} from '../lib/database.types'

const KEY = ['sales'] as const

/** True when an RPC call failed because the function isn't installed yet
 *  (PostgREST returns PGRST202 / "not found in schema cache"). Lets checkout
 *  fall back to client-side inserts until 002_create_sale_rpc.sql is run. */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  if (error.code === 'PGRST202') return true
  const msg = error.message ?? ''
  return /create_sale_order/.test(msg) && /(does not exist|not found|schema cache)/i.test(msg)
}

/** All sales with their line items. Mirrors repo.get_sales(). */
export function useSales() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Sale[]> => {
      const { data, error } = await supabase
        .from('sales')
        .select('*, sale_items(*)')
        .order('order_date', { ascending: false })
        .returns<Sale[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

/** All of one customer's orders, with line items AND examinations embedded.
 *  Powers the customer detail page (orders + prescription history). */
export function useCustomerOrders(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-orders', customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<Sale[]> => {
      const { data, error } = await supabase
        .from('sales')
        .select('*, sale_items(*), order_examinations(*)')
        .eq('customer_id', customerId as string)
        .order('order_date', { ascending: false })
        .returns<Sale[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

/** Next zero-padded invoice number. Mirrors repo.get_next_invoice_no(). */
export async function getNextInvoiceNo(): Promise<string> {
  const { data } = await supabase
    .from('sales')
    .select('invoice_no')
    .order('invoice_no', { ascending: false })
    .limit(1)
    .returns<{ invoice_no: string }[]>()
  const last = data?.[0]?.invoice_no
  const n = last ? Number.parseInt(last, 10) : NaN
  if (!Number.isNaN(n)) return String(n + 1).padStart(6, '0')

  const { count } = await supabase
    .from('sales')
    .select('id', { count: 'exact', head: true })
  return String((count ?? 0) + 1).padStart(6, '0')
}

export type CartLine = {
  product_id: string
  qty: number
  unit_price: number
  total_price: number
  name: string
}

export type CreateSaleInput = {
  customerId: string | null
  userId?: string | null
  items: CartLine[]
  examinations?: Omit<OrderExaminationInsert, 'sale_id'>[]
  totals: {
    total_amount: number
    discount: number
    net_amount: number
    amount_paid: number
  }
  doctorName?: string
  paymentMethod?: string
  // If provided (assigned earlier in the wizard), reuse it instead of generating.
  invoiceNo?: string
}

/**
 * Create a complete sale: header + line items + stock movements + examinations.
 * Mirrors repo.create_sale_order() / add_sale().
 *
 * NOTE: this runs as several sequential inserts and is therefore NOT atomic —
 * the same as the current Python implementation. Before go-live the whole
 * operation should move into a Postgres function (RPC) so a mid-way failure
 * can't leave a half-written order. Tracked for Phase 4/7 hardening.
 */
export function useCreateSale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateSaleInput): Promise<Sale> => {
      const invoiceNo = input.invoiceNo ?? (await getNextInvoiceNo())
      const salePayload = {
        invoice_no: invoiceNo,
        customer_id: input.customerId,
        user_id: input.userId ?? null,
        total_amount: input.totals.total_amount,
        discount: input.totals.discount,
        net_amount: input.totals.net_amount,
        amount_paid: input.totals.amount_paid,
        payment_method: input.paymentMethod ?? 'Cash',
        order_date: new Date().toISOString(),
        doctor_name: input.doctorName ?? '',
        lab_status: input.examinations?.length ? 'Not Started' : null,
      }
      const items = input.items.map((i) => ({
        product_id: i.product_id,
        qty: i.qty,
        unit_price: i.unit_price,
        total_price: i.total_price,
        name: i.name,
      }))
      const exams = input.examinations ?? []

      // Preferred path: atomic Postgres function (web/supabase/002_create_sale_rpc.sql).
      const rpc = await supabase.rpc('create_sale_order', {
        p_sale: salePayload,
        p_items: items,
        p_exams: exams,
      })
      if (!rpc.error) return rpc.data as Sale
      if (!isMissingFunction(rpc.error)) throw rpc.error

      // Fallback (RPC not installed yet): non-atomic client-side inserts.
      const { data: sale, error: saleErr } = await supabase
        .from('sales')
        .insert(salePayload)
        .select()
        .single<Sale>()
      if (saleErr) throw saleErr

      if (items.length) {
        const rows: SaleItemInsert[] = items.map((i) => ({ ...i, sale_id: sale.id }))
        const { error: itemsErr } = await supabase.from('sale_items').insert(rows)
        if (itemsErr) throw itemsErr

        const movements = items.map((i) => ({
          product_id: i.product_id,
          qty: -i.qty,
          type: 'sale',
          ref_no: invoiceNo,
          note: `POS Sale: ${invoiceNo}`,
          created_at: new Date().toISOString(),
        }))
        const { error: movErr } = await supabase.from('stock_movements').insert(movements)
        if (movErr) throw movErr
      }

      if (exams.length) {
        const exRows: OrderExaminationInsert[] = exams.map((e) => ({
          ...e,
          sale_id: sale.id,
        }))
        const { error: exErr } = await supabase.from('order_examinations').insert(exRows)
        if (exErr) throw exErr
      }

      return sale
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['inventory'] })
    },
  })
}

export function useUpdateLabStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase
        .from('sales')
        .update({ lab_status: status })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
