import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { PERSIST_MAX_AGE, persister, queryClient } from './lib/queryClient'
import { AuthProvider } from './lib/auth'
import { LanguageProvider } from './i18n/LanguageContext'
import { AppRouter } from './routes/AppRouter'
import { OfflineBanner } from './components/OfflineBanner'
import { SchemaBanner } from './components/SchemaBanner'
import { FeedbackProvider } from './components/Feedback'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: PERSIST_MAX_AGE,
          // The persister writes BOTH queries and mutations to the same key, but
          // the library's default dehydrate filter keeps only PAUSED mutations -
          // so a checkout rung up while offline is persisted, survives a page
          // reload, and is resumed on reconnect. Successful mutations are never
          // written, so the queue cannot grow without bound, and a mutation is
          // safe to replay because its idempotency key makes the retry return
          // the original sale rather than writing a second one.
        }}
        onSuccess={() => {
          // Resume any writes that were queued while offline once the cache restores.
          queryClient.resumePausedMutations()
        }}
      >
        <AuthProvider>
          <FeedbackProvider>
            <OfflineBanner />
            <SchemaBanner />
            <AppRouter />
          </FeedbackProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </LanguageProvider>
  </StrictMode>,
)
