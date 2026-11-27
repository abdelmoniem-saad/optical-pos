import { defaultShouldDehydrateQuery } from '@tanstack/react-query'
import { ACCESS_READS } from './data/refresh'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { PERSIST_MAX_AGE, persister, queryClient, reconcileCheckoutJournal } from './lib/queryClient'
import { CheckoutJournalBanner } from './components/CheckoutJournalBanner'
import { CHECKOUT_MUTATION_KEY } from './lib/offlineMutations'
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
          buster: 'access-029',
          dehydrateOptions: {
            shouldDehydrateQuery: q => !ACCESS_READS.includes(String(q.queryKey[0]) as never) && defaultShouldDehydrateQuery(q),
            // Only a PAUSED CHECKOUT is persisted: it is the one mutation with a
            // default mutationFn (lib/queryClient.ts), so it is the one that can
            // run again after a reload. Anything else written here would be
            // restored without a function and fail with 'No mutationFn found'.
            shouldDehydrateMutation: m => m.options.mutationKey?.[0] === CHECKOUT_MUTATION_KEY[0] && m.state.isPaused,
          },
          // The persister writes BOTH queries and mutations to the same key, so
          // a checkout rung up while offline is persisted, survives a page
          // reload, and is resumed on reconnect. Successful mutations are never
          // written, so the queue cannot grow without bound, and a mutation is
          // safe to replay because its idempotency key makes the retry return
          // the original sale rather than writing a second one.
        }}
        onSuccess={() => {
          // A checkout the journal saw queued that the restored cache no longer
          // holds was discarded with it: say so (CheckoutJournalBanner).
          reconcileCheckoutJournal()
          // Resume any writes that were queued while offline once the cache restores.
          queryClient.resumePausedMutations()
        }}
      >
        <AuthProvider>
          <FeedbackProvider>
            <OfflineBanner />
            <CheckoutJournalBanner />
            <SchemaBanner />
            <AppRouter />
          </FeedbackProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </LanguageProvider>
  </StrictMode>,
)
