// The repository seam.
//
// The whole app reads/writes business data through PosRepository:
//   SupabaseRepository - online, talks to Supabase directly (default)
//   LocalRepository    - offline shop PC, IndexedDB + outbox replication
//   readOnly(...)      - hosted phone view, writes refused
// Swapping implementations never changes a screen.
//
// Swap is controlled by VITE_DATA_MODE=supabase|local (default: supabase).
import type {
  Customer,
  CustomerInsert,
  Note,
  OrderExamination,
  OrderExaminationInsert,
  Product,
  ProductInsert,
  Sale,
  User,
} from './database.types'
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
import { SupabaseRepository } from './repositorySupabase'
import { LocalRepository } from './repositoryLocal'
import { readOnly } from './repositoryReadOnly'
import { IS_LOCAL, READ_ONLY } from './config'

export * from './repositoryTypes'

export interface PosRepository {
  // ---- customers ----
  getCustomers(): Promise<Customer[]>
  getCustomer(id: string): Promise<Customer | null>
  searchCustomers(term: string): Promise<Customer[]>
  searchCustomersExtended(term: string): Promise<CustomerSearchHit[]>
  getCustomersPage(offset: number, limit: number): Promise<{ rows: Customer[]; count: number }>
  addCustomer(input: CustomerInsert): Promise<Customer>
  updateCustomer(id: string, patch: Partial<CustomerInsert>): Promise<void>
  deleteCustomer(id: string, cascade?: boolean): Promise<void>

  // ---- sales ----
  getSalesSummary(): Promise<Sale[]>
  getSalesPage(
    range: SalesRange,
    term: string,
    offset: number,
    limit: number,
  ): Promise<{ rows: Sale[]; count: number }>
  getLabSalesPage(status: string, offset: number, limit: number): Promise<{ rows: Sale[]; count: number }>
  getCustomerOrders(customerId: string): Promise<Sale[]>
  getNextInvoiceNo(): Promise<string>
  createSale(input: CreateSaleInput): Promise<Sale>
  updateSaleFull(input: UpdateSaleFullInput): Promise<Sale>
  updateSale(id: string, patch: Partial<Sale>): Promise<void>
  updateLabStatus(id: string, status: string): Promise<void>
  setOrderImage(saleId: string, slot: 'rx' | 'frame', path: string | null): Promise<void>
  addStandalonePrescription(input: {
    customerId: string
    exam: Omit<OrderExaminationInsert, 'sale_id'>
    doctorName?: string
  }): Promise<Sale>
  getSaleByInvoiceNo(invoiceNo: string): Promise<Sale | null>

  // ---- examinations ----
  getOrderExaminations(saleId: string): Promise<OrderExamination[]>
  replaceOrderExaminations(saleId: string, exams: Omit<OrderExamination, 'id' | 'sale_id'>[]): Promise<void>
  getPastExaminations(customerId: string): Promise<PastExam[]>

  // ---- inventory ----
  getInventory(category?: string): Promise<Product[]>
  /** Exact SKU match first, then name contains. Used by the POS quick-add. */
  findProductBySkuOrName(term: string): Promise<Product | null>
  getProductStock(productId: string): Promise<number>
  addProduct(input: ProductInsert): Promise<Product>
  updateProduct(id: string, patch: Partial<Omit<ProductInsert, 'stock_qty'>>): Promise<void>
  adjustStock(input: {
    productId: string
    qtyChange: number
    type?: string
    note?: string
    refNo?: string
  }): Promise<void>
  ensureFrameProduct(name: string): Promise<Product | null>

  // ---- metadata (lens types, frame colors, roles) ----
  getLensTypes(): Promise<NamedRow[]>
  getFrameColors(): Promise<NamedRow[]>
  getRoles(): Promise<NamedRow[]>
  addMetadata(table: string, name: string, sortOrder?: number): Promise<NamedRow>
  reorderMetadata(table: string, orderedIds: string[]): Promise<void>
  deleteMetadata(table: string, id: string): Promise<void>
  addMissingOrderMetadata(exams: { lens_info?: string | null; frame_color?: string | null }[]): Promise<void>
  syncExamReferences(params: { invoiceNo: string; oldRows: ExamRefRow[]; newRows: ExamRefRow[] }): Promise<void>

  // ---- notes ----
  getEveryoneNotes(): Promise<Note[]>
  getMyNotes(userId: string): Promise<Note[]>
  addNote(input: { body: string; userId: string | null }): Promise<void>
  updateNote(id: string, body: string): Promise<void>
  deleteNote(id: string): Promise<void>
  getNoteSeen(ids: string[]): Promise<{ note_id: string; user_id: string }[]>
  markNoteSeen(noteId: string, userId: string): Promise<void>

  // ---- permissions ----
  getRoleGrants(roleId: string): Promise<string[]>
  getUserOverrides(userId: string): Promise<Record<string, boolean>>
  toggleRoleGrant(roleId: string, permCode: string, granted: boolean): Promise<void>
  setUserOverride(userId: string, permCode: string, allow: boolean | null): Promise<void>

  // ---- settings ----
  getSettings(): Promise<Record<string, string>>
  setSetting(key: string, value: string): Promise<void>

  // ---- staff ----
  getUsers(): Promise<User[]>
  getCurrentUser(authUserId: string | null, authEmail: string | null): Promise<User | null>
  resolveStaffUserId(): Promise<string | null>
  updateUserRole(id: string, roleId: string | null): Promise<void>
  addRole(name: string): Promise<NamedRow>

  // ---- suppliers / purchasing ----
  getSuppliers(): Promise<Supplier[]>
  addSupplier(input: SupplierInsert): Promise<Supplier>
  updateSupplier(id: string, patch: Partial<SupplierInsert>): Promise<void>
  deleteSupplier(id: string): Promise<number>
  getPurchases(supplierId?: string): Promise<Purchase[]>
  addPurchase(input: PurchaseInsert): Promise<Purchase>
  getAllPurchasePayments(): Promise<PurchasePayment[]>
  getPurchasePayments(purchaseId: string): Promise<PurchasePayment[]>
  addPurchasePayment(input: PurchasePaymentInsert): Promise<PurchasePayment>
  deletePurchasePayment(id: string): Promise<void>

  // ---- search ----
  globalSearch(term: string): Promise<SearchResults>
}

let instance: PosRepository | null = null

/**
 * The app's single data-access object, chosen by the deployment flags in
 * config.ts: VITE_DATA_MODE=local -> offline LocalRepository (shop PC);
 * otherwise Supabase, wrapped read-only when VITE_READ_ONLY=true (phone view).
 */
export function getRepo(): PosRepository {
  if (!instance) {
    if (IS_LOCAL) instance = new LocalRepository()
    else if (READ_ONLY) instance = readOnly(new SupabaseRepository())
    else instance = new SupabaseRepository()
  }
  return instance
}
