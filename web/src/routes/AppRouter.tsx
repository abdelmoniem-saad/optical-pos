import { lazy, type ReactNode } from 'react'
import { Navigate, createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { LoginPage } from '../features/auth/LoginPage'
import { usePermissions } from '../data/permissions'
import { useI18n } from '../i18n/LanguageContext'
import { NAV_ITEMS } from './nav'

// Lazy-load each screen so the initial bundle stays small and navigation only
// fetches the code for the screen being opened. The login + shell stay eager.
const named = <T extends Record<string, unknown>, K extends keyof T>(
  loader: () => Promise<T>,
  key: K,
) => lazy(() => loader().then((m) => ({ default: m[key] as React.ComponentType })))

const POSPage = named(() => import('../features/pos/POSPage'), 'POSPage')
const CustomersPage = named(() => import('../features/customers/CustomersPage'), 'CustomersPage')
const CustomerDetailPage = named(() => import('../features/customers/CustomerDetailPage'), 'CustomerDetailPage')
const InventoryPage = named(() => import('../features/inventory/InventoryPage'), 'InventoryPage')
const LabPage = named(() => import('../features/lab/LabPage'), 'LabPage')
const HistoryPage = named(() => import('../features/history/HistoryPage'), 'HistoryPage')
const ReportsPage = named(() => import('../features/reports/ReportsPage'), 'ReportsPage')
const SuppliersPage = named(() => import('../features/suppliers/SuppliersPage'), 'SuppliersPage')
const NotesPage = named(() => import('../features/notes/NotesPage'), 'NotesPage')
const StaffPage = named(() => import('../features/staff/StaffPage'), 'StaffPage')
const SettingsPage = named(() => import('../features/settings/SettingsPage'), 'SettingsPage')
const MUploadPage = named(() => import('../features/mobile/MUploadPage'), 'MUploadPage')
const PlatformPage = named(() => import('../features/platform/PlatformPage'), 'PlatformPage')

/** Route-level permission gate. Renders a friendly notice instead of the page
 *  when the signed-in user lacks `<resource>.view`. */
function RequirePermission({ resource, children }: { resource: string; children: ReactNode }) {
  const { t } = useI18n()
  const perms = usePermissions()
  // Permission data is cached, so this only ever shows on the very first load -
  // and it beats rendering a page the user may turn out not to be allowed.
  if (perms.loading) return <div className="p-6 text-sm text-muted">{t('Loading…')}</div>
  if (perms.can(`${resource}.view` as never)) return <>{children}</>
  return (
    <div className="p-6">
      <div className="mx-auto max-w-md rounded-xl border border-warning-bg bg-warning-bg px-4 py-3 text-sm font-semibold text-warning">
        🚫 {t('You do not have access to this page.')}
      </div>
    </div>
  )
}

/** Landing gate for '/'. The POS is the default screen, but someone whose
 *  position cannot open the POS should land on the FIRST tab they may open -
 *  not on a no-access notice with no way forward. */
function IndexGate() {
  const { t } = useI18n()
  const perms = usePermissions()
  if (perms.loading) return <div className="p-6 text-sm text-muted">{t('Loading…')}</div>
  if (perms.can('pos.view' as never)) return <POSPage />
  const first = NAV_ITEMS.find((item) => perms.can(`${item.resource}.view` as never))
  if (first) return <Navigate to={first.to} replace />
  return (
    <div className="p-6">
      <div className="mx-auto max-w-md rounded-xl border border-warning-bg bg-warning-bg px-4 py-3 text-sm font-semibold text-warning">
        🚫 {t('You do not have access to this page.')}
      </div>
    </div>
  )
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  // Standalone mobile upload page: own minimal layout, own login gate.
  { path: '/m-upload', element: <MUploadPage /> },
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <IndexGate /> },
      // One screen = one URL: old /pos links land on the canonical /.
      { path: 'pos', element: <Navigate to="/" replace /> },
      {
        path: 'customers',
        element: (
          <RequirePermission resource="customers">
            <CustomersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'customers/:id',
        element: (
          <RequirePermission resource="customers">
            <CustomerDetailPage />
          </RequirePermission>
        ),
      },
      {
        path: 'inventory',
        element: (
          <RequirePermission resource="inventory">
            <InventoryPage />
          </RequirePermission>
        ),
      },
      {
        path: 'lab',
        element: (
          <RequirePermission resource="lab">
            <LabPage />
          </RequirePermission>
        ),
      },
      {
        path: 'history',
        element: (
          <RequirePermission resource="history">
            <HistoryPage />
          </RequirePermission>
        ),
      },
      {
        path: 'reports',
        element: (
          <RequirePermission resource="reports">
            <ReportsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'suppliers',
        element: (
          <RequirePermission resource="suppliers">
            <SuppliersPage />
          </RequirePermission>
        ),
      },
      {
        path: 'notes',
        element: (
          <RequirePermission resource="notes">
            <NotesPage />
          </RequirePermission>
        ),
      },
      {
        path: 'staff',
        element: (
          <RequirePermission resource="staff">
            <StaffPage />
          </RequirePermission>
        ),
      },
      {
        path: 'settings',
        element: (
          <RequirePermission resource="settings">
            <SettingsPage />
          </RequirePermission>
        ),
      },
      {
        path: 'platform',
        element: <PlatformPage />,
      },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
