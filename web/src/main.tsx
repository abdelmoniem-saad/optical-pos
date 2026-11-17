import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { PERSIST_MAX_AGE, persister, queryClient } from './lib/queryClient'
import { AuthProvider } from './lib/auth'
import { IS_LOCAL } from './lib/config'
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

if (IS_LOCAL) {
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
