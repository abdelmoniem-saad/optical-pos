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
  // Computed from stock_movements, not a stored column.
  stock_qty?: number
}
export type ProductInsert = Omit<Product, 'id' | 'stock_qty'> & {
  name: string
  // add_inventory_item() accepts an initial stock_qty and converts it to a movement.
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
  // Present when selected with `*, sale_items(*)`.
  sale_items?: SaleItem[]
  // Present when selected with `*, order_examinations(*)`.
  order_examinations?: OrderExamination[]
  // Present when selected with `*, users(full_name, username)` - the staff
  // member who made the sale (null on legacy/unattributed invoices).
  users?: Pick<User, 'id' | 'username' | 'full_name'> | null
  // Present when selected with `customers(name)` - display name only.
  customers?: Pick<Customer, 'name'> | null
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
  total_price: number | null
  name: string | null
}
export type SaleItemInsert = Omit<SaleItem, 'id'>

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
