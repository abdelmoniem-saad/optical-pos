import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import { useAuth } from './auth'

// Thin client for the multi-tenancy/licensing SQL functions (008/009).

// ----- WHY EVERY QUERY HERE IS GATED ON A SESSION -----
//
// auth_store_id() reads auth.uid(), and every RLS policy downstream trusts it.
// That makes these three queries *depend on who is asking*, and that dependency
// is invisible until it bites: a request that goes out BEFORE the session is
// attached is made as `anon`, auth.uid() is NULL, auth_store_id() returns NULL,
// and my_license_state() returns ZERO ROWS - which the app reads as a confident
// "this account is not linked to a store" and a cashier is locked out of the
// till.
//
// It is intermittent, which is what made it hard to see. AuthProvider hydrates
// asynchronously (auth.tsx), and the shell that calls these hooks runs its
// hooks before its `if (loading)` early return, so the request races the
// session restore and sometimes wins the race. Whichever way it lands is
// sticky: useIsPlatformAdmin and useStoreId use `staleTime: Infinity`, so an
// anon answer is not merely wrong for a moment, it is PERSISTED to
// localStorage for 24h and survives every reload until the user signs out.
//
// So: never ask on behalf of nobody. `enabled` keeps the query dormant until
// there is a session to ask with, and the first real answer is the one that
// gets cached.

function useSessionReady(): boolean {
  const { session, loading } = useAuth()
  return !loading && !!session
}

export type LicenseState = 'active' | 'grace' | 'expired' | 'none'

export type MyLicense = {
  state: LicenseState
  plan: string | null
  expires_at: string | null
  store_name: string | null
}

/** License + store info for the signed-in user. NULL when unlinked. */
export function useMyLicense() {
  return useQuery({
    queryKey: ['my-license'],
    staleTime: 60_000,
    enabled: useSessionReady(),
    queryFn: async (): Promise<MyLicense | null> => {
      const { data, error } = await supabase.rpc('my_license_state').maybeSingle<MyLicense>()
      if (error) throw error
      return data
    },
  })
}

/** The signed-in user's store id (tenancy key for storage paths etc.). */
export function useStoreId() {
  return useQuery({
    queryKey: ['my-store-id'],
    staleTime: Infinity,
    enabled: useSessionReady(),
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.rpc('auth_store_id')
      if (error) throw error
      return (data as string | null) ?? null
    },
  })
}

/** Vendor accounts only (separate from store staff/superadmin).
 *
 *  The raw query, for callers that must NOT confuse "we have not asked yet"
 *  with "the answer is no". `isPending` stays true while the query is dormant
 *  (no session) or in flight, which is exactly the window in which a boolean
 *  would be a guess. */
export function useIsPlatformAdminQuery() {
  return useQuery({
    queryKey: ['is-platform-admin'],
    staleTime: Infinity,
    enabled: useSessionReady(),
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc('is_platform_admin')
      if (error) return false
      return !!data
    },
  })
}

/** Boolean form, for gating UI that is simply ABSENT for non-vendors.
 *
 *  Safe there precisely because it is not safe on the page itself: a false
 *  answer while still loading only means the platform section has not appeared
 *  yet, whereas rendering "Platform access only" would deny a vendor whose
 *  answer had not arrived. Use useIsPlatformAdminQuery() for that. */
export function useIsPlatformAdmin(): boolean {
  return useIsPlatformAdminQuery().data ?? false
}
