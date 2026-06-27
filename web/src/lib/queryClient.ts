import { QueryClient } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'

// Server-state cache. Tuned for a POS: data is read often, changes rarely
// within a session, and we want snappy navigation between screens.
// gcTime is large so cached queries survive long enough to be persisted
// (must be >= the persister maxAge below).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60_000, // 24h
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

// Persist the cache to localStorage so reads survive a reload / brief offline.
// Full offline-write support (queue + sync) is Phase 7.
export const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'lensy-query-cache',
})

export const PERSIST_MAX_AGE = 24 * 60 * 60_000 // 24h
