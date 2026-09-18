import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'

// Thin client for the multi-tenancy/licensing SQL functions (008/009).

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
    queryFn: async (): Promise<string | null> => {
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
      const { data, error } = await supabase.rpc('is_platform_admin')
      if (error) return false
      return !!data
    },
  })
  return q.data ?? false
}
