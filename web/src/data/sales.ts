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
        .select('*, sale_items(*), users(full_name, username)')
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
  // Expected delivery date shown on receipts/lab copy (YYYY-MM-DD).
  deliveryDate?: string
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
        delivery_date: input.deliveryDate ?? null,
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

export type UpdateSaleFullInput = CreateSaleInput & {
  saleId: string
  invoiceNo: string
  /** Whether the sale had examinations BEFORE this re-checkout. */
  previousHadExams: boolean
}

/**
 * Replace an existing sale's contents after an in-place re-checkout: updates
 * the header, then swaps out sale_items / order_examinations and the sale's
 * stock movements (delete + reinsert). Like the create fallback this is NOT
 * atomic — a mid-way failure could leave partial rows; acceptable parity with
 * the legacy Flet flow until everything moves into a Postgres RPC.
 */
export function useUpdateSaleFull() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      saleId,
      invoiceNo,
      previousHadExams,
      items,
      examinations,
      totals,
      doctorName,
      deliveryDate,
      paymentMethod,
    }: UpdateSaleFullInput): Promise<Sale> => {
      // 1) Header. lab_status only changes when the exam set appears/vanishes;
      //    an in-progress lab status must never be reset by a re-checkout.
      const headerPatch: Partial<Sale> = {
        total_amount: totals.total_amount,
        discount: totals.discount,
        net_amount: totals.net_amount,
        amount_paid: totals.amount_paid,
        payment_method: paymentMethod ?? 'Cash',
        delivery_date: deliveryDate ?? null,
        doctor_name: doctorName ?? '',
      }
      const exams = examinations ?? []
      if (exams.length) headerPatch.lab_status = 'Not Started'
      else if (previousHadExams) headerPatch.lab_status = null

      const { data: sale, error: hdrErr } = await supabase
        .from('sales')
        .update(headerPatch)
        .eq('id', saleId)
        .select()
        .single<Sale>()
      if (hdrErr) throw hdrErr

      // 2) Line items: replace.
      const { error: delItemsErr } = await supabase
        .from('sale_items')
        .delete()
        .eq('sale_id', saleId)
      if (delItemsErr) throw delItemsErr
      if (items.length) {
        const rows: SaleItemInsert[] = items.map((i) => ({ ...i, sale_id: saleId }))
        const { error: itemsErr } = await supabase.from('sale_items').insert(rows)
        if (itemsErr) throw itemsErr
      }

      // 3) Examinations: replace.
      const { error: delExErr } = await supabase
        .from('order_examinations')
        .delete()
        .eq('sale_id', saleId)
      if (delExErr) throw delExErr
      if (exams.length) {
        const exRows: OrderExaminationInsert[] = exams.map((e) => ({
          ...e,
          sale_id: saleId,
        }))
        const { error: exErr } = await supabase.from('order_examinations').insert(exRows)
        if (exErr) throw exErr
      }

      // 4) Stock movements: replace THIS sale's movements. They carry no
      //    sale_id column — ref_no holds the invoice number and type='sale'.
      const { error: delMovErr } = await supabase
        .from('stock_movements')
        .delete()
        .eq('type', 'sale')
        .eq('ref_no', invoiceNo)
      if (delMovErr) throw delMovErr
      if (items.length) {
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

      return sale
    },
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

// ---- lab workflow vocabulary (single source of truth) ----

/** The ONLY lab statuses the Lab tab understands. Every editor/badge/filter
 *  must use these so colors and filters stay aligned across screens. */
export const LAB_STATUSES = ['Not Started', 'In Lab', 'Ready', 'Received'] as const

/** Badge classes per status — kept next to the vocabulary so they can't drift. */
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
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string
      patch: Partial<Sale>
    }): Promise<void> => {
      // Strip embedded relations so PostgREST doesn't try to write them.
      const {
        sale_items: _si,
        order_examinations: _oe,
        users: _u,
        id: _id,
        ...clean
      } = patch as Partial<Sale> & {
        sale_items?: unknown
        order_examinations?: unknown
        users?: unknown
      }
      void _si
      void _oe
      void _u
      void _id
      const { error } = await supabase.from('sales').update(clean).eq('id', id)
      if (error) throw error
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
      void vars
    },
  })
}

/** Insert a standalone prescription for a customer with no cart items.
 *  Creates a zero-total sale (invoice `PRESC-<epoch>`) and attaches the exam. */
export function useAddStandalonePrescription() {
  const qc = useQueryClient()
  const create = useCreateSale()
  return useMutation({
    mutationFn: async ({
      customerId,
      exam,
      doctorName,
    }: {
      customerId: string
      exam: Omit<OrderExaminationInsert, 'sale_id'>
      doctorName?: string
    }): Promise<Sale> => {
      const invoiceNo = 'PRESC-' + Date.now().toString(36).toUpperCase()
      return create.mutateAsync({
        customerId,
        userId: null,
        invoiceNo,
        items: [],
        examinations: [exam],
        totals: { total_amount: 0, discount: 0, net_amount: 0, amount_paid: 0 },
        doctorName: doctorName ?? '',
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
      qc.invalidateQueries({ queryKey: ['past_examinations'] })
    },
  })
}
