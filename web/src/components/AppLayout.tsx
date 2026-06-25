import { Suspense } from 'react'
import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { displayName, useAuth } from '../lib/auth'

const nav = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/pos', label: 'New Sale' },
  { to: '/customers', label: 'Customers' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/history', label: 'History' },
  { to: '/reports', label: 'Reports' },
  { to: '/staff', label: 'Staff' },
  { to: '/settings', label: 'Settings' },
]

/** Protected shell: redirects to /login when there's no Supabase session. */
export function AppLayout() {
  const { user, loading, signOut } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center text-muted">
        Loading…
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-56 shrink-0 flex-col bg-white shadow-sm sm:flex">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand font-bold text-white">
            L
          </div>
          <span className="font-semibold text-brand-dark">LensyPOS</span>
        </div>
        <nav className="flex-1 px-2 py-2">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `mb-1 block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? 'bg-brand-bg text-brand-dark' : 'text-muted hover:bg-surface'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line/40 px-4 py-3 text-sm">
          <div className="mb-2 truncate text-muted">{displayName(user)}</div>
          <button
            onClick={() => signOut()}
            className="w-full rounded-lg border border-line px-3 py-2 text-muted hover:bg-surface"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto">
        <Suspense fallback={<div className="p-6 text-sm text-muted">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
}
