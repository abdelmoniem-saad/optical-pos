// Offline implementation of the repository seam (VITE_DATA_MODE=local).
//
// The shop PC's IndexedDB mirror is the system of record. Every method keeps
// the SAME observable behaviour as SupabaseRepository (filters, sort orders,
// limits, cascade rules) so no screen can tell the difference. Every write is
// one atomic `commit()` that updates the mirror and appends outbox entries for
// one-way replication to Supabase (see local/sync.ts).
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
  Role,
  Sale,
  SaleItem,
  User,
} from './database.types'
import {
  META,
  commit,
  getAll,
  getByIndex,
  getOne,
  metaGet,
  metaSet,
  onCommit,
  withLock,
  type Change,
  type Row,
} from './local/db'
import { tableDef } from './local/schema'
import { uuid } from './local/uuid'
import { effectiveLicenseState, localMeta } from './local/state'
import { currentWindowSession, getLocalSession } from './local/localAuth'

/** Invoice numbers are handed out under a lock shared by every window. */
const INVOICE_LOCK = 'lensypos-invoice'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const lc = (v: unknown) => String(v ?? '').toLowerCase()
const contains = (hay: unknown, needle: string) => lc(hay).includes(needle.toLowerCase())
const ieq = (a: unknown, b: unknown) => lc(a) === lc(b)
const nowIso = () => new Date().toISOString()

/** Ascending text sort, NULLs last (Postgres `order by x`). */
function asc<T>(get: (r: T) => unknown) {
  return (a: T, b: T) => {
    const x = get(a)
    const y = get(b)
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return String(x).localeCompare(String(y))
  }
}

/** Descending sort for ISO date strings (no locale rules), NULLs last. */
function descDate<T>(get: (r: T) => unknown) {
  return (a: T, b: T) => {
    const x = get(a)
    const y = get(b)
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return String(x) < String(y) ? 1 : String(x) > String(y) ? -1 : 0
  }
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

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

const pad6 = (n: number) => String(n).padStart(6, '0')

/** An examination as a fresh row of `saleId` (identity columns re-assigned). */
function examRow(e: Record<string, unknown>, saleId: string): Row {
  const { id: _i, sale_id: _s, store_id: _st, created_at: _c, ...rest } = e
  void _i
  void _s
  void _st
  void _c
  return { ...rest, sale_id: saleId }
}

const up = (table: string, ...rows: Row[]): Change => ({ table, op: 'upsert', rows })
const del = (table: string, rows: Row[]): Change => ({ table, op: 'delete', rows })

/** Rows created in one go keep their order: created_at = base + index (ms). */
const orderedAt = (base: number, i: number) => new Date(base + i).toISOString()

/** Line items / examinations in the order they were entered. */
function byCreated<T>(a: T, b: T): number {
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  return (
    String(x.created_at ?? '').localeCompare(String(y.created_at ?? '')) || String(x.id).localeCompare(String(y.id))
  )
}

/** Same rule (and the same wording) as the cloud's UNIQUE constraints. */
function duplicate(what: string): Error {
  return new Error(`duplicate key value violates unique constraint - ${what}`)
}

/** An empty SKU is "no SKU" (two products without one must not collide). */
function cleanSku<T extends { sku?: string | null }>(p: T): T {
  if (p.sku === undefined) return p
  const sku = (p.sku ?? '').trim()
  return { ...p, sku: sku || null }
}

// Stock is derived from the append-only movements ledger. Summing the whole
// ledger on every inventory read is wasteful, so keep the totals in memory and
// drop them whenever a commit touches stock_movements.
let stockCache: Map<string, number> | null = null
onCommit((tables) => {
  if (tables.has('stock_movements')) stockCache = null
})

async function stockMap(): Promise<Map<string, number>> {
  if (stockCache) return stockCache
  const movs = await getAll<{ product_id: string; qty: number | null }>('stock_movements')
  const m = new Map<string, number>()
  for (const r of movs) m.set(r.product_id, (m.get(r.product_id) ?? 0) + (r.qty ?? 0))
  stockCache = m
  return m
}

// ---------------------------------------------------------------------------

export class LocalRepository implements PosRepository {
  // ---- local plumbing --------------------------------------------------------

  /** Mirror the cloud's RLS: only an ACTIVE license may write. */
  private assertWritable(): void {
    const state = effectiveLicenseState(localMeta().license)
    if (state && state !== 'active') {
      throw new Error('License expired - data is read-only during the grace period. Renew to continue working.')
    }
  }

  /** Fill client-generated id, store_id and created_at for a brand-new row. */
  private stamp(table: string, row: Row): Row {
    const def = tableDef(table)
    const out: Row = { ...row }
    if (def.key.length === 1 && def.key[0] === 'id' && !out.id) out.id = uuid()
    if (def.storeScoped && !out.store_id && localMeta().storeId) out.store_id = localMeta().storeId
    if (def.createdAt && !out.created_at) out.created_at = nowIso()
    return out
  }

  private async write(changes: Change[]): Promise<void> {
    this.assertWritable()
    await commit(changes)
  }

  private async mustGet<T>(table: string, id: string): Promise<T> {
    const row = await getOne<T>(table, id)
    if (!row) throw new Error(`Record not found (${table}).`)
    return row
  }

  // =========================================================================
  // customers
  // =========================================================================

  async getCustomers(): Promise<Customer[]> {
    return (await getAll<Customer>('customers')).sort(asc((c) => c.name))
  }

  async getCustomer(id: string): Promise<Customer | null> {
    return getOne<Customer>('customers', id)
  }

  async searchCustomers(term: string): Promise<Customer[]> {
    const t = term.trim()
    return (await this.getCustomers()).filter((c) => contains(c.name, t)).slice(0, 10)
  }

  async searchCustomersExtended(term: string): Promise<CustomerSearchHit[]> {
    const q = term.replace(/[,()]/g, ' ').trim()
    const all = await this.getCustomers()
    const custs = all.filter((c) => contains(c.name, q) || contains(c.city, q) || contains(c.phone, q)).slice(0, 50)
    const docs = (await getAll<Sale>('sales')).filter((s) => contains(s.doctor_name, q)).slice(0, 50)

    const byId = new Map<string, Customer>()
    for (const c of custs) byId.set(c.id, c)
    const allById = new Map(all.map((c) => [c.id, c]))
    const doctorsByCustomer = new Map<string, string[]>()
    for (const s of docs) {
      if (!s.customer_id || !s.doctor_name) continue
      const list = doctorsByCustomer.get(s.customer_id) ?? []
      if (!list.includes(s.doctor_name)) list.push(s.doctor_name)
      doctorsByCustomer.set(s.customer_id, list)
      const extra = allById.get(s.customer_id)
      if (extra && !byId.has(extra.id)) byId.set(extra.id, extra)
    }
    const hits: CustomerSearchHit[] = [...byId.values()].map((c) => ({
      ...c,
      matchedDoctors: doctorsByCustomer.get(c.id) ?? [],
    }))
    hits.sort((a, b) => a.name.localeCompare(b.name))
    return hits
  }

  async getCustomersPage(offset: number, limit: number): Promise<{ rows: Customer[]; count: number }> {
    const all = await this.getCustomers()
    return { rows: all.slice(offset, offset + limit), count: all.length }
  }

  async addCustomer(input: CustomerInsert): Promise<Customer> {
    const row = this.stamp('customers', { ...input }) as unknown as Customer
    await this.write([up('customers', row as unknown as Row)])
    return row
  }

  async updateCustomer(id: string, patch: Partial<CustomerInsert>): Promise<void> {
    const cur = await this.mustGet<Customer>('customers', id)
    await this.write([up('customers', { ...cur, ...patch, id } as Row)])
  }

  async deleteCustomer(id: string, cascade?: boolean): Promise<void> {
    const sales = await getByIndex<Sale>('sales', 'customer_id', id)
    const presc = await getByIndex<Row>('prescriptions', 'customer_id', id)
    if ((sales.length || presc.length) && !cascade) {
      throw new CustomerHasRelatedRecordsError(sales.length, presc.length)
    }
    const changes: Change[] = []
    // Children explicitly before parents (the cloud cascades too; being
    // explicit keeps the replay valid whatever the FK rules are).
    for (const s of sales) {
      changes.push(del('sale_items', await getByIndex<Row>('sale_items', 'sale_id', s.id)))
      changes.push(del('order_examinations', await getByIndex<Row>('order_examinations', 'sale_id', s.id)))
    }
    changes.push(del('sales', sales as unknown as Row[]))
    changes.push(del('prescriptions', presc))
    changes.push(del('customers', [{ id }]))
    await this.write(changes)
  }

  // =========================================================================
  // sales
  // =========================================================================

  private async salesDesc(): Promise<Sale[]> {
    return (await getAll<Sale>('sales')).sort(descDate((s) => s.order_date))
  }

  async getSalesSummary(): Promise<Sale[]> {
    return this.salesDesc()
  }

  async getSalesPage(
    range: SalesRange,
    term: string,
    offset: number,
    limit: number,
  ): Promise<{ rows: Sale[]; count: number }> {
    const t = sanitizeTerm(term)
    let rows = await this.salesDesc()
    if (range === 'today') {
      const from = `${localDate()}T00:00:00`
      rows = rows.filter((s) => String(s.order_date ?? '') >= from)
    } else if (range === 'month') {
      const from = `${localDate().slice(0, 8)}01T00:00:00`
      rows = rows.filter((s) => String(s.order_date ?? '') >= from)
    }
    const customers = await getAll<Customer>('customers')
    if (t) {
      const ids = new Set(
        customers
          .filter((c) => contains(c.name, t))
          .slice(0, 50)
          .map((c) => c.id),
      )
      rows = rows.filter((s) => contains(s.invoice_no, t) || (s.customer_id != null && ids.has(s.customer_id)))
    }
    const page = rows.slice(offset, offset + limit)
    const users = new Map((await getAll<User>('users')).map((u) => [u.id, u]))
    const custs = new Map(customers.map((c) => [c.id, c]))
    return {
      count: rows.length,
      rows: page.map((s) => {
        const u = s.user_id ? users.get(s.user_id) : undefined
        const c = s.customer_id ? custs.get(s.customer_id) : undefined
        return {
          ...s,
          users: u ? { id: u.id, full_name: u.full_name, username: u.username } : null,
          customers: c ? { name: c.name } : null,
        }
      }),
    }
  }

  async getLabSalesPage(status: string, offset: number, limit: number): Promise<{ rows: Sale[]; count: number }> {
    let rows = (await this.salesDesc()).filter((s) => s.lab_status != null)
    if (status !== 'All') rows = rows.filter((s) => s.lab_status === status)
    const custs = new Map((await getAll<Customer>('customers')).map((c) => [c.id, c]))
    return {
      count: rows.length,
      rows: rows.slice(offset, offset + limit).map((s) => {
        const c = s.customer_id ? custs.get(s.customer_id) : undefined
        return { ...s, customers: c ? { name: c.name } : null }
      }),
    }
  }

  async getCustomerOrders(customerId: string): Promise<Sale[]> {
    const sales = (await getByIndex<Sale>('sales', 'customer_id', customerId)).sort(descDate((s) => s.order_date))
    return Promise.all(
      sales.map(async (s) => ({
        ...s,
        sale_items: (await getByIndex<SaleItem>('sale_items', 'sale_id', s.id)).sort(byCreated),
        order_examinations: (await getByIndex<OrderExamination>('order_examinations', 'sale_id', s.id)).sort(byCreated),
      })),
    )
  }

  async getSaleByInvoiceNo(invoiceNo: string): Promise<Sale | null> {
    const rows = await getByIndex<Sale>('sales', 'invoice_no', invoiceNo)
    return rows[0] ?? null
  }

  /**
   * Next invoice number from the PC's own sequence, RESERVED as it is handed
   * out: the persisted high-water mark moves past it at once, so a number is
   * never given twice - not after an abandoned order (whose photos are stored
   * under that number), not after a deletion, not from two windows at once.
   */
  async getNextInvoiceNo(): Promise<string> {
    return (await withLock(INVOICE_LOCK, () => this.reserveInvoiceNo())) as string
  }

  /** Call only while holding INVOICE_LOCK (locks are not re-entrant). */
  private async reserveInvoiceNo(): Promise<string> {
    const sales = await getAll<Sale>('sales')
    const taken = new Set(sales.map((s) => String(s.invoice_no ?? '').trim()))
    let max = (await metaGet<number>('invoiceHigh')) ?? 0
    for (const s of sales) {
      const str = String(s.invoice_no ?? '').trim()
      if (/^\d+$/.test(str)) max = Math.max(max, Number.parseInt(str, 10))
    }
    if (max === 0) max = sales.length
    let candidate = max + 1
    while (taken.has(pad6(candidate))) candidate++
    await metaSet('invoiceHigh', candidate)
    return pad6(candidate)
  }

  private async invoiceHighChange(invoiceNo: string): Promise<Change[]> {
    if (!/^\d+$/.test(invoiceNo)) return []
    const high = Math.max((await metaGet<number>('invoiceHigh')) ?? 0, Number(invoiceNo))
    return [{ table: META, op: 'upsert', localOnly: true, rows: [{ key: 'invoiceHigh', value: high }] }]
  }

  private saleChildren(
    saleId: string,
    invoiceNo: string,
    input: Pick<CreateSaleInput, 'items' | 'examinations' | 'doctorName'>,
  ): Change[] {
    const base = Date.now()
    const at = new Date(base).toISOString()
    const items = input.items.map((i, n) =>
      this.stamp('sale_items', {
        sale_id: saleId,
        product_id: i.product_id,
        qty: i.qty,
        unit_price: i.unit_price,
        total_price: i.total_price,
        name: i.name,
        created_at: orderedAt(base, n),
      }),
    )
    const movements = input.items.map((i) =>
      this.stamp('stock_movements', {
        product_id: i.product_id,
        qty: -i.qty,
        type: 'sale',
        ref_no: invoiceNo,
        note: `POS Sale: ${invoiceNo}`,
        created_at: at,
      }),
    )
    const exams = (input.examinations ?? []).map((e, n) =>
      this.stamp('order_examinations', {
        ...examRow(e as Record<string, unknown>, saleId),
        doctor_name: (e as Record<string, unknown>).doctor_name || input.doctorName || null,
        created_at: orderedAt(base, n),
      }),
    )
    return [up('sale_items', ...items), up('stock_movements', ...movements), up('order_examinations', ...exams)]
  }

  async createSale(input: CreateSaleInput): Promise<Sale> {
    // Number check + save under one lock: two windows can't take one number.
    return (await withLock(INVOICE_LOCK, () => this.createSaleLocked(input))) as Sale
  }

  private async createSaleLocked(input: CreateSaleInput): Promise<Sale> {
    this.assertWritable()
    let invoiceNo = input.invoiceNo
    if (!invoiceNo) {
      invoiceNo = await this.reserveInvoiceNo()
    } else if (!invoiceNo.startsWith('PRESC-') && (await this.getSaleByInvoiceNo(invoiceNo))) {
      invoiceNo = await this.reserveInvoiceNo()
    }
    const sale = this.stamp('sales', {
      invoice_no: invoiceNo,
      customer_id: input.customerId,
      user_id: input.userId ?? null,
      total_amount: input.totals.total_amount,
      discount: input.totals.discount,
      net_amount: input.totals.net_amount,
      amount_paid: input.totals.amount_paid,
      payment_method: input.paymentMethod ?? 'Cash',
      order_date: nowIso(),
      delivery_date: input.deliveryDate ? input.deliveryDate : null,
      doctor_name: input.doctorName ?? '',
      lab_status: input.examinations?.length ? 'Not Started' : null,
      rx_image_path: input.rxImagePath ?? null,
      frame_image_path: input.frameImagePath ?? null,
    }) as unknown as Sale
    // Header, lines, stock and exams land atomically (unlike the cloud fallback).
    await this.write([
      up('sales', sale as unknown as Row),
      ...this.saleChildren(sale.id, invoiceNo, input),
      ...(await this.invoiceHighChange(invoiceNo)),
    ])
    return sale
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
    const cur = await this.mustGet<Sale>('sales', saleId)
    const exams = examinations ?? []
    const sale: Sale = {
      ...cur,
      total_amount: totals.total_amount,
      discount: totals.discount,
      net_amount: totals.net_amount,
      amount_paid: totals.amount_paid,
      payment_method: paymentMethod ?? 'Cash',
      delivery_date: deliveryDate ? deliveryDate : null,
      doctor_name: doctorName ?? '',
      // A photo the wizard doesn't know about (adopted from the phone, or a
      // cloud lookup that timed out) is kept, never cleared.
      rx_image_path: rxImagePath ?? cur.rx_image_path ?? null,
      frame_image_path: frameImagePath ?? cur.frame_image_path ?? null,
    }
    if (customerId !== undefined) sale.customer_id = customerId
    // lab_status only changes when the exam set appears/vanishes.
    if (exams.length) sale.lab_status = 'Not Started'
    else if (previousHadExams) sale.lab_status = null

    const oldItems = await getByIndex<Row>('sale_items', 'sale_id', saleId)
    const oldExams = await getByIndex<Row>('order_examinations', 'sale_id', saleId)
    const oldMovs = (await getByIndex<Row>('stock_movements', 'ref_no', invoiceNo)).filter((m) => m.type === 'sale')

    await this.write([
      up('sales', sale as unknown as Row),
      del('sale_items', oldItems),
      del('order_examinations', oldExams),
      del('stock_movements', oldMovs),
      ...this.saleChildren(saleId, invoiceNo, { items, examinations: exams, doctorName }),
    ])
    return sale
  }

  async updateSale(id: string, patch: Partial<Sale>): Promise<void> {
    const cur = await this.mustGet<Sale>('sales', id)
    const { id: _id, ...clean } = patch
    void _id
    await this.write([up('sales', { ...cur, ...clean, id } as unknown as Row)])
  }

  async updateLabStatus(id: string, status: string): Promise<void> {
    await this.updateSale(id, { lab_status: status })
  }

  async setOrderImage(saleId: string, slot: 'rx' | 'frame', path: string | null): Promise<void> {
    await this.updateSale(saleId, slot === 'rx' ? { rx_image_path: path } : { frame_image_path: path })
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
    return (await getByIndex<OrderExamination>('order_examinations', 'sale_id', saleId)).sort(byCreated)
  }

  async replaceOrderExaminations(saleId: string, exams: Omit<OrderExamination, 'id' | 'sale_id'>[]): Promise<void> {
    const old = await getByIndex<Row>('order_examinations', 'sale_id', saleId)
    const base = Date.now()
    const rows = exams.map((e, n) =>
      this.stamp('order_examinations', { ...examRow(e as Record<string, unknown>, saleId), created_at: orderedAt(base, n) }),
    )
    await this.write([del('order_examinations', old), up('order_examinations', ...rows)])
  }

  async getPastExaminations(customerId: string): Promise<PastExam[]> {
    const sales = (await getByIndex<Sale>('sales', 'customer_id', customerId))
      .sort(descDate((s) => s.order_date))
      .slice(0, 20)
    if (!sales.length) return []
    const saleMap = new Map(
      sales.map((s) => [
        s.id,
        { id: s.id, order_date: s.order_date, invoice_no: s.invoice_no, doctor_name: s.doctor_name },
      ]),
    )
    const exams: OrderExamination[] = []
    for (const s of sales) exams.push(...(await this.getOrderExaminations(s.id)))
    return exams
      .map((e): PastExam => ({ ...e, sale: saleMap.get(e.sale_id) ?? {} }))
      .sort((a, b) => String(b.sale.order_date ?? '').localeCompare(String(a.sale.order_date ?? '')))
      .slice(0, 10)
  }

  // =========================================================================
  // inventory
  // =========================================================================

  async getInventory(category?: string): Promise<Product[]> {
    let items = await getAll<Product>('inventory')
    if (category) items = items.filter((p) => p.category === category)
    items.sort(asc((p) => p.name))
    const stock = await stockMap()
    return items.map((p) => ({ ...p, stock_qty: stock.get(p.id) ?? 0 }))
  }

  async findProductBySkuOrName(term: string): Promise<Product | null> {
    const t = term.trim()
    if (!t) return null
    const items = (await getAll<Product>('inventory')).sort(asc((p) => p.name))
    return items.find((p) => ieq(p.sku, t)) ?? items.find((p) => contains(p.name, t)) ?? null
  }

  async getProductStock(productId: string): Promise<number> {
    const movs = await getByIndex<{ qty: number | null }>('stock_movements', 'product_id', productId)
    return movs.reduce((sum, m) => sum + (m.qty ?? 0), 0)
  }

  /** inventory.sku is UNIQUE in the cloud: refuse here, as the cloud would. */
  private async assertSkuFree(sku: string | null | undefined, exceptId?: string): Promise<void> {
    if (!sku) return
    const clash = (await getAll<Product>('inventory')).find((p) => p.sku === sku && p.id !== exceptId)
    if (clash) throw duplicate(`another product already uses SKU "${sku}" (${clash.name})`)
  }

  async addProduct(input: ProductInsert): Promise<Product> {
    const { stock_qty = 0, ...rest } = input
    const fields = cleanSku(rest)
    await this.assertSkuFree(fields.sku)
    const product = this.stamp('inventory', { ...fields }) as unknown as Product
    const changes: Change[] = [up('inventory', product as unknown as Row)]
    if (stock_qty > 0) {
      changes.push(
        up(
          'stock_movements',
          this.stamp('stock_movements', {
            product_id: product.id,
            qty: stock_qty,
            type: 'initial',
            note: 'Initial stock',
            created_at: nowIso(),
          }),
        ),
      )
    }
    await this.write(changes)
    return product
  }

  async updateProduct(id: string, patch: Partial<Omit<ProductInsert, 'stock_qty'>>): Promise<void> {
    const cur = await this.mustGet<Product>('inventory', id)
    const clean = cleanSku(patch)
    if (clean.sku !== undefined) await this.assertSkuFree(clean.sku, id)
    await this.write([up('inventory', { ...cur, ...clean, id } as unknown as Row)])
  }

  async adjustStock(input: {
    productId: string
    qtyChange: number
    type?: string
    note?: string
    refNo?: string
  }): Promise<void> {
    await this.write([
      up(
        'stock_movements',
        this.stamp('stock_movements', {
          product_id: input.productId,
          qty: input.qtyChange,
          type: input.type ?? 'adjustment',
          ref_no: input.refNo ?? '',
          note: input.note ?? '',
          created_at: nowIso(),
        }),
      ),
    ])
  }

  async ensureFrameProduct(name: string): Promise<Product | null> {
    const raw = name.trim()
    if (!raw) return null
    const clean = raw.split(' (')[0].trim() || raw
    try {
      const items = (await getAll<Product>('inventory')).sort(asc((p) => p.name))
      const existing = items.find((p) => p.category === 'Frame' && ieq(p.name, clean)) ?? items.find((p) => ieq(p.name, clean))
      if (existing) return existing
      const created = this.stamp('inventory', {
        name: clean,
        category: 'Frame',
        sale_price: 0,
        cost_price: 0,
      }) as unknown as Product
      await this.write([up('inventory', created as unknown as Row)])
      return created
    } catch (e) {
      console.warn('ensureFrameProduct failed:', e)
      return null
    }
  }

  // =========================================================================
  // metadata
  // =========================================================================

  private async namedTable(table: string, order: 'name' | 'custom'): Promise<NamedRow[]> {
    const rows = await getAll<NamedRow & { created_at?: string | null }>(table)
    if (order === 'name') return rows.sort(asc((r) => r.name))
    return rows.sort((a, b) => {
      const x = a.sort_order
      const y = b.sort_order
      if (x != null && y != null && x !== y) return x - y
      if (x == null && y != null) return 1
      if (x != null && y == null) return -1
      return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
    })
  }

  getLensTypes(): Promise<NamedRow[]> {
    return this.namedTable('lens_types', 'custom')
  }

  getFrameColors(): Promise<NamedRow[]> {
    return this.namedTable('frame_colors', 'custom')
  }

  getRoles(): Promise<NamedRow[]> {
    return this.namedTable('roles', 'name')
  }

  async addMetadata(table: string, name: string, sortOrder?: number): Promise<NamedRow> {
    const clean = name.trim()
    if ((await getAll<Row>(table)).some((r) => r.name === clean)) throw duplicate(`"${clean}" already exists`)
    const payload: Row = { name: clean }
    if (sortOrder !== undefined) payload.sort_order = sortOrder
    const row = this.stamp(table, payload) as unknown as NamedRow
    await this.write([up(table, row as unknown as Row)])
    return row
  }

  async reorderMetadata(table: string, orderedIds: string[]): Promise<void> {
    const rows: Row[] = []
    for (const [i, id] of orderedIds.entries()) {
      const cur = await getOne<Row>(table, id)
      if (cur) rows.push({ ...cur, sort_order: i + 1 })
    }
    await this.write([up(table, ...rows)])
  }

  async deleteMetadata(table: string, id: string): Promise<void> {
    await this.write([del(table, [{ id }])])
  }

  private async metadataRow(table: string, name: string): Promise<Row | null> {
    return (await getAll<Row>(table)).find((r) => ieq(r.name, name)) ?? null
  }

  async addMissingOrderMetadata(exams: { lens_info?: string | null; frame_color?: string | null }[]): Promise<void> {
    const lens = distinctNonEmpty(exams.map((e) => e.lens_info))
    const colors = distinctNonEmpty(exams.map((e) => e.frame_color))
    const changes: Change[] = []
    for (const [table, values] of [
      ['lens_types', lens],
      ['frame_colors', colors],
    ] as const) {
      const missing: Row[] = []
      for (const v of values) if (!(await this.metadataRow(table, v))) missing.push(this.stamp(table, { name: v }))
      changes.push(up(table, ...missing))
    }
    await this.write(changes)
  }

  async syncExamReferences(params: { invoiceNo: string; oldRows: ExamRefRow[]; newRows: ExamRefRow[] }): Promise<void> {
    const { oldRows, newRows } = params
    const allExams = await getAll<OrderExamination>('order_examinations')

    for (const [table, field] of [
      ['lens_types', 'lens_info'],
      ['frame_colors', 'frame_color'],
    ] as const) {
      const oldVals = distinctNonEmpty(oldRows.map((r) => r[field]))
      const newVals = distinctNonEmpty(newRows.map((r) => r[field]))
      for (const v of newVals) {
        if (!(await this.metadataRow(table, v))) await this.write([up(table, this.stamp(table, { name: v }))])
      }
      for (const v of oldVals) {
        if (newVals.some((x) => x.toLowerCase() === v.toLowerCase())) continue
        // Delete only when NO other order still uses this value.
        if (allExams.some((e) => ieq(e[field], v))) continue
        const row = await this.metadataRow(table, v)
        if (row) await this.write([del(table, [{ id: row.id }])])
      }
    }

    // ---- frames vs inventory ----
    const oldFrames = distinctNonEmpty(oldRows.map((r) => r.frame_info))
    const newFrames = distinctNonEmpty(newRows.map((r) => r.frame_info))
    for (const v of newFrames) {
      if (!oldFrames.some((x) => x.toLowerCase() === v.toLowerCase())) await this.ensureFrameProduct(v)
    }
    for (const v of oldFrames) {
      if (newFrames.some((x) => x.toLowerCase() === v.toLowerCase())) continue
      if (allExams.some((e) => ieq(e.frame_info, v))) continue
      const prod = (await getAll<Product>('inventory')).find((p) => p.category === 'Frame' && ieq(p.name, v))
      if (!prod) continue
      // Referenced by a sale line item? Keep it (its stock history is real).
      if ((await getByIndex<Row>('sale_items', 'product_id', prod.id)).length) continue
      // Only clean up app-created phantoms (net stock zero or negative).
      const movs = await getByIndex<Row>('stock_movements', 'product_id', prod.id)
      const stock = movs.reduce((sum, m) => sum + Number(m.qty ?? 0), 0)
      if (stock > 0) continue
      await this.write([del('stock_movements', movs), del('inventory', [{ id: prod.id }])])
    }
  }

  // =========================================================================
  // notes
  // =========================================================================

  async getEveryoneNotes(): Promise<Note[]> {
    return (await getAll<Note>('notes')).filter((n) => n.user_id == null).sort(descDate((n) => n.created_at))
  }

  async getMyNotes(userId: string): Promise<Note[]> {
    return (await getAll<Note>('notes')).filter((n) => n.user_id === userId).sort(descDate((n) => n.created_at))
  }

  async addNote(input: { body: string; userId: string | null }): Promise<void> {
    const createdBy = await this.resolveStaffUserId()
    await this.write([
      up('notes', this.stamp('notes', { body: input.body.trim(), user_id: input.userId, created_by: createdBy })),
    ])
  }

  async updateNote(id: string, body: string): Promise<void> {
    const cur = await this.mustGet<Note>('notes', id)
    await this.write([up('notes', { ...cur, body: body.trim(), updated_at: nowIso() } as unknown as Row)])
  }

  async deleteNote(id: string): Promise<void> {
    const seen = await getByIndex<Row>('note_seen', 'note_id', id)
    await this.write([del('note_seen', seen), del('notes', [{ id }])])
  }

  async getNoteSeen(ids: string[]): Promise<{ note_id: string; user_id: string }[]> {
    const out: { note_id: string; user_id: string }[] = []
    for (const id of ids) {
      for (const r of await getByIndex<{ note_id: string; user_id: string }>('note_seen', 'note_id', id)) {
        out.push({ note_id: r.note_id, user_id: r.user_id })
      }
    }
    return out
  }

  async markNoteSeen(noteId: string, userId: string): Promise<void> {
    const cur = await getOne<Row>('note_seen', [noteId, userId])
    if (cur) return // already confirmed - upsert would be a no-op
    await this.write([up('note_seen', this.stamp('note_seen', { note_id: noteId, user_id: userId, seen_at: nowIso() }))])
  }

  // =========================================================================
  // permissions
  // =========================================================================

  private async permissionCodes(): Promise<Map<string, string>> {
    return new Map((await getAll<{ id: string; code: string }>('permissions')).map((p) => [p.id, p.code]))
  }

  async getRoleGrants(roleId: string): Promise<string[]> {
    const codes = await this.permissionCodes()
    return (await getByIndex<{ permission_id: string }>('role_permissions', 'role_id', roleId))
      .map((r) => codes.get(r.permission_id))
      .filter((c): c is string => !!c)
  }

  async getUserOverrides(userId: string): Promise<Record<string, boolean>> {
    const codes = await this.permissionCodes()
    const map: Record<string, boolean> = {}
    for (const r of await getByIndex<{ permission_id: string; allow: boolean | null }>(
      'user_permissions',
      'user_id',
      userId,
    )) {
      const c = codes.get(r.permission_id)
      if (c) map[c] = r.allow !== false
    }
    return map
  }

  private async permissionIdByCode(codeStr: string): Promise<{ id: string; create?: Change }> {
    const found = (await getByIndex<{ id: string }>('permissions', 'code', codeStr))[0]
    if (found) return { id: found.id }
    // The permission catalogue is global and only the vendor may add to it
    // (migration 011); 004/011 seed every code the app uses.
    throw new Error(`Unknown permission "${codeStr}" - run the Supabase migrations (004/011), then Restore from cloud.`)
  }

  async toggleRoleGrant(roleId: string, permCode: string, granted: boolean): Promise<void> {
    const { id: pid, create } = await this.permissionIdByCode(permCode)
    const cur = await getOne<Row>('role_permissions', [roleId, pid])
    const changes: Change[] = create ? [create] : []
    if (granted) {
      if (!cur) changes.push(up('role_permissions', { role_id: roleId, permission_id: pid }))
    } else if (cur) {
      changes.push(del('role_permissions', [cur]))
    }
    await this.write(changes)
  }

  async setUserOverride(userId: string, permCode: string, allow: boolean | null): Promise<void> {
    const { id: pid, create } = await this.permissionIdByCode(permCode)
    const cur = await getOne<Row>('user_permissions', [userId, pid])
    const changes: Change[] = create ? [create] : []
    if (allow === null) {
      if (cur) changes.push(del('user_permissions', [cur]))
    } else {
      changes.push(up('user_permissions', { ...(cur ?? {}), user_id: userId, permission_id: pid, allow }))
    }
    await this.write(changes)
  }

  // =========================================================================
  // settings
  // =========================================================================

  async getSettings(): Promise<Record<string, string>> {
    const map: Record<string, string> = {}
    for (const s of await getAll<{ key: string; value: string | null }>('settings')) map[s.key] = s.value ?? ''
    return map
  }

  async setSetting(key: string, value: string): Promise<void> {
    const cur = await getOne<Row>('settings', key)
    await this.write([up('settings', this.stamp('settings', { ...(cur ?? {}), key, value }))])
  }

  // =========================================================================
  // staff
  // =========================================================================

  private async withRoles(users: User[]): Promise<User[]> {
    const roles = new Map((await getAll<Role>('roles')).map((r) => [r.id, r]))
    return users.map((u) => ({ ...u, roles: u.role_id ? (roles.get(u.role_id) ?? null) : null }))
  }

  async getUsers(): Promise<User[]> {
    return this.withRoles((await getAll<User>('users')).sort(asc((u) => u.username)))
  }

  async getCurrentUser(authUserId: string | null, authEmail: string | null): Promise<User | null> {
    if (!authUserId) return null
    let row = await getOne<User>('users', authUserId)
    if (!row) {
      const uname = authEmail?.split('@')[0] ?? ''
      if (!uname) return null
      row = (await getByIndex<User>('users', 'username', uname))[0] ?? null
    }
    return row ? (await this.withRoles([row]))[0] : null
  }

  async resolveStaffUserId(): Promise<string | null> {
    // The person signed in on THIS window (not whoever signed in last anywhere).
    const s = currentWindowSession() ?? getLocalSession()
    if (!s) return null
    return (await getOne<User>('users', s.userId))?.id ?? null
  }

  async updateUserRole(id: string, roleId: string | null): Promise<void> {
    const cur = await this.mustGet<User>('users', id)
    await this.write([up('users', { ...cur, role_id: roleId } as unknown as Row)])
  }

  async addRole(name: string): Promise<NamedRow> {
    if ((await getAll<Row>('roles')).some((r) => r.name === name)) throw duplicate(`position "${name}" already exists`)
    const row = this.stamp('roles', { name }) as unknown as NamedRow
    await this.write([up('roles', row as unknown as Row)])
    return row
  }

  // =========================================================================
  // suppliers / purchasing
  // =========================================================================

  async getSuppliers(): Promise<Supplier[]> {
    return (await getAll<Supplier>('suppliers')).sort(asc((s) => s.name))
  }

  async addSupplier(input: SupplierInsert): Promise<Supplier> {
    const row = this.stamp('suppliers', { ...input }) as unknown as Supplier
    await this.write([up('suppliers', row as unknown as Row)])
    return row
  }

  async updateSupplier(id: string, patch: Partial<SupplierInsert>): Promise<void> {
    const cur = await this.mustGet<Supplier>('suppliers', id)
    await this.write([up('suppliers', { ...cur, ...patch, id } as unknown as Row)])
  }

  async deleteSupplier(id: string): Promise<number> {
    const purchases = await getByIndex<Purchase>('purchases', 'supplier_id', id)
    const changes: Change[] = []
    for (const p of purchases) {
      changes.push(del('purchase_payments', await getByIndex<Row>('purchase_payments', 'purchase_id', p.id)))
      changes.push(del('purchase_items', await getByIndex<Row>('purchase_items', 'purchase_id', p.id)))
    }
    changes.push(del('purchases', purchases as unknown as Row[]))
    changes.push(del('suppliers', [{ id }]))
    await this.write(changes)
    return purchases.length
  }

  async getPurchases(supplierId?: string): Promise<Purchase[]> {
    const rows = supplierId
      ? await getByIndex<Purchase>('purchases', 'supplier_id', supplierId)
      : await getAll<Purchase>('purchases')
    return rows.sort(descDate((p) => p.purchase_date))
  }

  async addPurchase(input: PurchaseInsert): Promise<Purchase> {
    const row = this.stamp('purchases', { ...input }) as unknown as Purchase
    await this.write([up('purchases', row as unknown as Row)])
    return row
  }

  async getAllPurchasePayments(): Promise<PurchasePayment[]> {
    return (await getAll<PurchasePayment>('purchase_payments')).sort(descDate((p) => p.paid_at))
  }

  async getPurchasePayments(purchaseId: string): Promise<PurchasePayment[]> {
    return (await getByIndex<PurchasePayment & { created_at?: string }>('purchase_payments', 'purchase_id', purchaseId)).sort(
      (a, b) =>
        String(a.paid_at ?? '').localeCompare(String(b.paid_at ?? '')) ||
        String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
    )
  }

  async addPurchasePayment(input: PurchasePaymentInsert): Promise<PurchasePayment> {
    const row = this.stamp('purchase_payments', { ...input }) as unknown as PurchasePayment
    await this.write([up('purchase_payments', row as unknown as Row)])
    return row
  }

  async deletePurchasePayment(id: string): Promise<void> {
    await this.write([del('purchase_payments', [{ id }])])
  }

  // =========================================================================
  // search
  // =========================================================================

  async globalSearch(term: string): Promise<SearchResults> {
    const q = term.trim().replace(/[,()]/g, ' ')
    const [c, p, s] = await Promise.all([
      getAll<Customer>('customers'),
      getAll<Product>('inventory'),
      getAll<Sale>('sales'),
    ])
    return {
      customers: c.filter((x) => contains(x.name, q) || contains(x.phone, q)).slice(0, 6),
      products: p.filter((x) => contains(x.name, q) || contains(x.sku, q)).slice(0, 6),
      sales: s.filter((x) => contains(x.invoice_no, q)).slice(0, 6),
    }
  }
}
