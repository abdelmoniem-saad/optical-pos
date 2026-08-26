import { Suspense, useState } from 'react'
import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { displayName, useAuth } from '../lib/auth'
import { useI18n } from '../i18n/LanguageContext'
import { GlobalSearch } from './GlobalSearch'
import { Calculator } from './Calculator'

const nav = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/pos', label: 'New Sale' },
  { to: '/customers', label: 'Customers' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/lab', label: 'Lab' },
  { to: '/history', label: 'History' },
  { to: '/reports', label: 'Reports' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/staff', label: 'Staff' },
  { to: '/settings', label: 'Settings' },
]

/** Protected shell: redirects to /login when there's no Supabase session. */
export function AppLayout() {
  const { user, loading, signOut } = useAuth()
  const { t, lang, toggle } = useI18n()
  const [calcOpen, setCalcOpen] = useState(false)

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center text-muted">
        {t('Loading…')}
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />

  return (
    <div className="flex min-h-full">
      {/* Sidebar kept visually slim (~214px on screen) under the global 1.25×
          zoom: w-38 layout px ≈ the width the order step was tuned against,
          so its rows still fit on one line. */}
      <aside className="hidden w-38 shrink-0 flex-col bg-white shadow-sm sm:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand font-bold text-white">
            L
          </div>
          <span className="font-semibold text-brand-dark">LensyPOS</span>
        </div>
        <nav className="flex-1 overflow-auto px-2 py-2">
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
