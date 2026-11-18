import { MutationCache, QueryClient } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { IS_LOCAL, READ_ONLY, READ_ONLY_MESSAGE } from './config'
import { ar } from '../i18n/translations'

/** Read-only phone view: every refused save says why (not a silent revert). */
const mutationCache = new MutationCache({
  onError: (e) => {
    if (!READ_ONLY || (e as Error | null)?.name !== 'ReadOnlyError') return
    let lang = 'ar'
    try {
      lang = localStorage.getItem('lensy-lang') ?? 'ar'
    } catch {
      // default language
    }
    window.alert(lang === 'en' ? READ_ONLY_MESSAGE : (ar[READ_ONLY_MESSAGE] ?? READ_ONLY_MESSAGE))
  },
})

// Server-state cache. Tuned for a POS: data is read often, changes rarely
// within a session, and we want snappy navigation between screens.
// gcTime is large so cached queries survive long enough to be persisted
// (must be >= the persister maxAge below).
//
// Local mode (shop PC): every query/mutation hits IndexedDB, which works with
// no network - so TanStack must NOT pause them while the browser is offline
// (its default 'online' network mode would freeze the whole POS).
export const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: {
      staleTime: IS_LOCAL ? 0 : 30_000,
      gcTime: 24 * 60 * 60_000, // 24h
      retry: IS_LOCAL ? 0 : 1,
      refetchOnWindowFocus: false,
      ...(IS_LOCAL ? { networkMode: 'always' as const } : {}),
    },
    mutations: IS_LOCAL ? { networkMode: 'always' } : {},
  },
})

// Persist the cache to localStorage so reads survive a reload / brief offline.
// Not used in local mode: IndexedDB already is the durable copy.
export const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'lensy-query-cache',
})

export const PERSIST_MAX_AGE = 24 * 60 * 60_000 // 24h
