import { Suspense, useState } from 'react'
import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { displayName, useAuth } from '../lib/auth'
import { useI18n } from '../i18n/LanguageContext'
import { GlobalSearch } from './GlobalSearch'
import { Calculator } from './Calculator'
import { PermissionsProvider, usePermissions } from '../data/permissions'

const nav: { to: string; label: string; end?: boolean; resource: string }[] = [
  { to: '/', label: 'Dashboard', end: true, resource: 'dashboard' },
  { to: '/pos', label: 'New Sale', resource: 'pos' },
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

/** Protected shell: redirects to /login when there's no Supabase session.
 *  Sidebar entries are filtered by the signed-in user's permissions. */
function AppShell() {
  const { user, loading, signOut } = useAuth()
  const { t, lang, toggle } = useI18n()
  const perms = usePermissions()
  const [calcOpen, setCalcOpen] = useState(false)

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center text-muted">
        {t('Loading…')}
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />

  const visibleNav = nav.filter((item) => perms.can(`${item.resource}.view` as never))

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="hidden w-38 shrink-0 flex-col bg-white shadow-sm sm:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand font-bold text-white">
            L
          </div>
          <span className="font-semibold text-brand-dark">LensyPOS</span>
        </div>
        <nav className="flex-1 overflow-auto px-2 py-2">
          {visibleNav.map((item) => (
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
              {t(item.label)}
            </NavLink>
          ))}
          <button
            onClick={() => setCalcOpen(true)}
            className="mb-1 block w-full rounded-lg px-3 py-2 text-start text-sm font-medium text-muted transition hover:bg-surface"
          >
            🧮 {t('Calculator')}
          </button>
        </nav>
        <div className="space-y-2 border-t border-line/40 px-3 py-3 text-sm">
          <button
            onClick={toggle}
            className="w-full rounded-lg border border-line px-3 py-2 text-muted hover:bg-surface"
          >
            {lang === 'ar' ? 'English' : 'العربية'}
          </button>
          <div className="truncate text-muted">{displayName(user)}</div>
          <button
            onClick={() => signOut()}
            className="w-full rounded-lg border border-line px-3 py-2 text-muted hover:bg-surface"
          >
            {t('Sign out')}
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b border-line/40 bg-white px-4 py-2.5">
          <GlobalSearch />
          <button
            onClick={() => setCalcOpen(true)}
            className="ms-auto rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-surface"
            title={t('Calculator')}
          >
            🧮
          </button>
        </header>
        <div className="flex-1 overflow-auto">
          <Suspense fallback={<div className="p-6 text-sm text-muted">{t('Loading…')}</div>}>
            <Outlet />
          </Suspense>
        </div>
      </main>

      {calcOpen && <Calculator onClose={() => setCalcOpen(false)} />}
    </div>
  )
}

export function AppLayout() {
  // The provider needs auth context, which wraps this route — so it lives
  // here rather than at the router root.
  return (
    <PermissionsProvider>
      <AppShell />
    </PermissionsProvider>
  )
}
