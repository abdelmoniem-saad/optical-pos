// Entity types for the LensyPOS Supabase schema.
//
// These are hand-derived from how app/database/repository.py reads/writes each
// table, so they cover every column the app actually uses. They are NOT
// auto-generated - for the authoritative shape (exact nullability/types of
// every column), run `npm run gen:types` once you have a Supabase access token
// (see scripts in package.json). TypeScript will flag any drift at build time.

export interface Role {
  id: string
  name: string
}

export interface User {
  id: string
  username: string
  full_name: string | null
  role_id: string | null
  store_id: string | null
  is_active: boolean | null
  // Legacy - Supabase Auth now owns passwords; present only on old rows.
  password_hash?: string | null
  // Present when selected with `*, roles(*)`.
  roles?: Role | null
}

export interface Customer {
  id: string
  name: string
  phone: string | null
  email: string | null
  city: string | null
  address?: string | null
  notes?: string | null
  created_at?: string | null
}
export type CustomerInsert = Omit<Customer, 'id' | 'created_at'> & { name: string }

export type ProductCategory =
  | 'Frame'
  | 'Sunglasses'
  | 'Accessory'
  | 'ContactLens'
  | 'Lens'
  | 'Other'

export interface Product {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  category: ProductCategory | string | null
  sale_price: number | null
  cost_price: number | null
  // Real column since migration 012 (trigger-maintained cache over
  // stock_movements). Kept optional because pre-012 schemas lack it - the
  // client feature-detects (data/inventory.ts) and falls back to the old
  // browser-side sum instead of showing 0.
  stock_qty?: number
}
export type ProductInsert = Omit<Product, 'id' | 'stock_qty'> & {
  name: string
  // add_inventory_item() (migration 012) accepts an initial stock_qty and
  // converts it to a movement in the same transaction.
  stock_qty?: number
}

export type StockMovementType =
  | 'initial'
  | 'sale'
  | 'adjustment'
  | 'purchase'
  | string

export interface StockMovement {
  id: string
  product_id: string
  qty: number
  type: StockMovementType
  // Normalised vocabulary (migration 013), derived from the legacy type by
  // a trigger: initial | sale | void_restock | adjustment | purchase |
  // transfer | other. Nullable on rows written before 013.
  kind: string | null
  ref_no: string | null
  note: string | null
  created_at: string | null
}

export type LabStatus = 'Not Started' | 'In Progress' | 'Ready' | 'Delivered' | string

export interface Sale {
  id: string
  invoice_no: string
  customer_id: string | null
  user_id: string | null
  total_amount: number | null
  discount: number | null
  net_amount: number | null
  amount_paid: number | null
  payment_method: string | null
  order_date: string | null
  delivery_date: string | null
  doctor_name: string | null
  lab_status: LabStatus | null
  // Photo slots per order (migration 007): the prescriptions paper and the
  // glasses frame picture. Paths in the public 'prescriptions' bucket.
  rx_image_path: string | null
  frame_image_path: string | null
  // Present when selected with `*, sale_items(*)`.
  sale_items?: SaleItem[]
  // Present when selected with `*, order_examinations(*)`.
  order_examinations?: OrderExamination[]
  // Present when selected with `*, users(full_name, username)` - the staff
  // member who made the sale (null on legacy/unattributed invoices).
  users?: Pick<User, 'id' | 'username' | 'full_name'> | null
  // Present when selected with `customers(name)` - display name only.
  customers?: Pick<Customer, 'name'> | null
  // One checkout attempt (migration 012): unique per store, so replaying the
  // same key returns this sale instead of writing a second one. Optional
  // because pre-012 schemas don't have the column.
  idempotency_key?: string | null
  // Voiding (migration 013) is an EVENT, never a delete: a voided sale keeps
  // every row and merely carries these three. `voided_at is not null` is the
  // single test for "is this invoice live?".
  voided_at?: string | null
  voided_by?: string | null
  void_reason?: string | null
}
export type SaleInsert = Omit<
  Sale,
  'id' | 'sale_items' | 'order_examinations' | 'users' | 'customers'
>

export interface SaleItem {
  id: string
  sale_id: string
  product_id: string
  qty: number
  unit_price: number | null
  // Always qty * unit_price (a validated DB constraint). A line discount is
  // its own column so the gross line stays honest and the discount is visible.
  total_price: number | null
  // Line-level discount (migration 013), with the reason it was given.
  discount?: number | null
  discount_reason?: string | null
  name: string | null
}
export type SaleItemInsert = Omit<SaleItem, 'id'>

/** One payment received against an invoice (migration 011): split tenders at
 *  checkout AND payments collected later for the remaining balance. */
export interface SalePayment {
  id: string
  sale_id: string
  // Negative since migration 013 - a refund. The column check is amount <> 0,
  // not amount > 0, precisely so money can go back.
  amount: number
  // 'cash' | 'wallet' | 'instapay' | 'card' - free text so a future tender
  // needs no migration.
  method: string
  // 'payment' (money in) or 'refund' (money out). void_sale() writes one
  // refund row per original tender so the cash-up per method stays truthful.
  kind?: string
  note: string | null
  // A timestamptz since migration 013 (was a DATE), so two payments on the
  // same day are distinguishable and a shift/day close can group by time.
  paid_at: string
  recorded_by: string | null
  store_id: string | null
  created_at: string | null
}
export type SalePaymentInsert = {
  sale_id: string
  amount: number
  method: string
  kind?: string
  note?: string | null
  // paid_at / recorded_by / store_id default in the DB (now() /
  // auth.uid() / tenant trigger) - the app only ever sends the core three.
  paid_at?: string
  recorded_by?: string | null
  store_id?: string | null
}

export interface OrderExamination {
  id: string
  sale_id: string
  exam_type: string | null
  sphere_od: string | null
  cylinder_od: string | null
  axis_od: string | null
  sphere_os: string | null
  cylinder_os: string | null
  axis_os: string | null
  ipd: string | null
  lens_info: string | null
  frame_info: string | null
  frame_color: string | null
  frame_status: string | null
  image_path: string | null
}

/** Team/self note (Notes tab). user_id NULL = visible to everyone. */
export interface Note {
  id: string
  user_id: string | null
  created_by: string | null
  body: string
  created_at: string | null
  // Set when the note body was edited after creation.
  updated_at: string | null
}

/** One person's "seen / understood" confirmation on a public note. */
export interface NoteSeen {
  note_id: string
  user_id: string
  seen_at: string | null
}
export type OrderExaminationInsert = Omit<OrderExamination, 'id'>

export interface Prescription {
  id: string
  customer_id: string
  // Optical prescription columns vary; refine with gen:types.
  [extra: string]: unknown
}

export interface Setting {
  key: string
  value: string | null
}
