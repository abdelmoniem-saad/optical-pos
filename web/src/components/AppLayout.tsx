import { Suspense, useState } from 'react'
import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { displayName, useAuth } from '../lib/auth'
import { useI18n } from '../i18n/LanguageContext'
import { GlobalSearch } from './GlobalSearch'
import { Calculator } from './Calculator'
import { PermissionsProvider, usePermissions } from '../data/permissions'
import { useMyLicense, useIsPlatformAdmin } from '../lib/licensing'
import { IS_LOCAL, READ_ONLY } from '../lib/config'
import { useLocalMeta } from '../lib/local/state'
import { SyncBadge } from '../features/local/SyncStatus'
import { LocalOfflineStrip } from './OfflineBanner'
import { useSettings } from '../data/settings'

const nav: { to: string; label: string; end?: boolean; resource: string }[] = [
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

/** Protected shell: redirects to /login when there's no Supabase session.
 *  Sidebar entries are filtered by the signed-in user's permissions. */
function AppShell() {
  const { user, loading, signOut } = useAuth()
  const { t, lang, toggle } = useI18n()
  const perms = usePermissions()
  const [calcOpen, setCalcOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Owner phone view: when did the shop computer last catch up with the cloud?
  const settings = useSettings()
  const pcLastSync = READ_ONLY ? settings.data?.pc_last_sync : undefined
  const license = useMyLicense()
  const isPlatform = useIsPlatformAdmin()
  const localMeta = useLocalMeta()

  // Shop PC that hasn't been linked to its store yet: first-run setup.
  if (IS_LOCAL && !localMeta.provisioned) return <Navigate to="/setup" replace />

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center text-muted">
        {t('Loading…')}
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />

  // License gate: an expired (or missing) license blocks the whole app.
  const licenseState = license.data?.state
  const licenseGrace = !isPlatform && licenseState === 'grace'
  if (!isPlatform && license.data && (licenseState === 'expired' || licenseState === 'none')) {
    return (
      <div dir={lang === 'ar' ? 'rtl' : 'ltr'} className="flex h-full flex-col items-center justify-center bg-surface p-6 text-center">
        <div className="max-w-md rounded-2xl bg-white p-8 shadow-sm">
          <div className="mb-2 text-3xl">🔒</div>
          <h1 className="mb-2 text-xl font-bold text-danger">{t('License expired')}</h1>
          <p className="text-sm text-muted">
            {t('Your data is safe. Contact the vendor to renew the license for')}{' '}
            <span className="font-semibold">{license.data.store_name ?? ''}</span>
          </p>
          {license.data.expires_at && (
            <p className="mt-1 text-xs text-faint">{license.data.expires_at.slice(0, 10)}</p>
          )}
          {IS_LOCAL && (
            // A renewal reaches this PC through cloud sync (re-link here if needed).
            <div className="mt-4 text-start">
              <SyncBadge />
            </div>
          )}
          <button
            onClick={() => signOut()}
            className="mt-4 rounded-lg border border-line px-4 py-2 text-sm text-muted hover:bg-surface"
          >
            {t('Sign out')}
          </button>
        </div>
      </div>
    )
  }

  const visibleNav = nav.filter(
    (item) => perms.can(`${item.resource}.view` as never) && !(READ_ONLY && item.resource === 'pos'),
  )

  const navLinks = (onPick?: () => void) =>
    visibleNav.map((item) => (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        onClick={onPick}
        className={({ isActive }) =>
          `mb-1 block rounded-lg px-3 py-2 text-sm font-medium transition ${
            isActive ? 'bg-brand-bg text-brand-dark' : 'text-muted hover:bg-surface'
          }`
        }
      >
        {t(item.label)}
      </NavLink>
    ))

  return (
    <div className="flex h-full overflow-hidden">
      {menuOpen && (
        // Phone-width menu (the sidebar is hidden below the sm breakpoint).
        <div className="fixed inset-0 z-[65] bg-black/40 sm:hidden" onClick={() => setMenuOpen(false)}>
          <div
            className="h-full w-64 overflow-auto bg-white p-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 truncate px-1 text-sm text-muted">{displayName(user)}</div>
            <nav>{navLinks(() => setMenuOpen(false))}</nav>
            <div className="mt-3 space-y-2 border-t border-line/40 pt-3 text-sm">
              <button
                onClick={toggle}
                className="w-full rounded-lg border border-line px-3 py-2 text-muted hover:bg-surface"
              >
                {lang === 'ar' ? 'English' : 'العربية'}
              </button>
              {IS_LOCAL && <SyncBadge />}
              <button
                onClick={() => signOut()}
                className="w-full rounded-lg border border-line px-3 py-2 text-muted hover:bg-surface"
              >
                {t('Sign out')}
              </button>
            </div>
          </div>
        </div>
      )}
      <aside className="hidden w-38 shrink-0 flex-col bg-white shadow-sm sm:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand font-bold text-white">
            L
          </div>
          <span className="font-semibold text-brand-dark">LensyPOS</span>
        </div>
        <nav className="flex-1 overflow-auto px-2 py-2">
          {navLinks()}
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
          {IS_LOCAL && <SyncBadge />}
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
        {READ_ONLY && (
          <div className="bg-brand-bg px-4 py-2 text-center text-xs font-semibold text-brand-dark">
            {t('Read-only view - the shop computer is the main copy; figures may be a few minutes behind.')}
            {pcLastSync && (
              <span className="ms-1 font-normal">
                {t('Shop computer last synced')}: {new Date(pcLastSync).toLocaleString()}
              </span>
            )}
          </div>
        )}
        {IS_LOCAL && <LocalOfflineStrip />}
        {licenseGrace && (
          <div className="bg-warning-bg px-4 py-2 text-center text-xs font-semibold text-warning">
            {t('License expired - data is read-only during the grace period. Renew to continue working.')}
          </div>
        )}
        <header className="flex items-center gap-3 border-b border-line/40 bg-white px-4 py-2.5">
          <button
            onClick={() => setMenuOpen(true)}
            className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-surface sm:hidden"
            aria-label={t('Menu')}
          >
            ☰
          </button>
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
  // The provider needs auth context, which wraps this route - so it lives
  // here rather than at the router root.
  return (
    <PermissionsProvider>
      <AppShell />
    </PermissionsProvider>
  )
}
