import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { PERSIST_MAX_AGE, persister, queryClient } from './lib/queryClient'
import { AuthProvider } from './lib/auth'
import { CONFIG_ERROR, DEVICE_MARKER_KEY, IS_LOCAL } from './lib/config'
import { LanguageProvider } from './i18n/LanguageContext'
import { AppRouter } from './routes/AppRouter'
import { OfflineBanner } from './components/OfflineBanner'
import './index.css'

const root = createRoot(document.getElementById('root')!)

function QueryProvider({ children }: { children: ReactNode }) {
  // Shop PC: IndexedDB is the durable store; no localStorage cache needed.
  if (IS_LOCAL) return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: PERSIST_MAX_AGE }}
      onSuccess={() => {
        // Resume any writes that were queued while offline once the cache restores.
        queryClient.resumePausedMutations()
      }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}

function render() {
  root.render(
    <StrictMode>
      <LanguageProvider>
        <QueryProvider>
          <AuthProvider>
            <OfflineBanner />
            <AppRouter />
          </AuthProvider>
        </QueryProvider>
      </LanguageProvider>
    </StrictMode>,
  )
}

// After a new deploy, an open page can't load screens it hasn't opened yet
// (their files were replaced): reload once to pick up the new version. The New
// Sale wizard survives the reload.
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('lensy-reloaded-at') ?? 0)
    if (Date.now() - last < 30_000) return // don't loop if the reload didn't help
    sessionStorage.setItem('lensy-reloaded-at', String(Date.now()))
  } catch {
    // storage blocked - reload anyway
  }
  e.preventDefault()
  window.location.reload()
})

function Problem({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 640 }}>
      <h1>{title}</h1>
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  )
}

let wrongBuild = false
try {
  wrongBuild = !IS_LOCAL && localStorage.getItem(DEVICE_MARKER_KEY) === 'local'
} catch {
  // storage blocked
}

if (CONFIG_ERROR) {
  root.render(<Problem title="LensyPOS is misconfigured" lines={[CONFIG_ERROR, 'Fix the build settings and deploy again.']} />)
} else if (wrongBuild) {
  // This browser is the shop register, but the cloud version of the app was
  // deployed at its address: never run it here (it would bypass the PC's data).
  root.render(
    <Problem
      title="Wrong version of LensyPOS at this address"
      lines={[
        'This computer is the shop register, but the version deployed here is the online (cloud) version.',
        'Your data on this computer is safe. Ask your vendor to redeploy the register version (VITE_DATA_MODE=local) to this address.',
      ]}
    />,
  )
} else if (IS_LOCAL) {
  import('./lib/local/boot')
    .then((m) => m.bootLocal())
    .then(render)
    .catch((e) => {
      console.error('Local database failed to open:', e)
      root.render(
        <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
          <h1>LensyPOS could not open its local database</h1>
          <p>{String(e instanceof Error ? e.message : e)}</p>
          <p>Close other LensyPOS windows and reload. Do not clear this browser's site data.</p>
        </div>,
      )
    })
} else {
  render()
}
