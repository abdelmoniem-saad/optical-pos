import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
/* eslint-disable react-refresh/only-export-components */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { ACCESS_STALE_MS, accessAllows, isAuthDenial, readEffectiveAccess, type EffectiveAccess } from './permissionModel'
import { invalidateAccess } from './refresh'
export * from './permissionModel'

export function useRoleGrants(roleId: string | null) {
  return useQuery({
    queryKey: ['role_permissions', roleId], enabled: !!roleId,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase.from('role_permissions').select('permissions(code)')
        .eq('role_id', roleId!).returns<{ permissions: { code: string } | null }[]>()
      if (error) throw error
      return (data ?? []).flatMap(r => r.permissions ? [r.permissions.code] : [])
    },
  })
}
export function useUserOverrides(userId: string | null) {
  return useQuery({
    queryKey: ['user_permissions', userId], enabled: !!userId,
    queryFn: async (): Promise<Record<string, boolean>> => {
      const { data, error } = await supabase.from('user_permissions').select('allow, permissions(code)')
        .eq('user_id', userId!).returns<{ allow: boolean | null; permissions: { code: string } | null }[]>()
      if (error) throw error
      return Object.fromEntries((data ?? []).flatMap(r => r.permissions ? [[r.permissions.code, r.allow === true]] : []))
    },
  })
}
export function useToggleRoleGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ roleId, permCode, granted }: { roleId: string; permCode: string; granted: boolean }) => {
      const { error } = await supabase.rpc('set_role_permission', { p_role: roleId, p_code: permCode, p_granted: granted })
      if (error) throw error
    },
    onSuccess: () => invalidateAccess(qc),
  })
}
export function useSetUserOverride() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, permCode, allow }: { userId: string; permCode: string; allow: boolean | null }) => {
      const { error } = await supabase.rpc('set_user_permission', { p_user: userId, p_code: permCode, p_allow: allow })
      if (error) throw error
    },
    onSuccess: () => invalidateAccess(qc),
  })
}
export type PermsState = {
  loading: boolean; isAdmin: boolean; can: (c: string) => boolean
  openAccess: boolean; error: string | null; active: boolean
  /** The store records on its register PC (033): look, never write. */
  readOnly: boolean
  /** The signed-in account is the store owner (stores.owner_uid, 033). */
  isOwner: boolean
}
const Ctx = createContext<PermsState | undefined>(undefined)

/** The my_permissions read. It is NOT polled: it used to refetch every 15 s
 *  while the tab was visible (about 2,880 calls a day per open register). The
 *  database enforces every action itself (029: resolve_can and auth_store_id
 *  read the live grants on every call), so the UI only has to refresh often
 *  enough that a revoked button does not linger: on load, on navigation (2 min
 *  minimum, in PermissionsProvider), on tab return / reconnect once stale, and
 *  immediately after any server denial (lib/queryClient.ts). */
export function myPermissionsQuery(userId: string | undefined) {
  return {
    queryKey: ['my-permissions', userId] as const,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_permissions')
      if (error) throw error
      return readEffectiveAccess(data)
    },
    staleTime: ACCESS_STALE_MS,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: false as const,
    // A dropped packet must not blank the till; a real denial is not retried.
    retry: (n: number, e: unknown) => n < 2 && !isAuthDenial(e),
  }
}

/** Whether the shell may grant anything. A failed REFETCH keeps the last good
 *  answer (a network blip must not replace the open POS with "no access");
 *  an authority denial, or an answer saying inactive/unassigned, locks at once. */
export function effectiveReady(
  v: EffectiveAccess | undefined,
  q: { isError: boolean; errorCode: string | undefined },
): boolean {
  if (!v || !v.active || !v.assigned) return false
  return !q.isError || !isAuthDenial({ code: q.errorCode })
}

const NAV_REFRESH_MS = 2 * 60_000

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const { pathname } = useLocation()
  const access = useQuery({ ...myPermissionsQuery(user?.id), enabled: !!user })
  // Navigation is a natural moment to re-check, but not on every click.
  const { data: accessData, dataUpdatedAt, refetch } = access
  useEffect(() => {
    if (accessData && Date.now() - dataUpdatedAt > NAV_REFRESH_MS) void refetch()
  }, [pathname, accessData, dataUpdatedAt, refetch])
  useEffect(() => {
    if (!access.data) return
    void qc.invalidateQueries({ queryKey: ['my-license'] })
    void qc.invalidateQueries({ queryKey: ['my-store-id'] })
  }, [qc, access.data])
  const errorCode = (access.error as { code?: unknown } | null)?.code
  const value = useMemo<PermsState>(() => {
    const v = access.data
    const ready = !!user && effectiveReady(v, {
      isError: access.isError,
      errorCode: errorCode === undefined ? undefined : String(errorCode),
    })
    // A cached answer from a build before 033 has no read_only: false.
    const readOnly = ready && !!v && v.read_only === true
    return {
      loading: !!user && access.isPending,
      // Read-only: no admin bypass, so every `isAdmin || can(x)` gate is false.
      isAdmin: ready && !!v && v.is_admin && !readOnly,
      openAccess: !!v && !v.assigned,
      active: v?.active ?? false,
      // Only when it actually blocks: a failed refetch over a good answer keeps working.
      error: access.isError && !ready ? 'Could not load permissions.' : null,
      can: c => ready && !!v && accessAllows(v, c),
      readOnly,
      isOwner: ready && !!v && v.is_owner === true,
    }
  }, [user, access.data, access.isError, access.isPending, errorCode])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
export function usePermissions(): PermsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePermissions must be used within <PermissionsProvider>')
  return ctx
}
