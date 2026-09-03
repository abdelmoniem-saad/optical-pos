import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type {
  OrderExaminationInsert,
  Sale,
  SaleItemInsert,
} from '../lib/database.types'

const KEY = ['sales'] as const

/** True when an RPC call failed because the function isn't installed yet
 *  (PostgREST returns PGRST202 / 42883 / "not found in schema cache"). Lets checkout
 *  fall back to client-side inserts until 002_create_sale_rpc.sql is run. */
function isMissingFunction(error: { code?: string; message?: string; details?: string; hint?: string } | null | undefined): boolean {
  if (!error) return false
  if (error.code === 'PGRST202' || error.code === '42883' || error.code === 'PGRST200' || error.code === '404') return true
  const combined = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`
  return /create_sale_order/i.test(combined) && /(does not exist|not found|schema cache|could not find)/i.test(combined)
}

/** True when a sale insert or RPC fails due to unique constraint collision on invoice_no. */
function isInvoiceNoConflict(
  error: { code?: string; message?: string; details?: string; hint?: string } | null | undefined,
): boolean {
  if (!error) return false
  const code = error.code ?? ''
  const msg = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`
  return (
    code === '23505' ||
    /sales_invoice_no_key/i.test(msg) ||
    (/duplicate key/i.test(msg) && /invoice_no/i.test(msg))
  )
}

/**
 * Lean sales feed for aggregate screens (Reports): header columns ONLY -
 * deliberately WITHOUT sale_items, which dominate the payload as data grows.
 * Years of orders stay a few hundred KB this way.
 */
export function useSalesSummary() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Sale[]> => {
      const { data, error } = await supabase
        .from('sales')
        .select(
          'id, invoice_no, customer_id, total_amount, discount, net_amount, amount_paid, order_date, delivery_date, lab_status',
        )
        .order('order_date', { ascending: false })
        .returns<Sale[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Search terms must not inject PostgREST or-syntax. */
function sanitizeTerm(t: string): string {
  return t.replace(/[,()]/g, ' ').trim()
}

const SALES_PAGE = 50
export type SalesRange = 'all' | 'today' | 'month'

/**
 * Paged, server-filtered sales feed for History. Loads SALES_PAGE orders at a
 * time (newest first) and grows gracefully: filters run in Postgres (date
 * range, invoice-number match, or customer-name match resolved to ids), so
 * the browser never downloads the whole table.
 */
export function useInfiniteSales(range: SalesRange, term: string) {
  const t = sanitizeTerm(term)
  return useInfiniteQuery({
    queryKey: [...KEY, 'paged', range, t],
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<{ rows: Sale[]; count: number }> => {
      const offset = (pageParam as number) * SALES_PAGE
      let q = supabase
        .from('sales')
        .select(
          'id, invoice_no, customer_id, user_id, total_amount, discount, net_amount, amount_paid, payment_method, order_date, delivery_date, doctor_name, lab_status, users(full_name, username), customers(name)',
          { count: 'exact' },
        )
        .order('order_date', { ascending: false })
        .range(offset, offset + SALES_PAGE - 1)
      if (range === 'today') q = q.gte('order_date', `${localDate()}T00:00:00`)
      else if (range === 'month') q = q.gte('order_date', `${localDate().slice(0, 8)}01T00:00:00`)
      if (t) {
        const { data: custs } = await supabase
          .from('customers')
          .select('id')
          .ilike('name', `%${t}%`)
          .limit(50)
        const ids = (custs ?? []).map((c) => c.id)
        const parts = [`invoice_no.ilike.%${t}%`]
        if (ids.length) parts.push(`customer_id.in.(${ids.join(',')})`)
        q = q.or(parts.join(','))
      }
      const { data, error, count } = await q.returns<Sale[]>()
      if (error) throw error
      return { rows: data ?? [], count: count ?? 0 }
    },
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
    queryFn: async ({ pageParam }): Promise<{ rows: Sale[]; count: number }> => {
      const offset = (pageParam as number) * SALES_PAGE
      let q = supabase
        .from('sales')
        .select(
          'id, invoice_no, customer_id, total_amount, net_amount, amount_paid, order_date, delivery_date, lab_status, customers(name)',
          { count: 'exact' },
        )
        .not('lab_status', 'is', null)
        .order('order_date', { ascending: false })
        .range(offset, offset + SALES_PAGE - 1)
      if (status !== 'All') q = q.eq('lab_status', status)
      const { data, error, count } = await q.returns<Sale[]>()
      if (error) throw error
      return { rows: data ?? [], count: count ?? 0 }
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((sum, p) => sum + p.rows.length, 0)
      return loaded < last.count ? all.length : undefined
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
  try {
    const [{ data: byInv }, { data: byDate }] = await Promise.all([
      supabase
        .from('sales')
        .select('invoice_no')
        .order('invoice_no', { ascending: false })
        .limit(100)
        .returns<{ invoice_no: string }[]>(),
      supabase
        .from('sales')
        .select('invoice_no')
        .order('order_date', { ascending: false })
        .limit(100)
        .returns<{ invoice_no: string }[]>(),
    ])

    let maxNum = 0
    const seen = new Set<string>()
    for (const row of [...(byInv ?? []), ...(byDate ?? [])]) {
      if (row?.invoice_no) {
        const str = String(row.invoice_no).trim()
        seen.add(str)
        if (/^\d+$/.test(str)) {
          const val = Number.parseInt(str, 10)
          if (!Number.isNaN(val) && val > maxNum) {
            maxNum = val
          }
        }
      }
    }

    if (maxNum === 0) {
      const { count } = await supabase
        .from('sales')
        .select('id', { count: 'exact', head: true })
      maxNum = count ?? 0
    }

    let candidate = maxNum + 1
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidateStr = String(candidate).padStart(6, '0')
      if (!seen.has(candidateStr)) {
        const { data: exists } = await supabase
          .from('sales')
          .select('id')
          .eq('invoice_no', candidateStr)
          .limit(1)
        if (!exists || exists.length === 0) {
          return candidateStr
        }
        seen.add(candidateStr)
      }
      candidate++
    }
    return String(candidate).padStart(6, '0')
  } catch (err) {
    console.warn('getNextInvoiceNo failed, falling back to timestamp-based sequence:', err)
    return String(Date.now() % 1000000).padStart(6, '0')
  }
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
  // Order photo slots (migration 007): prescriptions paper / frame picture.
  rxImagePath?: string | null
  frameImagePath?: string | null
  // If provided (assigned earlier in the wizard), reuse it instead of generating.
  invoiceNo?: string
}

/**
 * Create a complete sale: header + line items + stock movements + examinations.
 * Mirrors repo.create_sale_order() / add_sale().
 *
 * NOTE: this runs as several sequential inserts and is therefore NOT atomic -
 * the same as the current Python implementation. Before go-live the whole
 * operation should move into a Postgres function (RPC) so a mid-way failure
 * can't leave a half-written order. Tracked for Phase 4/7 hardening.
 */
export function useCreateSale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateSaleInput): Promise<Sale> => {
      let lastError: any = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let invoiceNo = input.invoiceNo
          if (!invoiceNo || attempt > 0) {
            invoiceNo = await getNextInvoiceNo()
          } else if (!invoiceNo.startsWith('PRESC-')) {
            const { data: existing } = await supabase
              .from('sales')
              .select('id')
              .eq('invoice_no', invoiceNo)
              .limit(1)
            if (existing && existing.length > 0) {
              invoiceNo = await getNextInvoiceNo()
            }
          }

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
            delivery_date: input.deliveryDate ? input.deliveryDate : null,
            doctor_name: input.doctorName ?? '',
            lab_status: input.examinations?.length ? 'Not Started' : null,
            rx_image_path: input.rxImagePath ?? null,
            frame_image_path: input.frameImagePath ?? null,
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
          try {
            const rpc = await supabase.rpc('create_sale_order', {
              p_sale: salePayload,
              p_items: items,
              p_exams: exams,
            })
            if (!rpc.error && rpc.data) return rpc.data as Sale
            if (rpc.error) {
              if (isInvoiceNoConflict(rpc.error)) {
                lastError = rpc.error
                continue
              }
              if (!isMissingFunction(rpc.error)) throw rpc.error
            }
          } catch (err: any) {
            if (isInvoiceNoConflict(err)) {
              lastError = err
              continue
            }
            if (!isMissingFunction(err)) throw err
          }

          // Fallback (RPC not installed yet): non-atomic client-side inserts.
          const { data: sale, error: saleErr } = await supabase
            .from('sales')
            .insert(salePayload)
            .select()
            .single<Sale>()
          if (saleErr) {
            if (isInvoiceNoConflict(saleErr)) {
              lastError = saleErr
              continue
            }
            throw saleErr
          }

          if (items.length) {
            const rows: SaleItemInsert[] = items.map((i) => ({ ...i, sale_id: sale.id }))
            const { error: itemsErr } = await supabase.from('sale_items').insert(rows)
            if (itemsErr) throw itemsErr

            const movements = items.map((i) => ({
              product_id: i.product_id,
              qty: -i.qty,
              type: 'sale',
              ref_no: sale.invoice_no,
              note: `POS Sale: ${sale.invoice_no}`,
              created_at: new Date().toISOString(),
            }))
            const { error: movErr } = await supabase.from('stock_movements').insert(movements)
            if (movErr) throw movErr
          }

          if (exams.length) {
            const exRows: OrderExaminationInsert[] = exams.map((e) => ({
              ...e,
              doctor_name: (e as any).doctor_name || input.doctorName || null,
              sale_id: sale.id,
            }))
            let { error: exErr } = await supabase.from('order_examinations').insert(exRows)
            // If image_path column does not exist in user's schema (42703 / undefined column), retry without image_path
            if (exErr && (exErr.code === '42703' || /image_path/i.test(exErr.message ?? ''))) {
              const stripped = exRows.map(({ image_path: _unused, ...rest }: any) => rest)
              const retry = await supabase.from('order_examinations').insert(stripped)
              exErr = retry.error
            }
            if (exErr) throw exErr
          }

          return sale
        } catch (err: any) {
          if (isInvoiceNoConflict(err) && attempt < 2) {
            lastError = err
            continue
          }
          throw err
        }
      }
      throw lastError
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
 * atomic - a mid-way failure could leave partial rows; acceptable parity with
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
      rxImagePath,
      frameImagePath,
    }: UpdateSaleFullInput): Promise<Sale> => {
      // 1) Header. lab_status only changes when the exam set appears/vanishes;
      //    an in-progress lab status must never be reset by a re-checkout.
      const headerPatch: Partial<Sale> = {
        total_amount: totals.total_amount,
        discount: totals.discount,
        net_amount: totals.net_amount,
        amount_paid: totals.amount_paid,
        payment_method: paymentMethod ?? 'Cash',
        delivery_date: deliveryDate ? deliveryDate : null,
        doctor_name: doctorName ?? '',
        rx_image_path: rxImagePath ?? null,
        frame_image_path: frameImagePath ?? null,
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
          doctor_name: (e as any).doctor_name || doctorName || null,
          sale_id: saleId,
        }))
        let { error: exErr } = await supabase.from('order_examinations').insert(exRows)
        if (exErr && (exErr.code === '42703' || /image_path/i.test(exErr.message ?? ''))) {
          const stripped = exRows.map(({ image_path: _unused, ...rest }: any) => rest)
          const retry = await supabase.from('order_examinations').insert(stripped)
          exErr = retry.error
        }
        if (exErr) throw exErr
      }

      // 4) Stock movements: replace THIS sale's movements. They carry no
      //    sale_id column - ref_no holds the invoice number and type='sale'.
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

/**
 * Attach/replace one of an order's two photo slots (prescriptions paper or
 * frame picture). `path === null` clears the slot.
 */
export function useSetOrderImage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      saleId,
      slot,
      path,
    }: {
      saleId: string
      slot: 'rx' | 'frame'
      path: string | null
    }): Promise<void> => {
      const patch =
        slot === 'rx' ? { rx_image_path: path } : { frame_image_path: path }
      const { error } = await supabase.from('sales').update(patch).eq('id', saleId)
      if (error) throw error
    },
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
        customers: _c,
        id: _id,
        ...clean
      } = patch as Partial<Sale> & {
        sale_items?: unknown
        order_examinations?: unknown
        users?: unknown
        customers?: unknown
      }
      void _si
      void _oe
      void _u
      void _c
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
