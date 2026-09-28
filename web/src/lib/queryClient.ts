import { QueryClient } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { CHECKOUT_MUTATION_KEY } from './offlineMutations'

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

// Offline replay for checkout (see offlineMutations.ts for why this is scoped
// to exactly one mutation). `networkMode: 'online'` is what makes TanStack PAUSE
// a paused mutation instead of failing it, and the per-key default is what
// applies that to checkout alone — every other mutation keeps the library
// default of failing loudly while offline, which is correct for decisions a
// user made against a view of the world that has since moved on.
queryClient.setMutationDefaults(CHECKOUT_MUTATION_KEY, {
  networkMode: 'online',
  // A paused mutation must survive long enough to be written to localStorage.
  // Without this the library's 5-minute gc can collect a queued sale before it
  // was ever persisted, and the queue would lose work it claimed to hold.
  gcTime: 1000 * 60 * 60 * 24 * 7,
  retry: 3,
})

// Persist the cache to localStorage so reads survive a reload / brief offline.
// Full offline-write support (queue + sync) is Phase 7.
export const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'lensy-query-cache',
})

export const PERSIST_MAX_AGE = 24 * 60 * 60_000 // 24h
