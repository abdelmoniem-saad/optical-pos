import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { CHECKOUT_MUTATION_KEY, checkoutKeyOf, isCheckoutQueued } from './offlineMutations'
import { markFailed, markLost, markQueued, markSaved, reconcileJournal } from './checkoutJournal'
import { createSaleMutationFn } from '../data/sales'
import { invalidateSales } from '../data/refresh'
import { isAuthDenial } from '../data/permissionModel'

// Access is no longer polled every 15 s (see data/permissions.tsx). The poll's
// job - noticing a revoked or deactivated user - is done here instead: the
// first request the server refuses on authority refreshes the access reads at
// once. Throttled so a screen full of denied queries cannot loop.
let lastAccessRefresh = 0
function refreshAccessOnDenial(err: unknown) {
  if (!isAuthDenial(err)) return
  const now = Date.now()
  if (now - lastAccessRefresh < 10_000) return
  lastAccessRefresh = now
  void queryClient.invalidateQueries({ queryKey: ['my-permissions'] })
  void queryClient.invalidateQueries({ queryKey: ['current-user'] })
}

// Server-state cache. Tuned for a POS: data is read often, changes rarely
// within a session, and we want snappy navigation between screens.
// gcTime is large so cached queries survive long enough to be persisted
// (must be >= the persister maxAge below).
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: refreshAccessOnDenial }),
  mutationCache: new MutationCache({ onError: refreshAccessOnDenial }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60_000, // 24h
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // The library default for mutations is ALSO 'online', which PAUSES a
      // write made offline (silently: the button spins forever, and after a
      // reload the paused write fails with 'No mutationFn found'). Every write
      // except checkout must fail loudly instead - a void, a refund or a
      // re-checkout is a decision made against what the user could SEE, and
      // replaying it later applies it to a world that has moved on.
      networkMode: 'always',
    },
  },
})

// Offline replay for checkout (see offlineMutations.ts for why this is scoped
// to exactly one mutation). `networkMode: 'online'` is what makes TanStack PAUSE
// a checkout made offline instead of failing it, and the per-key default
// overrides the 'always' above for checkout alone.
queryClient.setMutationDefaults(CHECKOUT_MUTATION_KEY, {
  networkMode: 'online',
  // A checkout restored from localStorage after a reload has no hook attached,
  // so it runs THIS function; without it the resumed sale failed with
  // 'No mutationFn found' and was silently dropped from the queue.
  mutationFn: createSaleMutationFn,
  onSuccess: () => {
    void invalidateSales(queryClient)
    void queryClient.invalidateQueries({ queryKey: ['sales'] })
    void queryClient.invalidateQueries({ queryKey: ['inventory'] })
  },
  // A paused mutation must survive long enough to be written to localStorage.
  // Without this the library's 5-minute gc can collect a queued sale before it
  // was ever persisted, and the queue would lose work it claimed to hold.
  gcTime: 1000 * 60 * 60 * 24 * 7,
  retry: 3,
})

// The checkout journal (lib/checkoutJournal.ts): every checkout that enters
// the queue is recorded under its own storage key, forgotten once the server
// has it, and kept - for the banner - when its replay is refused or the queue
// is thrown away (sign-out clears the cache) before it reached the server.
queryClient.getMutationCache().subscribe((event) => {
  const m = event.mutation
  if (!m || m.options.mutationKey?.[0] !== CHECKOUT_MUTATION_KEY[0]) return
  const key = checkoutKeyOf(m.state.variables)
  if (!key) return
  const st = m.state
  if (event.type === 'removed') {
    if (st.status === 'pending') markLost(key)
    return
  }
  if (st.status === 'pending' && st.isPaused) {
    const v = st.variables as { invoiceNo?: string; totals?: { net_amount?: number } } | undefined
    markQueued({ key, invoiceNo: v?.invoiceNo ?? null, net: v?.totals?.net_amount ?? null })
  } else if (st.status === 'success') {
    markSaved(key)
  } else if (st.status === 'error') {
    const err = st.error as { message?: string } | null
    markFailed(key, err?.message || String(err ?? 'Error saving order'))
  }
})

/** Once the persisted cache is restored on boot: a journal entry still marked
 *  queued whose checkout is not in the restored queue was discarded with it
 *  (older than PERSIST_MAX_AGE, or the cache was cleared). */
export function reconcileCheckoutJournal(): void {
  reconcileJournal((key) => isCheckoutQueued(queryClient, key) ||
    queryClient.getMutationCache().findAll({ mutationKey: CHECKOUT_MUTATION_KEY })
      .some((m) => checkoutKeyOf(m.state.variables) === key && m.state.status === 'pending'))
}

// Persist the cache to localStorage so reads survive a reload / brief offline.
// Full offline-write support (queue + sync) is Phase 7.
export const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'lensy-query-cache',
})

export const PERSIST_MAX_AGE = 24 * 60 * 60_000 // 24h
