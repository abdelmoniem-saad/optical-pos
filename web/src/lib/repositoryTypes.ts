// Shared types for the repository seam.
//
// These are the shapes the app reads/writes through PosRepository. They live
// here (not in the Supabase implementation) so the local offline implementation
// can use the exact same contracts.
import type { Customer, OrderExamination, OrderExaminationInsert, Product, Sale } from './database.types'

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export type SalesRange = 'all' | 'today' | 'month'

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
  /** Expected delivery date shown on receipts/lab copy (YYYY-MM-DD). */
  deliveryDate?: string
  /** Order photo slots (migration 007): prescriptions paper / frame picture. */
  rxImagePath?: string | null
  frameImagePath?: string | null
  /** If provided (assigned earlier in the wizard), reuse it instead of generating. */
  invoiceNo?: string
}

export type UpdateSaleFullInput = CreateSaleInput & {
  saleId: string
  invoiceNo: string
  /** Whether the sale had examinations BEFORE this re-checkout. */
  previousHadExams: boolean
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export type CustomerSearchHit = Customer & { matchedDoctors: string[] }
export type DeleteCustomerInput = { id: string; cascade?: boolean }

/** Thrown by deleteCustomer when the customer still has related rows
 *  (sales / prescriptions). Callers should confirm with the user and retry
 *  with `cascade: true` to delete the customer along with their orders and
 *  prescriptions. */
export class CustomerHasRelatedRecordsError extends Error {
  readonly orderCount: number
  readonly prescriptionCount: number
  constructor(orderCount: number, prescriptionCount: number) {
    super('Cannot delete this customer because they have existing orders or prescriptions.')
    this.name = 'CustomerHasRelatedRecordsError'
    this.orderCount = orderCount
    this.prescriptionCount = prescriptionCount
  }
}

// ---------------------------------------------------------------------------
// Examinations
// ---------------------------------------------------------------------------

export type PastExam = OrderExamination & { sale: Partial<Sale> }

// ---------------------------------------------------------------------------
// Metadata (lens types, frame colors, roles)
// ---------------------------------------------------------------------------

export type NamedRow = { id: string; name: string; sort_order?: number | null }

export type ExamRefRow = {
  lens_info?: string | null
  frame_color?: string | null
  frame_info?: string | null
}

// ---------------------------------------------------------------------------
// Suppliers / purchasing
// ---------------------------------------------------------------------------

export type Supplier = {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
}
export type SupplierInsert = Omit<Supplier, 'id'> & { name: string }

export type Purchase = {
  id: string
  supplier_id: string | null
  total_amount: number | null
  amount_paid: number | null
  purchase_date: string | null
}
export type PurchaseInsert = Omit<Purchase, 'id'>

/** One dated installment/deposit toward a shipment's total. */
export type PurchasePayment = {
  id: string
  purchase_id: string
  amount: number | null
  paid_at: string | null
  note: string | null
}
export type PurchasePaymentInsert = Omit<PurchasePayment, 'id'>

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchResults = {
  customers: Customer[]
  products: Product[]
  sales: Sale[]
}
