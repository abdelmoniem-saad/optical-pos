import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { PERSIST_MAX_AGE, persister, queryClient } from './lib/queryClient'
import { AuthProvider } from './lib/auth'
import { LanguageProvider } from './i18n/LanguageContext'
import { AppRouter } from './routes/AppRouter'
import { OfflineBanner } from './components/OfflineBanner'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, maxAge: PERSIST_MAX_AGE }}
        onSuccess={() => {
          // Resume any writes that were queued while offline once the cache restores.
          queryClient.resumePausedMutations()
        }}
      >
        <AuthProvider>
          <OfflineBanner />
          <AppRouter />
        </AuthProvider>
      </PersistQueryClientProvider>
    </LanguageProvider>
  </StrictMode>,
)
