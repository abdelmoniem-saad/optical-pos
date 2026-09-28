import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import {
  clampPaymentLines,
  legacyMethodKey,
  methodSummary,
  type PaymentLine,
} from '../lib/payments'
import { isMissingPaymentLedger, replaceSalePayments } from './salesPayments'
import { isMissingRpc, type RpcErrorLike } from './rpc'
import { removeOrderImage } from '../lib/storage'
import type {
  OrderExaminationInsert,
  Sale,
  SaleItemInsert,
} from '../lib/database.types'

const KEY = ['sales'] as const

/** Today's invoices (id + invoice_no), oldest first - powers the POS day
 *  navigation (first / previous / next / last customer of the day).
 *  Shares the ['sales'] prefix, so every checkout invalidation refetches it. */
export function useTodaySales() {
  return useQuery({
    queryKey: [...KEY, 'today-nav'],
    queryFn: async (): Promise<Pick<Sale, 'id' | 'invoice_no'>[]> => {
      const { data, error } = await supabase
        .from('sales')
        .select('id, invoice_no')
        .gte('order_date', localDate())
        .order('order_date', { ascending: true })
        .order('invoice_no', { ascending: true })
        .returns<Pick<Sale, 'id' | 'invoice_no'>[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

/** True when an RPC call failed because the function isn't installed yet
 *  (PostgREST returns PGRST202 / 42883 / "not found in schema cache"). Lets checkout
 *  fall back to client-side inserts until 002_create_sale_rpc.sql is run. */
function isMissingFunction(error: RpcErrorLike): boolean {
  return isMissingRpc('create_sale_order', error)
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
 *
 * `voided_at` is fetched AND filtered in the database. It has to be: a voided
 * sale keeps its money columns (so the audit trail reads true), so a report
 * that sums `net_amount` without this filter counts a void as REVENUE - the
 * shop looks richer by exactly the amount it gave back. The partial index
 * `sales_live_idx ... where voided_at is null` makes the filter free.
 *
 * The count of voided rows is returned alongside, so the screen can say
 * "3 invoices voided" instead of quietly dropping them.
 */
/**
 * Reporting, Phase 4.
 *
 * Before 016 these totals were computed in the browser from a download of every
 * sale header in the store. Two problems: the payload grew without bound, and
 * the arithmetic could forget a rule - which it did, when voiding started
 * working in Phase 2 and `voided_at` was never filtered, so every void made the
 * shop look richer.
 *
 * The database now does the arithmetic (migration 016), which makes the void
 * exclusion something the schema enforces rather than something a view has to
 * remember. These hooks call the RPCs and fall back to the client path when the
 * migration is not applied yet, so a store can be behind without breaking.
 */
export interface ReportTotals {
  revenue: number
  paid: number
  balanceDue: number
  orderCount: number
  pendingLab: number
  readyLab: number
}

export interface TopCustomer {
  name: string
  total: number
}

export interface VoidSummary {
  voidedCount: number
  voidedNet: number
}

const n = (v: unknown): number => Number(v ?? 0) || 0

/**
 * supabase.rpc() returns a thenable builder, not a Promise, so the callback is
 * typed as "awaitable" rather than as a Promise - the builder is missing
 * catch/finally and is not assignable to one. The awaited shape is then stated
 * explicitly.
 */
async function callReport<T>(
  fn: () => PromiseLike<{ data: T | null; error: unknown }>,
): Promise<T | null> {
  const res = (await fn()) as { data: T | null; error: unknown }
  if (res.error) {
    if (isMissingRpc('report_', res.error as RpcErrorLike)) return null
    throw res.error
  }
  return res.data ?? null
}

/** True when 016 is installed. Set once per session by the first call. */
let reportingInDatabase = true
export function isReportingInDatabase(): boolean {
  return reportingInDatabase
}

export async function fetchReportTotals(
  from: string | null,
  to: string | null,
): Promise<ReportTotals | null> {
  const row = await callReport<Record<string, unknown>>(() =>
    supabase.rpc('report_sales_window', { p_from: from, p_to: to }),
  )
  if (!row) {
    reportingInDatabase = false
    return null
  }
  return {
    revenue: n(row.revenue),
    paid: n(row.paid),
    balanceDue: n(row.balance_due),
    orderCount: n(row.order_count),
    pendingLab: n(row.pending_lab),
    readyLab: n(row.ready_lab),
  }
}

export async function fetchTopCustomers(
  from: string | null,
  to: string | null,
  limit = 5,
): Promise<TopCustomer[] | null> {
  const rows = await callReport<Record<string, unknown>[]>(() =>
    supabase.rpc('report_top_customers', { p_from: from, p_to: to, p_limit: limit }),
  )
  if (!rows) {
    reportingInDatabase = false
    return null
  }
  return rows.map((r) => ({ name: String(r.full_name ?? '-'), total: n(r.revenue) }))
}

export async function fetchVoidSummary(from: string | null, to: string | null): Promise<VoidSummary | null> {
  const row = await callReport<Record<string, unknown>>(() =>
    supabase.rpc('report_voided_count', { p_from: from, p_to: to }),
  )
  if (!row) {
    reportingInDatabase = false
    return null
  }
  return { voidedCount: n(row.voided_count), voidedNet: n(row.voided_net) }
}


export interface SalesSummary {
  sales: Sale[]
  voided: Sale[]
}

export function useSalesSummary() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<SalesSummary> => {
      const columns =
        'id, invoice_no, customer_id, total_amount, discount, net_amount, amount_paid, order_date, delivery_date, lab_status, voided_at, void_reason'
      const { data, error } = await supabase
        .from('sales')
        .select(columns)
        .order('order_date', { ascending: false })
        .returns<Sale[]>()
      if (error) throw error
      const rows = data ?? []
      return { sales: rows.filter((s) => !s.voided_at), voided: rows.filter((s) => !!s.voided_at) }
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
          'id, invoice_no, customer_id, user_id, total_amount, discount, net_amount, amount_paid, payment_method, order_date, delivery_date, doctor_name, lab_status, rx_image_path, frame_image_path, users(full_name, username), customers(name)',
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

/** Next zero-padded invoice number by scanning the table client-side.
 *  @deprecated legacy fallback ONLY - used while migration 012 is unapplied.
 *  Prefer nextInvoiceNo() below: this scan invents a timestamp number on
 *  error instead of failing, which is exactly the defect 012 removes. */
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

/**
 * Next invoice number from the atomic DB counter (migration 012). This is the
 * numbering path the app uses: the row-locked counter can never hand two
 * registers the same number and never invents a meaningless one. Falls back to
 * the legacy JS scan only while 012 is unapplied (same contract as checkout's
 * isMissingFunction); any other failure SURFACES instead of inventing a number.
 */
export async function nextInvoiceNo(): Promise<string> {
  const { data, error } = await supabase.rpc('next_invoice_no')
  if (error) {
    if (isMissingRpc('next_invoice_no', error)) {
      console.warn('next_invoice_no() missing (run 012_integrity.sql) - falling back to legacy JS numbering')
      return getNextInvoiceNo()
    }
    throw error
  }
  if (typeof data === 'string' && data) return data
  throw new Error('next_invoice_no() returned no number')
}

export type CartLine = {
  product_id: string
  qty: number
  unit_price: number
  total_price: number
  name: string
  /** Line-level discount (migration 013), with the reason it was given. The
   *  database refuses a discount larger than the line, and recomputes the
   *  header from it, so this is a request rather than a stored truth. */
  discount?: number
  discount_reason?: string | null
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
  /** Split tenders for this checkout (migration 011):
   *  [{method:'cash', amount:600}, {method:'instapay', amount:400}].
   *  Omitted = legacy single-method flow (one line synthesized from amount_paid). */
  payments?: PaymentLine[]
  // Expected delivery date shown on receipts/lab copy (YYYY-MM-DD).
  deliveryDate?: string
  // Order photo slots (migration 007): prescriptions paper / frame picture.
  rxImagePath?: string | null
  frameImagePath?: string | null
  // If provided (assigned earlier in the wizard), reuse it instead of generating.
  invoiceNo?: string
  // One key per checkout attempt (migration 012): replaying the same key
  // (double-tap, retry after a lost response) returns the SAME sale instead
  // of creating a second one. Minted by the POS wizard and kept with the draft.
  idempotencyKey?: string | null
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
            invoiceNo = await nextInvoiceNo()
          } else if (!invoiceNo.startsWith('PRESC-')) {
            const { data: existing } = await supabase
              .from('sales')
              .select('id')
              .eq('invoice_no', invoiceNo)
              .limit(1)
            if (existing && existing.length > 0) {
              invoiceNo = await nextInvoiceNo()
            }
          }

          // Payment lines (migration 011): use what the POS sent; callers that
          // don't know about splits get ONE synthesized line from amount_paid,
          // so the ledger always agrees with the header (the DB trigger
          // recomputes sales.amount_paid from the rows we're about to write).
          const fallbackLines: PaymentLine[] =
            input.payments ??
            (input.totals.amount_paid > 0
              ? [
                  {
                    method: legacyMethodKey(input.paymentMethod ?? 'cash'),
                    amount: input.totals.amount_paid,
                  },
                ]
              : [])
          const pay = clampPaymentLines(fallbackLines, input.totals.amount_paid)
          const paymentMethod = input.paymentMethod ?? methodSummary(pay)

          const salePayload = {
            invoice_no: invoiceNo,
            customer_id: input.customerId,
            user_id: input.userId ?? null,
            total_amount: input.totals.total_amount,
            discount: input.totals.discount,
            net_amount: input.totals.net_amount,
            amount_paid: input.totals.amount_paid,
            payment_method: paymentMethod,
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
          // p_payments only rides along when there ARE lines: an 002-only database
          // (011 not run yet) keeps its atomic 3-arg path, while a missing 4-arg
          // match surfaces through isMissingFunction and falls back below.
          const rpcArgs: Record<string, unknown> = {
            p_sale: salePayload,
            p_items: items,
            p_exams: exams,
          }
          if (pay.length) rpcArgs.p_payments = pay
          // Idempotency (migration 012): the same key means "this checkout
          // already happened" - the RPC returns the existing sale instead of
          // writing a second one. Omitted on pre-012 databases (4-arg call).
          if (input.idempotencyKey) rpcArgs.p_idempotency_key = input.idempotencyKey
          try {
            const rpc = await supabase.rpc('create_sale_order', rpcArgs)
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

          // Payment lines (migration 011). Legacy databases without the ledger
          // keep the header amount_paid only; running 011 later backfills rows.
          if (pay.length) {
            const payRows = pay.map((p) => ({
              sale_id: sale.id,
              amount: p.amount,
              method: p.method,
            }))
            const { error: payErr } = await supabase.from('sale_payments').insert(payRows)
            if (payErr && !isMissingPaymentLedger(payErr)) throw payErr
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
 * Replace an existing sale's contents after an in-place re-checkout.
 *
 * Migration 013 moved this into `update_sale_order()`: ONE transaction that
 * re-prices the lines against the catalog, refuses a stale cart, swaps the
 * items / exams / stock movements / payment ledger, and recomputes the header.
 * It used to be five separate client round-trips, so a failure in the middle
 * left a half-written order (threat T6). The client-side path is kept only for
 * databases that have not run 013 yet - and on those it is already the old,
 * non-atomic behaviour, so nothing regresses.
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
      payments,
      rxImagePath,
      frameImagePath,
    }: UpdateSaleFullInput): Promise<Sale> => {
      // Payment lines (migration 011): explicit split from the POS, or one
      // synthesized line so a caller that doesn't know about the ledger still
      // ends up with header == SUM(ledger) after the replace below.
      const fallbackLines: PaymentLine[] =
        payments ??
        (totals.amount_paid > 0
          ? [
              {
                method: legacyMethodKey(paymentMethod ?? 'cash'),
                amount: totals.amount_paid,
              },
            ]
          : [])
      const pay = clampPaymentLines(fallbackLines, totals.amount_paid)
      const exams = examinations ?? []

      // net_amount is the ONE money input the server keeps - it recomputes
      // total/discount from the catalog. amount_paid is derived from `pay`.
      const salePayload = {
        customer_id: null,
        doctor_name: doctorName ?? '',
        delivery_date: deliveryDate ? deliveryDate : null,
        payment_method: paymentMethod ?? methodSummary(pay),
        net_amount: totals.net_amount,
        amount_paid: totals.amount_paid,
        lab_status: exams.length ? 'Not Started' : null,
        rx_image_path: rxImagePath ?? null,
        frame_image_path: frameImagePath ?? null,
      }
      const linePayload = items.map((i) => ({
        product_id: i.product_id,
        qty: i.qty,
        unit_price: i.unit_price,
        total_price: i.total_price,
        name: i.name,
        discount: i.discount ?? 0,
        discount_reason: i.discount_reason ?? null,
      }))

      const rpc = await supabase.rpc('update_sale_order', {
        p_sale_id: saleId,
        p_sale: salePayload,
        p_items: linePayload,
        p_exams: exams,
        p_payments: pay,
      })
      if (!rpc.error && rpc.data) return rpc.data as Sale
      if (rpc.error && !isMissingRpc('update_sale_order', rpc.error)) throw rpc.error

      // ---- pre-013 fallback: the old, non-atomic client-side replace ----
      // lab_status only changes when the exam set appears/vanishes; an
      // in-progress lab status must never be reset by a re-checkout.
      const headerPatch: Partial<Sale> = {
        total_amount: totals.total_amount,
        discount: totals.discount,
        net_amount: totals.net_amount,
        amount_paid: totals.amount_paid,
        payment_method: paymentMethod ?? methodSummary(pay),
        delivery_date: deliveryDate ? deliveryDate : null,
        doctor_name: doctorName ?? '',
        rx_image_path: rxImagePath ?? null,
        frame_image_path: frameImagePath ?? null,
      }
      if (exams.length) headerPatch.lab_status = 'Not Started'
      else if (previousHadExams) headerPatch.lab_status = null

      const { data: sale, error: hdrErr } = await supabase
        .from('sales')
        .update(headerPatch)
        .eq('id', saleId)
        .select()
        .single<Sale>()
      if (hdrErr) throw hdrErr

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

      // Stock movements carry no sale_id column - ref_no holds the invoice
      // number and type='sale'.
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

      // The sale_payments_sync trigger recomputes amount_paid from the rows.
      await replaceSalePayments(
        saleId,
        pay.map((p) => ({ sale_id: saleId, amount: p.amount, method: p.method })),
      )

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

/** Columns on `sales` that migration 013 made LEDGER-OWNED: a direct UPDATE
 *  is refused by a trigger, because these four are recomputed from
 *  `sale_payments` / the catalog by the checkout RPCs. Stripped from every
 *  generic header patch so an ordinary edit never trips the guard. */
export const MONEY_COLUMNS = [
  'total_amount',
  'discount',
  'net_amount',
  'amount_paid',
] as const satisfies readonly (keyof Sale)[]

/** Patch header fields of an existing sale (doctor, dates, photos, lab status…).
 *  Money columns are deliberately dropped: they belong to the ledger. Change
 *  what was paid through the Add-payment flow, not from here. */
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
      // Strip embedded relations so PostgREST doesn't try to write them, and
      // strip the ledger-owned money columns.
      const {
        sale_items: _si,
        order_examinations: _oe,
        users: _u,
        customers: _c,
        id: _id,
        total_amount: _t,
        discount: _d,
        net_amount: _n,
        amount_paid: _a,
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
      void _t
      void _d
      void _n
      void _a
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

/**
 * Void a sale (migration 013). This is an EVENT, not a delete: the header,
 * the lines, the exams and the original payment rows all stay, and the sale
 * gains voided_at / voided_by / void_reason. The database puts the stock back
 * (when `restock`), mirrors every tender as a negative `kind = 'refund'` row so
 * the per-method cash-up stays truthful, and recomputes amount_paid.
 *
 * Until 013 is applied the function is missing and the mutation fails loudly
 * rather than silently doing nothing - a void that appears to work but erases
 * nothing would be worse than an error.
 */
export function useVoidSale() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      reason,
      restock,
    }: {
      id: string
      reason: string
      restock: boolean
    }): Promise<Sale> => {
      const { data, error } = await supabase.rpc('void_sale', {
        p_sale_id: id,
        p_reason: reason,
        p_restock: restock,
      })
      if (error) throw error
      return data as Sale
    },
    onSuccess: (voided) => {
      qc.invalidateQueries({ queryKey: KEY })
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['customer-orders'] })
      qc.invalidateQueries({ queryKey: ['sale-payments'] })
      // A voided invoice's photos are dead weight in the bucket. The DB cannot
      // reach the storage API, so this is the client's job - and it is best
      // effort: a failed delete must never turn a successful void into an error.
      for (const path of [voided?.rx_image_path, voided?.frame_image_path]) {
        if (path) void removeOrderImage(path).catch(() => {})
      }
    },
  })
}

/** Insert a standalone prescription for a customer with no cart items.
 *  Creates a zero-total sale and attaches the exam. Since migration 012 the
 *  invoice number comes from the DB counter like every other sale - the old
 *  `PRESC-<epoch>` namespace (which polluted Reports and broke the numeric
 *  invoice scan) is gone for new rows. */
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
      return create.mutateAsync({
        customerId,
        userId: null,
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
