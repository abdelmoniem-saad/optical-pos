// Supabase implementation of the repository seam.
//
// This is where the app's online data access lives today. It is a straight
// move of the logic that used to sit in web/src/data/*.ts — no behavior change.
// Phase 1 adds a LocalRepository with the same interface for offline mode.
import { supabase } from './supabase'
import type { PosRepository } from './repository'
import type {
  CreateSaleInput,
  CustomerSearchHit,
  ExamRefRow,
  NamedRow,
  PastExam,
  Purchase,
  PurchaseInsert,
  PurchasePayment,
  PurchasePaymentInsert,
  SalesRange,
  SearchResults,
  Supplier,
  SupplierInsert,
  UpdateSaleFullInput,
} from './repositoryTypes'
import { CustomerHasRelatedRecordsError } from './repositoryTypes'
import type {
  Customer,
  CustomerInsert,
  Note,
  OrderExamination,
  OrderExaminationInsert,
  Product,
  ProductInsert,
  Sale,
  SaleItemInsert,
  User,
} from './database.types'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True when an RPC call failed because the function isn't installed yet
 *  (PostgREST returns PGRST202 / 42883 / "not found in schema cache"). Lets
 *  checkout fall back to client-side inserts until 002_create_sale_rpc.sql is
 *  run. */
function isMissingFunction(
  error: { code?: string; message?: string; details?: string; hint?: string } | null | undefined,
): boolean {
  if (!error) return false
  if (error.code === 'PGRST202' || error.code === '42883' || error.code === 'PGRST200' || error.code === '404')
    return true
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

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Search terms must not inject PostgREST or-syntax. */
function sanitizeTerm(t: string): string {
  return t.replace(/[,()]/g, ' ').trim()
}

const distinctNonEmpty = (values: (string | null | undefined)[]): string[] => {
  const out: string[] = []
  for (const v of values) {
    const s = (v ?? '').trim()
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out
}

/** True when the payments ledger table isn't created yet (migration 003 not run). */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /purchase_payments/.test(error.message ?? '') && /(does not exist|schema cache|not found)/i.test(error.message ?? '')
}

function missingTableError(): Error {
  // The message doubles as an i18n key - see translations.ts.
  return new Error(
    'Payments ledger missing - run web/supabase/003_purchase_payments.sql in the Supabase SQL editor.',
  )
}

export class SupabaseRepository implements PosRepository {
  // =========================================================================
  // customers
  // =========================================================================

  async getCustomers(): Promise<Customer[]> {
    const { data, error } = await supabase.from('customers').select('*').order('name').returns<Customer[]>()
    if (error) throw error
    return data ?? []
  }

  async getCustomer(id: string): Promise<Customer | null> {
    const { data, error } = await supabase.from('customers').select('*').eq('id', id).maybeSingle<Customer>()
    if (error) throw error
    return data
  }

  async searchCustomers(term: string): Promise<Customer[]> {
    const trimmed = term.trim()
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .ilike('name', `%${trimmed}%`)
      .limit(10)
      .returns<Customer[]>()
    if (error) throw error
    return data ?? []
  }

  async searchCustomersExtended(term: string): Promise<CustomerSearchHit[]> {
    const q = term.replace(/[,()]/g, ' ').trim()
    const like = `%${q}%`
    const [custRes, docRes] = await Promise.all([
      supabase
        .from('customers')
        .select('*')
        .or(`name.ilike.${like},city.ilike.${like},phone.ilike.${like}`)
        .order('name')
        .limit(50)
        .returns<Customer[]>(),
      supabase
        .from('sales')
        .select('customer_id, doctor_name')
        .ilike('doctor_name', like)
        .limit(50)
        .returns<{ customer_id: string | null; doctor_name: string | null }[]>(),
    ])
    if (custRes.error) throw custRes.error
    if (docRes.error) throw docRes.error

    const byId = new Map<string, Customer>()
    for (const c of custRes.data ?? []) byId.set(c.id, c)

    const doctorsByCustomer = new Map<string, string[]>()
    const missing: string[] = []
    for (const s of docRes.data ?? []) {
      if (!s.customer_id || !s.doctor_name) continue
      const list = doctorsByCustomer.get(s.customer_id) ?? []
      if (!list.includes(s.doctor_name)) list.push(s.doctor_name)
      doctorsByCustomer.set(s.customer_id, list)
      if (!byId.has(s.customer_id)) missing.push(s.customer_id)
    }

    if (missing.length) {
      const { data: extra, error } = await supabase
        .from('customers')
        .select('*')
        .in('id', missing)
        .returns<Customer[]>()
      if (error) throw error
      for (const c of extra ?? []) byId.set(c.id, c)
    }

    const hits: CustomerSearchHit[] = [...byId.values()].map((c) => ({
      ...c,
      matchedDoctors: doctorsByCustomer.get(c.id) ?? [],
    }))
    hits.sort((a, b) => a.name.localeCompare(b.name))
    return hits
  }

  async getCustomersPage(offset: number, limit: number): Promise<{ rows: Customer[]; count: number }> {
    const { data, error, count } = await supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .order('name')
      .range(offset, offset + limit - 1)
      .returns<Customer[]>()
    if (error) throw error
    return { rows: data ?? [], count: count ?? 0 }
  }

  async addCustomer(input: CustomerInsert): Promise<Customer> {
    const { data, error } = await supabase.from('customers').insert(input).select().single<Customer>()
    if (error) throw error
    return data
  }

  async updateCustomer(id: string, patch: Partial<CustomerInsert>): Promise<void> {
    const { error } = await supabase.from('customers').update(patch).eq('id', id)
    if (error) throw error
  }

  async deleteCustomer(id: string, cascade?: boolean): Promise<void> {
    // When cascading, remove the child rows that don't cascade automatically
    // from `customers` (sales are ON DELETE NO ACTION in the schema, while
    // prescriptions and sale_items/order_examinations do cascade). Deleting
    // the sales rows first triggers ON DELETE CASCADE for sale_items and
    // order_examinations, then deleting the customer cascades prescriptions.
    if (cascade) {
      const { error: salesErr } = await supabase.from('sales').delete().eq('customer_id', id)
      if (salesErr) throw salesErr
    }

    const { error } = await supabase.from('customers').delete().eq('id', id)
    if (error) {
      const code = (error as { code?: string }).code
      const msg = error.message?.toLowerCase() ?? ''
      const isFk = code === '23503' || msg.includes('foreign key') || msg.includes('violates')
      if (isFk && !cascade) {
        const { orderCount, prescriptionCount } = await this.countRelatedCustomers(id)
        throw new CustomerHasRelatedRecordsError(orderCount, prescriptionCount)
      }
      throw error
    }
  }

  private async countRelatedCustomers(customerId: string): Promise<{ orderCount: number; prescriptionCount: number }> {
    const [salesRes, presRes] = await Promise.all([
      supabase.from('sales').select('id', { count: 'exact', head: true }).eq('customer_id', customerId),
      supabase.from('prescriptions').select('id', { count: 'exact', head: true }).eq('customer_id', customerId),
    ])
    return { orderCount: salesRes.count ?? 0, prescriptionCount: presRes.count ?? 0 }
  }

  // =========================================================================
  // sales
  // =========================================================================

  async getSalesSummary(): Promise<Sale[]> {
    const { data, error } = await supabase
      .from('sales')
      .select(
        'id, invoice_no, customer_id, total_amount, discount, net_amount, amount_paid, order_date, delivery_date, lab_status',
      )
      .order('order_date', { ascending: false })
      .returns<Sale[]>()
    if (error) throw error
    return data ?? []
  }

  async getSalesPage(
    range: SalesRange,
    term: string,
    offset: number,
    limit: number,
  ): Promise<{ rows: Sale[]; count: number }> {
    const t = sanitizeTerm(term)
    let q = supabase
      .from('sales')
      .select(
        'id, invoice_no, customer_id, user_id, total_amount, discount, net_amount, amount_paid, payment_method, order_date, delivery_date, doctor_name, lab_status, rx_image_path, frame_image_path, users(full_name, username), customers(name)',
        { count: 'exact' },
      )
      .order('order_date', { ascending: false })
      .range(offset, offset + limit - 1)
    if (range === 'today') q = q.gte('order_date', `${localDate()}T00:00:00`)
    else if (range === 'month') q = q.gte('order_date', `${localDate().slice(0, 8)}01T00:00:00`)
    if (t) {
      const { data: custs } = await supabase.from('customers').select('id').ilike('name', `%${t}%`).limit(50)
      const ids = (custs ?? []).map((c) => c.id)
      const parts = [`invoice_no.ilike.%${t}%`]
      if (ids.length) parts.push(`customer_id.in.(${ids.join(',')})`)
      q = q.or(parts.join(','))
    }
    const { data, error, count } = await q.returns<Sale[]>()
    if (error) throw error
    return { rows: data ?? [], count: count ?? 0 }
  }

  async getLabSalesPage(status: string, offset: number, limit: number): Promise<{ rows: Sale[]; count: number }> {
    let q = supabase
      .from('sales')
      .select(
        'id, invoice_no, customer_id, total_amount, net_amount, amount_paid, order_date, delivery_date, lab_status, customers(name)',
        { count: 'exact' },
      )
      .not('lab_status', 'is', null)
      .order('order_date', { ascending: false })
      .range(offset, offset + limit - 1)
    if (status !== 'All') q = q.eq('lab_status', status)
    const { data, error, count } = await q.returns<Sale[]>()
    if (error) throw error
    return { rows: data ?? [], count: count ?? 0 }
  }

  async getCustomerOrders(customerId: string): Promise<Sale[]> {
    const { data, error } = await supabase
      .from('sales')
      .select('*, sale_items(*), order_examinations(*)')
      .eq('customer_id', customerId)
      .order('order_date', { ascending: false })
      .returns<Sale[]>()
    if (error) throw error
    return data ?? []
  }

  async getSaleByInvoiceNo(invoiceNo: string): Promise<Sale | null> {
    const { data, error } = await supabase
      .from('sales')
      .select('id, invoice_no, customer_id, rx_image_path, frame_image_path, order_date')
      .eq('invoice_no', invoiceNo)
      .maybeSingle<Sale>()
    if (error) throw error
    return data
  }

  async getNextInvoiceNo(): Promise<string> {
    try {
      const [{ data: byInv }, { data: byDate }] = await Promise.all([
        supabase.from('sales').select('invoice_no').order('invoice_no', { ascending: false }).limit(100).returns<{ invoice_no: string }[]>(),
        supabase.from('sales').select('invoice_no').order('order_date', { ascending: false }).limit(100).returns<{ invoice_no: string }[]>(),
      ])

      let maxNum = 0
      const seen = new Set<string>()
      for (const row of [...(byInv ?? []), ...(byDate ?? [])]) {
        if (row?.invoice_no) {
          const str = String(row.invoice_no).trim()
          seen.add(str)
          if (/^\d+$/.test(str)) {
            const val = Number.parseInt(str, 10)
            if (!Number.isNaN(val) && val > maxNum) maxNum = val
          }
        }
      }

      if (maxNum === 0) {
        const { count } = await supabase.from('sales').select('id', { count: 'exact', head: true })
        maxNum = count ?? 0
      }

      let candidate = maxNum + 1
      for (let attempt = 0; attempt < 50; attempt++) {
        const candidateStr = String(candidate).padStart(6, '0')
        if (!seen.has(candidateStr)) {
          const { data: exists } = await supabase.from('sales').select('id').eq('invoice_no', candidateStr).limit(1)
          if (!exists || exists.length === 0) return candidateStr
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

  async createSale(input: CreateSaleInput): Promise<Sale> {
    let lastError: any = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let invoiceNo = input.invoiceNo
        if (!invoiceNo || attempt > 0) {
          invoiceNo = await this.getNextInvoiceNo()
        } else if (!invoiceNo.startsWith('PRESC-')) {
          const { data: existing } = await supabase.from('sales').select('id').eq('invoice_no', invoiceNo).limit(1)
          if (existing && existing.length > 0) invoiceNo = await this.getNextInvoiceNo()
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
        const { data: sale, error: saleErr } = await supabase.from('sales').insert(salePayload).select().single<Sale>()
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
  }

  async updateSaleFull({
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
    customerId,
  }: UpdateSaleFullInput): Promise<Sale> {
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
    }
    // A photo the wizard doesn't know about (adopted from the phone, or not
    // found because the lookup timed out) is kept, never cleared.
    if (rxImagePath) headerPatch.rx_image_path = rxImagePath
    if (frameImagePath) headerPatch.frame_image_path = frameImagePath
    if (customerId !== undefined) headerPatch.customer_id = customerId
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
    const { error: delItemsErr } = await supabase.from('sale_items').delete().eq('sale_id', saleId)
    if (delItemsErr) throw delItemsErr
    if (items.length) {
      const rows: SaleItemInsert[] = items.map((i) => ({ ...i, sale_id: saleId }))
      const { error: itemsErr } = await supabase.from('sale_items').insert(rows)
      if (itemsErr) throw itemsErr
    }

    // 3) Examinations: replace.
    const { error: delExErr } = await supabase.from('order_examinations').delete().eq('sale_id', saleId)
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
  }

  async updateSale(id: string, patch: Partial<Sale>): Promise<void> {
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
  }

  async updateLabStatus(id: string, status: string): Promise<void> {
    const { error } = await supabase.from('sales').update({ lab_status: status }).eq('id', id)
    if (error) throw error
  }

  async setOrderImage(saleId: string, slot: 'rx' | 'frame', path: string | null): Promise<void> {
    const patch = slot === 'rx' ? { rx_image_path: path } : { frame_image_path: path }
    const { error } = await supabase.from('sales').update(patch).eq('id', saleId)
    if (error) throw error
  }

  async addStandalonePrescription(input: {
    customerId: string
    exam: Omit<OrderExaminationInsert, 'sale_id'>
    doctorName?: string
  }): Promise<Sale> {
    const invoiceNo = 'PRESC-' + Date.now().toString(36).toUpperCase()
    return this.createSale({
      customerId: input.customerId,
      userId: null,
      invoiceNo,
      items: [],
      examinations: [input.exam],
      totals: { total_amount: 0, discount: 0, net_amount: 0, amount_paid: 0 },
      doctorName: input.doctorName ?? '',
    })
  }

  // =========================================================================
  // examinations
  // =========================================================================

  async getOrderExaminations(saleId: string): Promise<OrderExamination[]> {
    const { data, error } = await supabase
      .from('order_examinations')
      .select('*')
      .eq('sale_id', saleId)
      .returns<OrderExamination[]>()
    if (error) throw error
    return data ?? []
  }

  async replaceOrderExaminations(
    saleId: string,
    exams: Omit<OrderExamination, 'id' | 'sale_id'>[],
  ): Promise<void> {
    const { error: delErr } = await supabase.from('order_examinations').delete().eq('sale_id', saleId)
    if (delErr) throw delErr
    if (exams.length) {
      const rows = exams.map((e) => ({ ...e, sale_id: saleId }))
      let { error: insErr } = await supabase.from('order_examinations').insert(rows)
      if (insErr && (insErr.code === '42703' || /image_path/i.test(insErr.message ?? ''))) {
        const stripped = rows.map(({ image_path: _unused, ...rest }: any) => rest)
        const retry = await supabase.from('order_examinations').insert(stripped)
        insErr = retry.error
      }
      if (insErr) throw insErr
    }
  }

  async getPastExaminations(customerId: string): Promise<PastExam[]> {
    const { data: sales, error: sErr } = await supabase
      .from('sales')
      .select('id, order_date, invoice_no, doctor_name')
      .eq('customer_id', customerId)
      .order('order_date', { ascending: false })
      .limit(20)
      .returns<Pick<Sale, 'id' | 'order_date' | 'invoice_no' | 'doctor_name'>[]>()
    if (sErr) throw sErr
    if (!sales?.length) return []

    const saleMap = new Map(sales.map((s) => [s.id, s]))
    const { data: exams, error: eErr } = await supabase
      .from('order_examinations')
      .select('*')
      .in('sale_id', sales.map((s) => s.id))
      .returns<OrderExamination[]>()
    if (eErr) throw eErr

    return (exams ?? [])
      .map((e): PastExam => ({ ...e, sale: saleMap.get(e.sale_id) ?? {} }))
      .sort((a, b) => String(b.sale.order_date ?? '').localeCompare(String(a.sale.order_date ?? '')))
      .slice(0, 10)
  }

  // =========================================================================
  // inventory
  // =========================================================================

  async getInventory(category?: string): Promise<Product[]> {
    let q = supabase.from('inventory').select('*')
    if (category) q = q.eq('category', category)
    const { data: items, error } = await q.order('name').returns<Product[]>()
    if (error) throw error

    const { data: movements, error: mErr } = await supabase
      .from('stock_movements')
      .select('product_id, qty')
      .returns<{ product_id: string; qty: number }[]>()
    if (mErr) throw mErr

    const stock = new Map<string, number>()
    for (const m of movements ?? []) stock.set(m.product_id, (stock.get(m.product_id) ?? 0) + (m.qty ?? 0))
    return (items ?? []).map((p) => ({ ...p, stock_qty: stock.get(p.id) ?? 0 }))
  }

  async findProductBySkuOrName(term: string): Promise<Product | null> {
    const t = term.trim()
    if (!t) return null
    // Exact SKU first, then name contains. Mirrors find_product_by_name_or_sku.
    let { data } = await supabase.from('inventory').select('*').ilike('sku', t).limit(1).returns<Product[]>()
    if (!data || !data.length) {
      const res = await supabase.from('inventory').select('*').ilike('name', `%${t}%`).limit(1).returns<Product[]>()
      data = res.data ?? []
    }
    return data[0] ?? null
  }

  async getProductStock(productId: string): Promise<number> {
    const { data, error } = await supabase
      .from('stock_movements')
      .select('qty')
      .eq('product_id', productId)
      .returns<{ qty: number }[]>()
    if (error) throw error
    return (data ?? []).reduce((sum, m) => sum + (m.qty ?? 0), 0)
  }

  async addProduct(input: ProductInsert): Promise<Product> {
    const { stock_qty = 0, ...fields } = input
    const { data, error } = await supabase.from('inventory').insert(fields).select().single<Product>()
    if (error) throw error
    if (stock_qty > 0) {
      await supabase.from('stock_movements').insert({
        product_id: data.id,
        qty: stock_qty,
        type: 'initial',
        note: 'Initial stock',
        created_at: new Date().toISOString(),
      })
    }
    return data
  }

  async updateProduct(id: string, patch: Partial<Omit<ProductInsert, 'stock_qty'>>): Promise<void> {
    const { error } = await supabase.from('inventory').update(patch).eq('id', id)
    if (error) throw error
  }

  async adjustStock(input: {
    productId: string
    qtyChange: number
    type?: string
    note?: string
    refNo?: string
  }): Promise<void> {
    const { error } = await supabase.from('stock_movements').insert({
      product_id: input.productId,
      qty: input.qtyChange,
      type: input.type ?? 'adjustment',
      ref_no: input.refNo ?? '',
      note: input.note ?? '',
      created_at: new Date().toISOString(),
    })
    if (error) throw error
  }

  async ensureFrameProduct(name: string): Promise<Product | null> {
    const raw = name.trim()
    if (!raw) return null
    const clean = raw.split(' (')[0].trim() || raw
    try {
      const { data: existing } = await supabase
        .from('inventory')
        .select('*')
        .eq('category', 'Frame')
        .ilike('name', clean)
        .limit(1)
        .returns<Product[]>()
      if (existing && existing.length) return existing[0]

      const { data: anyExisting } = await supabase
        .from('inventory')
        .select('*')
        .ilike('name', clean)
        .limit(1)
        .returns<Product[]>()
      if (anyExisting && anyExisting.length) return anyExisting[0]

      const { data: created, error } = await supabase
        .from('inventory')
        .insert({ name: clean, category: 'Frame', sale_price: 0, cost_price: 0 })
        .select()
        .maybeSingle<Product>()
      if (error) {
        console.warn('Could not auto-create frame product in inventory:', error)
        return null
      }
      return created
    } catch (e) {
      console.warn('ensureFrameProduct failed:', e)
      return null
    }
  }

  // =========================================================================
  // metadata
  // =========================================================================

  private async getNamedTable(table: string, order: 'name' | 'custom' = 'name'): Promise<NamedRow[]> {
    let q = supabase.from(table).select('*')
    q =
      order === 'custom'
        ? q.order('sort_order', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
        : q.order('name')
    const { data, error } = await q.returns<NamedRow[]>()
    if (error) throw error
    return data ?? []
  }

  getLensTypes(): Promise<NamedRow[]> {
    return this.getNamedTable('lens_types', 'custom')
  }

  getFrameColors(): Promise<NamedRow[]> {
    return this.getNamedTable('frame_colors', 'custom')
  }

  getRoles(): Promise<NamedRow[]> {
    return this.getNamedTable('roles')
  }

  async addMetadata(table: string, name: string, sortOrder?: number): Promise<NamedRow> {
    const payload: Record<string, unknown> = { name: name.trim() }
    if (sortOrder !== undefined) payload.sort_order = sortOrder
    const { data, error } = await supabase.from(table).insert(payload).select().single<NamedRow>()
    if (error) throw error
    return data
  }

  async reorderMetadata(table: string, orderedIds: string[]): Promise<void> {
    await Promise.all(orderedIds.map((id, i) => supabase.from(table).update({ sort_order: i + 1 }).eq('id', id)))
  }

  async deleteMetadata(table: string, id: string): Promise<void> {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) throw error
  }

  private async metadataHas(table: string, name: string): Promise<boolean> {
    const { data } = await supabase.from(table).select('id').ilike('name', name).limit(1).returns<{ id: string }[]>()
    return !!data?.length
  }

  async addMissingOrderMetadata(exams: { lens_info?: string | null; frame_color?: string | null }[]): Promise<void> {
    const lens = distinctNonEmpty(exams.map((e) => e.lens_info))
    const colors = distinctNonEmpty(exams.map((e) => e.frame_color))

    for (const [table, values] of [
      ['lens_types', lens],
      ['frame_colors', colors],
    ] as const) {
      const missing: string[] = []
      for (const v of values) {
        if (!(await this.metadataHas(table, v))) missing.push(v)
      }
      if (missing.length) {
        const { error } = await supabase.from(table).insert(missing.map((name) => ({ name })))
        if (error) throw error
      }
    }
  }

  async syncExamReferences(params: { invoiceNo: string; oldRows: ExamRefRow[]; newRows: ExamRefRow[] }): Promise<void> {
    const { oldRows, newRows } = params

    for (const [table, field] of [
      ['lens_types', 'lens_info'],
      ['frame_colors', 'frame_color'],
    ] as const) {
      const oldVals = distinctNonEmpty(oldRows.map((r) => r[field]))
      const newVals = distinctNonEmpty(newRows.map((r) => r[field]))

      for (const v of newVals) {
        if (!(await this.metadataHas(table, v))) {
          const { error } = await supabase.from(table).insert({ name: v })
          if (error) throw error
        }
      }

      for (const v of oldVals) {
        if (newVals.some((x) => x.toLowerCase() === v.toLowerCase())) continue
        // Delete only when NO other order still uses this value.
        const { data: used } = await supabase
          .from('order_examinations')
          .select('id')
          .ilike(field, v)
          .limit(1)
          .returns<{ id: string }[]>()
        if (used?.length) continue
        const { data: row } = await supabase.from(table).select('id').ilike('name', v).limit(1).returns<{ id: string }[]>()
        if (row?.[0]) {
          const { error } = await supabase.from(table).delete().eq('id', row[0].id)
          if (error) throw error
        }
      }
    }

    // ---- frames vs inventory ----
    const oldFrames = distinctNonEmpty(oldRows.map((r) => r.frame_info))
    const newFrames = distinctNonEmpty(newRows.map((r) => r.frame_info))

    for (const v of newFrames) {
      if (!oldFrames.some((x) => x.toLowerCase() === v.toLowerCase())) {
        await this.ensureFrameProduct(v)
      }
    }

    for (const v of oldFrames) {
      if (newFrames.some((x) => x.toLowerCase() === v.toLowerCase())) continue
      // Still referenced by another order? Keep the product.
      const { data: used } = await supabase
        .from('order_examinations')
        .select('id')
        .ilike('frame_info', v)
        .limit(1)
        .returns<{ id: string }[]>()
      if (used?.length) continue

      const { data: prod } = await supabase
        .from('inventory')
        .select('id')
        .eq('category', 'Frame')
        .ilike('name', v)
        .limit(1)
        .returns<{ id: string }[]>()
      const pid = prod?.[0]?.id
      if (!pid) continue

      // Referenced by a sale line item? Keep it (its stock history is real).
      const { data: si } = await supabase.from('sale_items').select('id').eq('product_id', pid).limit(1).returns<{ id: string }[]>()
      if (si?.length) continue

      // Only clean up app-created clutter: product whose net stock is zero or
      // negative (a phantom). Real stock (purchases / initial) is never touched.
      const { data: movs } = await supabase
        .from('stock_movements')
        .select('qty')
        .eq('product_id', pid)
        .returns<{ qty: number | null }[]>()
      const stock = (movs ?? []).reduce((sum, m) => sum + (m.qty ?? 0), 0)
      if (stock > 0) continue

      // Cascades away its phantom movements with it.
      const { error } = await supabase.from('inventory').delete().eq('id', pid)
      if (error) throw error
    }
  }

  // =========================================================================
  // notes
  // =========================================================================

  async getEveryoneNotes(): Promise<Note[]> {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .is('user_id', null)
      .order('created_at', { ascending: false })
      .returns<Note[]>()
    if (error) throw error
    return data ?? []
  }

  async getMyNotes(userId: string): Promise<Note[]> {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .returns<Note[]>()
    if (error) throw error
    return data ?? []
  }

  async addNote(input: { body: string; userId: string | null }): Promise<void> {
    // Resolve the STAFF row id (not the raw auth UUID) - accounts linked via
    // their legacy username have no auth-keyed users row, and using the raw
    // auth UUID here would violate the created_by FK and block the note.
    const createdBy = await this.resolveStaffUserId()
    const { error } = await supabase
      .from('notes')
      .insert({ body: input.body.trim(), user_id: input.userId, created_by: createdBy })
    if (error) throw error
  }

  async updateNote(id: string, body: string): Promise<void> {
    const { error } = await supabase
      .from('notes')
      .update({ body: body.trim(), updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  }

  async deleteNote(id: string): Promise<void> {
    const { error } = await supabase.from('notes').delete().eq('id', id)
    if (error) throw error
  }

  async getNoteSeen(ids: string[]): Promise<{ note_id: string; user_id: string }[]> {
    const { data, error } = await supabase
      .from('note_seen')
      .select('note_id, user_id')
      .in('note_id', ids)
      .returns<{ note_id: string; user_id: string }[]>()
    if (error) throw error
    return data ?? []
  }

  async markNoteSeen(noteId: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('note_seen')
      .upsert({ note_id: noteId, user_id: userId }, { onConflict: 'note_id,user_id' })
    if (error) throw error
  }

  // =========================================================================
  // permissions
  // =========================================================================

  async getRoleGrants(roleId: string): Promise<string[]> {
    const { data, error } = await supabase
      .from('role_permissions')
      .select('permissions(code)')
      .eq('role_id', roleId)
      .returns<{ permissions: { code: string } | null }[]>()
    if (error) throw error
    return (data ?? []).map((r) => r.permissions?.code).filter((c): c is string => !!c)
  }

  async getUserOverrides(userId: string): Promise<Record<string, boolean>> {
    const { data, error } = await supabase
      .from('user_permissions')
      .select('allow, permissions(code)')
      .eq('user_id', userId)
      .returns<{ allow: boolean | null; permissions: { code: string } | null }[]>()
    if (error) throw error
    const map: Record<string, boolean> = {}
    for (const r of data ?? []) {
      const c = r.permissions?.code
      if (c) map[c] = r.allow !== false
    }
    return map
  }

  private async permissionIdByCode(codeStr: string): Promise<string> {
    const { data, error } = await supabase.from('permissions').select('id').eq('code', codeStr).maybeSingle<{ id: string }>()
    if (error) throw error
    if (!data) {
      // Unknown code (migration 004 not run / newer app) - create it on the fly.
      const { data: created, error: insErr } = await supabase
        .from('permissions')
        .insert({ code: codeStr })
        .select()
        .single<{ id: string }>()
      if (insErr) throw insErr
      return created.id
    }
    return data.id
  }

  async toggleRoleGrant(roleId: string, permCode: string, granted: boolean): Promise<void> {
    const pid = await this.permissionIdByCode(permCode)
    if (granted) {
      const { error } = await supabase
        .from('role_permissions')
        .upsert({ role_id: roleId, permission_id: pid }, { onConflict: 'role_id,permission_id' })
      if (error) throw error
    } else {
      const { error } = await supabase.from('role_permissions').delete().eq('role_id', roleId).eq('permission_id', pid)
      if (error) throw error
    }
  }

  async setUserOverride(userId: string, permCode: string, allow: boolean | null): Promise<void> {
    const pid = await this.permissionIdByCode(permCode)
    if (allow === null) {
      const { error } = await supabase.from('user_permissions').delete().eq('user_id', userId).eq('permission_id', pid)
      if (error) throw error
      return
    }
    const { error } = await supabase
      .from('user_permissions')
      .upsert({ user_id: userId, permission_id: pid, allow }, { onConflict: 'user_id,permission_id' })
    if (error) throw error
  }

  // =========================================================================
  // settings
  // =========================================================================

  async getSettings(): Promise<Record<string, string>> {
    const { data, error } = await supabase.from('settings').select('*').returns<{ key: string; value: string | null }[]>()
    if (error) throw error
    const map: Record<string, string> = {}
    for (const s of data ?? []) map[s.key] = s.value ?? ''
    return map
  }

  async setSetting(key: string, value: string): Promise<void> {
    // Per-store key after migration 011/012; the old global key before it.
    let { error } = await supabase.from('settings').upsert({ key, value }, { onConflict: 'store_id,key' })
    if (error?.code === '42P10') {
      ;({ error } = await supabase.from('settings').upsert({ key, value }, { onConflict: 'key' }))
    }
    if (error) throw error
  }

  // =========================================================================
  // staff
  // =========================================================================

  async getUsers(): Promise<User[]> {
    const { data, error } = await supabase.from('users').select('*, roles(*)').order('username').returns<User[]>()
    if (error) throw error
    return data ?? []
  }

  private async queryStaffRow(uid: string, username: string): Promise<User | null> {
    const { data: byId } = await supabase.from('users').select('*, roles(*)').eq('id', uid).maybeSingle<User>()
    if (byId) return byId
    if (!username) return null
    const { data: byName } = await supabase.from('users').select('*, roles(*)').eq('username', username).maybeSingle<User>()
    return byName ?? null
  }

  async getCurrentUser(authUserId: string | null, authEmail: string | null): Promise<User | null> {
    if (!authUserId) return null
    const uname = authEmail?.split('@')[0] ?? ''
    return this.queryStaffRow(authUserId, uname)
  }

  async resolveStaffUserId(): Promise<string | null> {
    const { data } = await supabase.auth.getUser()
    const uid = data.user?.id
    if (!uid) return null
    const uname = data.user?.email?.split('@')[0] ?? ''
    const row = await this.queryStaffRow(uid, uname)
    return row?.id ?? null
  }

  async updateUserRole(id: string, roleId: string | null): Promise<void> {
    const { error } = await supabase.from('users').update({ role_id: roleId }).eq('id', id)
    if (error) throw error
  }

  async addRole(name: string): Promise<NamedRow> {
    const { data, error } = await supabase.from('roles').insert({ name }).select().single<NamedRow>()
    if (error) throw error
    return data
  }

  // =========================================================================
  // suppliers / purchasing
  // =========================================================================

  async getSuppliers(): Promise<Supplier[]> {
    const { data, error } = await supabase.from('suppliers').select('*').order('name').returns<Supplier[]>()
    if (error) throw error
    return data ?? []
  }

  async addSupplier(input: SupplierInsert): Promise<Supplier> {
    const { data, error } = await supabase.from('suppliers').insert(input).select().single<Supplier>()
    if (error) throw error
    return data
  }

  async updateSupplier(id: string, patch: Partial<SupplierInsert>): Promise<void> {
    const { error } = await supabase.from('suppliers').update(patch).eq('id', id)
    if (error) throw error
  }

  async deleteSupplier(id: string): Promise<number> {
    const { data: rows, error: fErr } = await supabase
      .from('purchases')
      .select('id')
      .eq('supplier_id', id)
      .returns<{ id: string }[]>()
    if (fErr) throw fErr
    const ids = (rows ?? []).map((r) => r.id)

    if (ids.length) {
      const { error: dErr } = await supabase.from('purchases').delete().in('id', ids)
      if (dErr) throw dErr
    }

    const { error } = await supabase.from('suppliers').delete().eq('id', id)
    if (error) throw error
    return ids.length
  }

  async getPurchases(supplierId?: string): Promise<Purchase[]> {
    let q = supabase.from('purchases').select('*')
    if (supplierId) q = q.eq('supplier_id', supplierId)
    const { data, error } = await q.order('purchase_date', { ascending: false }).returns<Purchase[]>()
    if (error) throw error
    return data ?? []
  }

  async addPurchase(input: PurchaseInsert): Promise<Purchase> {
    const { data, error } = await supabase.from('purchases').insert(input).select().single<Purchase>()
    if (error) throw error
    return data
  }

  async getAllPurchasePayments(): Promise<PurchasePayment[]> {
    const { data, error } = await supabase
      .from('purchase_payments')
      .select('*')
      .order('paid_at', { ascending: false })
      .returns<PurchasePayment[]>()
    if (isMissingTable(error)) throw missingTableError()
    if (error) throw error
    return data ?? []
  }

  async getPurchasePayments(purchaseId: string): Promise<PurchasePayment[]> {
    const { data, error } = await supabase
      .from('purchase_payments')
      .select('*')
      .eq('purchase_id', purchaseId)
      .order('paid_at', { ascending: true })
      .order('created_at', { ascending: true })
      .returns<PurchasePayment[]>()
    if (isMissingTable(error)) throw missingTableError()
    if (error) throw error
    return data ?? []
  }

  async addPurchasePayment(input: PurchasePaymentInsert): Promise<PurchasePayment> {
    const { data, error } = await supabase.from('purchase_payments').insert(input).select().single<PurchasePayment>()
    if (isMissingTable(error)) throw missingTableError()
    if (error) throw error
    return data
  }

  async deletePurchasePayment(id: string): Promise<void> {
    const { error } = await supabase.from('purchase_payments').delete().eq('id', id)
    if (error) throw error
  }

  // =========================================================================
  // search
  // =========================================================================

  async globalSearch(term: string): Promise<SearchResults> {
    const q = term.trim().replace(/[,()]/g, ' ')
    const [c, p, s] = await Promise.all([
      supabase
        .from('customers')
        .select('*')
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(6)
        .returns<Customer[]>(),
      supabase
        .from('inventory')
        .select('*')
        .or(`name.ilike.%${q}%,sku.ilike.%${q}%`)
        .limit(6)
        .returns<Product[]>(),
      supabase
        .from('sales')
        .select('*')
        .ilike('invoice_no', `%${q}%`)
        .limit(6)
        .returns<Sale[]>(),
    ])
    return { customers: c.data ?? [], products: p.data ?? [], sales: s.data ?? [] }
  }
}
