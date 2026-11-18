// The tables the shop PC mirrors locally, and how each one maps onto Supabase.
//
// `key` is BOTH the local IndexedDB keyPath AND the Supabase upsert conflict
// target, so replaying an outbox entry twice is harmless (upsert/delete by key).

export type TableDef = {
  name: string
  /** Primary key columns (local keyPath + cloud onConflict target). */
  key: string[]
  /** Secondary indexes used by the local queries. */
  indexes?: string[]
  /** Table carries store_id in Supabase (migration 008) - set it explicitly. */
  storeScoped: boolean
  /** Stamp created_at on rows created locally (column known to exist). */
  createdAt?: boolean
  /** Table may be missing on older databases - pull treats "missing" as empty. */
  optional?: boolean
  /**
   * Cloud ON CONFLICT targets to try, in order, when they differ from `key`.
   * The first one the database accepts is remembered (meta 'conflictPick').
   */
  conflict?: string[][]
}

export const TABLES: TableDef[] = [
  { name: 'customers', key: ['id'], storeScoped: true, createdAt: true },
  { name: 'sales', key: ['id'], indexes: ['customer_id', 'invoice_no', 'order_date'], storeScoped: true },
  { name: 'sale_items', key: ['id'], indexes: ['sale_id', 'product_id'], storeScoped: true, createdAt: true },
  { name: 'order_examinations', key: ['id'], indexes: ['sale_id'], storeScoped: true, createdAt: true },
  { name: 'prescriptions', key: ['id'], indexes: ['customer_id'], storeScoped: true, optional: true },
  { name: 'inventory', key: ['id'], storeScoped: true },
  { name: 'stock_movements', key: ['id'], indexes: ['product_id', 'ref_no'], storeScoped: true },
  { name: 'suppliers', key: ['id'], storeScoped: true },
  { name: 'purchases', key: ['id'], indexes: ['supplier_id'], storeScoped: true },
  { name: 'purchase_items', key: ['id'], indexes: ['purchase_id'], storeScoped: true, optional: true },
  {
    name: 'purchase_payments',
    key: ['id'],
    indexes: ['purchase_id'],
    storeScoped: true,
    createdAt: true,
    optional: true,
  },
  { name: 'notes', key: ['id'], storeScoped: true, createdAt: true },
  { name: 'note_seen', key: ['note_id', 'user_id'], indexes: ['note_id'], storeScoped: true, optional: true },
  { name: 'users', key: ['id'], indexes: ['username'], storeScoped: true },
  { name: 'roles', key: ['id'], storeScoped: true },
  // Per-store UNIQUE(store_id, key) after migration 011; global UNIQUE(key) before.
  { name: 'settings', key: ['key'], storeScoped: true, conflict: [['store_id', 'key'], ['key']] },
  { name: 'lens_types', key: ['id'], storeScoped: true, createdAt: true },
  { name: 'frame_colors', key: ['id'], storeScoped: true, createdAt: true },
  { name: 'frame_types', key: ['id'], storeScoped: true, createdAt: true, optional: true },
  { name: 'permissions', key: ['id'], indexes: ['code'], storeScoped: false, optional: true },
  {
    name: 'role_permissions',
    key: ['role_id', 'permission_id'],
    indexes: ['role_id'],
    storeScoped: false,
    optional: true,
  },
  {
    name: 'user_permissions',
    key: ['user_id', 'permission_id'],
    indexes: ['user_id'],
    storeScoped: false,
    optional: true,
  },
]

export const TABLE_BY_NAME: Record<string, TableDef> = Object.fromEntries(TABLES.map((t) => [t.name, t]))

export function tableDef(name: string): TableDef {
  const def = TABLE_BY_NAME[name]
  if (!def) throw new Error(`Table "${name}" is not available offline.`)
  return def
}

/** Properties that are joined/computed in reads and must never be stored. */
export const NON_COLUMN_PROPS = [
  'sale_items',
  'order_examinations',
  'users',
  'customers',
  'roles',
  'permissions',
  'stock_qty',
  'sale',
  'matchedDoctors',
] as const
