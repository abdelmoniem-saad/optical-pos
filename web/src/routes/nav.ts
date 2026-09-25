/** Sidebar / phone bottom-bar entries, in order. `resource` is the permission
 *  key (`<resource>.view`) that decides whether the entry is visible. */
export type NavItem = { to: string; label: string; end?: boolean; resource: string }

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'New Sale', end: true, resource: 'pos' },
  { to: '/customers', label: 'Customers', resource: 'customers' },
  { to: '/inventory', label: 'Inventory', resource: 'inventory' },
  { to: '/lab', label: 'Lab', resource: 'lab' },
  { to: '/history', label: 'History', resource: 'history' },
  { to: '/reports', label: 'Reports', resource: 'reports' },
  { to: '/suppliers', label: 'Suppliers', resource: 'suppliers' },
  { to: '/notes', label: 'Notes', resource: 'notes' },
  { to: '/staff', label: 'Staff', resource: 'staff' },
  { to: '/settings', label: 'Settings', resource: 'settings' },
]
