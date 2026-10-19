import type { QueryClient } from '@tanstack/react-query'

/** Dependencies shared by every write path, including nested detail panels. */
export const SALE_READS = [
  'sales', 'sale', 'sale_payments', 'customers', 'customer-orders', 'customer-balance',
  'customer-debtors', 'lab-queue', 'report-totals', 'z-report', 'platform-report',
  'order_examinations', 'past_examinations', 'global-search', 'm-order',
  'inventory', 'stock',
] as const
export const ACCESS_READS = ['my-permissions', 'current-user', 'users', 'roles', 'role_permissions', 'user_permissions', 'my-store-id', 'my-license', 'is-platform-admin'] as const
function refresh(qc: QueryClient, keys: readonly string[]) {
  return Promise.all(keys.map(key => qc.invalidateQueries({ queryKey: [key] })))
}
export const invalidateSales = (qc: QueryClient) => refresh(qc, SALE_READS)
export const invalidateAccess = (qc: QueryClient) => refresh(qc, ACCESS_READS)
export const invalidatePurchases = (qc: QueryClient) => refresh(qc, [
  'suppliers', 'purchases', 'purchase-items', 'purchase_payments', 'inventory', 'stock', 'report-totals',
])
