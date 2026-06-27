import { lazy } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { LoginPage } from '../features/auth/LoginPage'

// Lazy-load each screen so the initial bundle stays small and navigation only
// fetches the code for the screen being opened. The login + shell stay eager.
const named = <T extends Record<string, unknown>, K extends keyof T>(
  loader: () => Promise<T>,
  key: K,
) => lazy(() => loader().then((m) => ({ default: m[key] as React.ComponentType })))

const DashboardPage = named(() => import('../features/dashboard/DashboardPage'), 'DashboardPage')
const POSPage = named(() => import('../features/pos/POSPage'), 'POSPage')
const CustomersPage = named(() => import('../features/customers/CustomersPage'), 'CustomersPage')
const CustomerDetailPage = named(() => import('../features/customers/CustomerDetailPage'), 'CustomerDetailPage')
const InventoryPage = named(() => import('../features/inventory/InventoryPage'), 'InventoryPage')
const LabPage = named(() => import('../features/lab/LabPage'), 'LabPage')
const HistoryPage = named(() => import('../features/history/HistoryPage'), 'HistoryPage')
const ReportsPage = named(() => import('../features/reports/ReportsPage'), 'ReportsPage')
const SuppliersPage = named(() => import('../features/suppliers/SuppliersPage'), 'SuppliersPage')
const StaffPage = named(() => import('../features/staff/StaffPage'), 'StaffPage')
const SettingsPage = named(() => import('../features/settings/SettingsPage'), 'SettingsPage')

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'pos', element: <POSPage /> },
      { path: 'customers', element: <CustomersPage /> },
      { path: 'customers/:id', element: <CustomerDetailPage /> },
      { path: 'inventory', element: <InventoryPage /> },
      { path: 'lab', element: <LabPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'suppliers', element: <SuppliersPage /> },
      { path: 'staff', element: <StaffPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
