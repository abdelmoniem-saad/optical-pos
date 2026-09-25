import { Suspense, useLayoutEffect, useRef, useState } from 'react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { displayName, useAuth } from '../lib/auth'
import { useI18n } from '../i18n/LanguageContext'
import { GlobalSearch } from './GlobalSearch'
import { Calculator } from './Calculator'
import { PermissionsProvider, usePermissions } from '../data/permissions'
import { useMyLicense, useIsPlatformAdmin } from '../lib/licensing'
import { NAV_ITEMS } from '../routes/nav'

/** Protected shell: redirects to /login when there's no Supabase session.
 *  Sidebar entries are filtered by the signed-in user's permissions. */
function AppShell() {
  const { user, loading, signOut } = useAuth()
  const { t, lang, toggle } = useI18n()
  const perms = usePermissions()
  const [calcOpen, setCalcOpen] = useState(false)
  const license = useMyLicense()
  const isPlatform = useIsPlatformAdmin()
  const { pathname } = useLocation()
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Every tab starts at the top. Without this the one shared scroll container
  // keeps the previous tab's offset: a long History list left you mid-list, and
  // a short page (Settings) landed at its bottom.
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [pathname])

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

  const visibleNav = NAV_ITEMS.filter((item) => perms.can(`${item.resource}.view` as never))

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
          {perms.openAccess && !perms.loading && (
            <p
              className="rounded-lg bg-warning-bg px-2 py-1 text-xs font-semibold text-warning"
              title={t(
                'No staff record is linked to this account, so access control is not applied.',
              )}
            >
              ⚠ {t('No access group (full access)')}
            </p>
          )}
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
        {licenseGrace && (
          <div className="bg-warning-bg px-4 py-2 text-center text-xs font-semibold text-warning">
            {t('License expired - data is read-only during the grace period. Renew to continue working.')}
          </div>
        )}
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
        {/* pb-16 keeps the last row clear of the phone bottom bar. */}
        <div ref={scrollRef} className="flex-1 overflow-auto pb-16 sm:pb-0">
          <Suspense fallback={<div className="p-6 text-sm text-muted">{t('Loading…')}</div>}>
            <Outlet />
          </Suspense>
        </div>
      </main>

      {/* Phones have no sidebar, so every permitted tab stays reachable from a
          bottom bar - which also carries the language toggle and sign-out that
          otherwise live only in the (hidden) sidebar. */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-1 overflow-x-auto border-t border-line bg-white px-1 py-1 sm:hidden">
        {visibleNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                isActive ? 'bg-brand-bg text-brand-dark' : 'text-muted'
              }`
            }
          >
            {t(item.label)}
          </NavLink>
        ))}
        <button
          onClick={toggle}
          className="ms-auto shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted"
        >
          {lang === 'ar' ? 'EN' : 'ع'}
        </button>
        <button
          onClick={() => signOut()}
          className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-danger"
        >
          {t('Sign out')}
        </button>
      </nav>

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
