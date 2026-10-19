/** Only actions implemented by the app. Keep in sync with migration 029. */
export const RESOURCES = [
  { key: 'pos', label: 'New Sale', actions: ['view', 'create', 'edit'] },
  { key: 'customers', label: 'Customers', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'inventory', label: 'Inventory', actions: ['view', 'create', 'edit'] },
  { key: 'lab', label: 'Lab', actions: ['view', 'edit'] },
  { key: 'history', label: 'History', actions: ['view', 'edit', 'void', 'refund'] },
  { key: 'reports', label: 'Reports', actions: ['view'] },
  { key: 'closing', label: 'Close the shift', actions: ['view', 'edit'] },
  { key: 'suppliers', label: 'Suppliers', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'notes', label: 'Notes', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'staff', label: 'Staff', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'settings', label: 'Settings', actions: ['view', 'edit'] },
] as const
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'void', 'refund'] as const
export type Action = (typeof ACTIONS)[number]
export const BYPASS_ROLE_NAMES = ['admin', 'owner'] as const
export const SUPERADMIN_USERNAME = 'superadmin'
export const isBypassRoleName = (name: string | null | undefined) =>
  BYPASS_ROLE_NAMES.includes((name ?? '').trim().toLowerCase() as never)
export const isSuperUsername = (name: string | null | undefined) =>
  (name ?? '').trim().toLowerCase() === SUPERADMIN_USERNAME
export const code = (resource: string, action: Action) => `${resource}.${action}`
export const ALL_CODES: string[] = RESOURCES.flatMap(r => r.actions.map(a => code(r.key, a)))
export function resolveCan(granted: ReadonlySet<string>, overrides: Record<string, boolean>, c: string): boolean {
  if (!ALL_CODES.includes(c)) return false
  const has = (key: string) => overrides[key] ?? granted.has(key)
  return has(c) && (c.endsWith('.view') || has(`${c.split('.')[0]}.view`))
}
export type EffectiveAccess = { is_admin: boolean; active: boolean; assigned: boolean; codes: string[] }
export function readEffectiveAccess(data: unknown): EffectiveAccess {
  if (!data || typeof data !== 'object') throw new Error('Could not load permissions.')
  const v = data as Record<string, unknown>
  if (typeof v.is_admin !== 'boolean' || typeof v.active !== 'boolean' ||
      typeof v.assigned !== 'boolean' || !Array.isArray(v.codes) ||
      !v.codes.every(c => typeof c === 'string')) throw new Error('Could not load permissions.')
  return v as EffectiveAccess
}
