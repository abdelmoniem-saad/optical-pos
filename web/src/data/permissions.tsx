import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
/* eslint-disable react-refresh/only-export-components */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { readEffectiveAccess } from './permissionModel'
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
type PermsState = {
  loading: boolean; isAdmin: boolean; can: (c: string) => boolean
  openAccess: boolean; error: string | null; active: boolean
}
const Ctx = createContext<PermsState | undefined>(undefined)
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const access = useQuery({
    queryKey: ['my-permissions', user?.id], enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_permissions')
      if (error) throw error
      return readEffectiveAccess(data)
    },
    staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: 'always',
    refetchInterval: 15_000, retry: false,
  })
  useEffect(() => {
    if (!access.data) return
    void qc.invalidateQueries({ queryKey: ['my-license'] })
    void qc.invalidateQueries({ queryKey: ['my-store-id'] })
  }, [qc, access.data])
  const value = useMemo<PermsState>(() => {
    const v = access.data
    const ready = !!user && !access.isError && !!v && v.active && v.assigned
    const codes = new Set(ready ? v.codes : [])
    return {
      loading: !!user && access.isPending,
      isAdmin: ready && v.is_admin,
      openAccess: !!v && !v.assigned,
      active: v?.active ?? false,
      error: access.isError ? 'Could not load permissions.' : null,
      can: c => ready && codes.has(c),
    }
  }, [user, access.data, access.isError, access.isPending])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
export function usePermissions(): PermsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePermissions must be used within <PermissionsProvider>')
  return ctx
}
