import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import { IS_LOCAL } from './config'
import { effectiveLicenseState, localMeta } from './local/state'

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
  return useQuery({
    queryKey: ['my-license'],
    staleTime: 60_000,
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
  return useQuery({
    queryKey: ['my-store-id'],
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
  const q = useQuery({
    queryKey: ['is-platform-admin'],
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
