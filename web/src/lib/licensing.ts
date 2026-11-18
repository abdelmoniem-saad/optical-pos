import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import { IS_LOCAL } from './config'
import { effectiveLicenseState, localMeta } from './local/state'
import { useAuth } from './auth'

// Thin client for the multi-tenancy/licensing SQL functions (008/009).
// On the shop PC (local mode) the answers come from the copy cached at setup
// and refreshed by the sync engine whenever the PC is online.

export type LicenseState = 'active' | 'grace' | 'expired' | 'none'

export type MyLicense = {
  state: LicenseState
  plan: string | null
  expires_at: string | null
  store_name: string | null
}

function localLicense(): MyLicense | null {
  const lic = localMeta().license
  if (!lic) return null
  return {
    state: effectiveLicenseState(lic) ?? lic.state,
    plan: lic.plan,
    expires_at: lic.expires_at,
    store_name: lic.store_name,
  }
}

/** License + store info for the signed-in user. NULL when unlinked. */
export function useMyLicense() {
  // Keyed by account: an answer fetched before sign-in (anonymous) is never reused.
  const uid = useAuth().user?.id ?? null
  return useQuery({
    queryKey: ['my-license', uid],
    enabled: IS_LOCAL || !!uid,
    staleTime: 60_000,
    // The shop PC can stay open for days offline: re-evaluate the cached
    // license (it gets stricter as time passes) without a reload.
    refetchInterval: IS_LOCAL ? 10 * 60_000 : false,
    queryFn: async (): Promise<MyLicense | null> => {
      if (IS_LOCAL) return localLicense()
      const { data, error } = await supabase.rpc('my_license_state').maybeSingle<MyLicense>()
      if (error) throw error
      return data
    },
  })
}

/** The signed-in user's store id (tenancy key for storage paths etc.). */
export function useStoreId() {
  const uid = useAuth().user?.id ?? null
  return useQuery({
    queryKey: ['my-store-id', uid],
    enabled: IS_LOCAL || !!uid,
    staleTime: Infinity,
    queryFn: async (): Promise<string | null> => {
      if (IS_LOCAL) return localMeta().storeId
      const { data, error } = await supabase.rpc('auth_store_id')
      if (error) throw error
      return (data as string | null) ?? null
    },
  })
}

/** Vendor accounts only (separate from store staff/superadmin). */
export function useIsPlatformAdmin(): boolean {
  const uid = useAuth().user?.id ?? null
  const q = useQuery({
    queryKey: ['is-platform-admin', uid],
    enabled: IS_LOCAL || !!uid,
    staleTime: Infinity,
    queryFn: async (): Promise<boolean> => {
      // The shop PC is never a vendor console.
      if (IS_LOCAL) return false
      const { data, error } = await supabase.rpc('is_platform_admin')
      if (error) return false
      return !!data
    },
  })
  return q.data ?? false
}
