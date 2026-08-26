import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useCurrentUser } from './staff'

// Co-locating provider + hook (same pattern as POSContext/auth).
/* eslint-disable react-refresh/only-export-components */

// ---- permission universe -------------------------------------------------

/** Every gated area of the app, in sidebar order. */
export const RESOURCES = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'pos', label: 'New Sale' },
  { key: 'customers', label: 'Customers' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'lab', label: 'Lab' },
  { key: 'history', label: 'History' },
  { key: 'reports', label: 'Reports' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'notes', label: 'Notes' },
  { key: 'staff', label: 'Staff' },
  { key: 'settings', label: 'Settings' },
] as const

export const ACTIONS = ['view', 'create', 'edit', 'delete'] as const
export type Action = (typeof ACTIONS)[number]

export function code(resource: string, action: Action): string {
  return `${resource}.${action}`
}

export const ALL_CODES: string[] = RESOURCES.flatMap((r) =>
  ACTIONS.map((a) => code(r.key, a)),
)

// ---- queries -------------------------------------------------------------

/** Codes granted to a role (ticked boxes in the Access Control matrix). */
export function useRoleGrants(roleId: string | null) {
  return useQuery({
    queryKey: ['role_permissions', roleId],
    enabled: !!roleId,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('role_permissions')
        .select('permissions(code)')
        .eq('role_id', roleId as string)
        .returns<{ permissions: { code: string } | null }[]>()
      if (error) throw error
      return (data ?? [])
        .map((r) => r.permissions?.code)
        .filter((c): c is string => !!c)
    },
  })
}

/** Per-user overrides: code -> allow true/false (absent = inherit role). */
export function useUserOverrides(userId: string | null) {
  return useQuery({
    queryKey: ['user_permissions', userId],
    enabled: !!userId,
    queryFn: async (): Promise<Record<string, boolean>> => {
      const { data, error } = await supabase
        .from('user_permissions')
        .select('allow, permissions(code)')
        .eq('user_id', userId as string)
        .returns<{ allow: boolean | null; permissions: { code: string } | null }[]>()
      if (error) throw error
      const map: Record<string, boolean> = {}
      for (const r of data ?? []) {
        const c = r.permissions?.code
        if (c) map[c] = r.allow !== false
      }
      return map
    },
  })
}

// ---- mutations -----------------------------------------------------------

async function permissionIdByCode(codeStr: string): Promise<string> {
  const { data, error } = await supabase
    .from('permissions')
    .select('id')
    .eq('code', codeStr)
    .maybeSingle<{ id: string }>()
  if (error) throw error
  if (!data) {
    // Unknown code (migration 004 not run / newer app) — create it on the fly.
    const { data: created, error: insErr } = await supabase
      .from('permissions')
      .insert({ code: codeStr })
      .select()
      .single<{ id: string }>()
    if (insErr) throw insErr
    return created.id
  }
  return data.id
}

export function useToggleRoleGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      roleId,
      permCode,
      granted,
    }: {
      roleId: string
      permCode: string
      granted: boolean
    }) => {
      const pid = await permissionIdByCode(permCode)
      if (granted) {
        const { error } = await supabase
          .from('role_permissions')
          .upsert(
            { role_id: roleId, permission_id: pid },
            { onConflict: 'role_id,permission_id' },
          )
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('role_permissions')
          .delete()
          .eq('role_id', roleId)
          .eq('permission_id', pid)
        if (error) throw error
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['role_permissions'] })
      void qc.invalidateQueries({ queryKey: ['my-permissions'] })
    },
  })
}

/**
 * Set/clear a per-user override. `allow === null` removes the override so the
 * user inherits their position's grant again.
 */
export function useSetUserOverride() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      userId,
      permCode,
      allow,
    }: {
      userId: string
      permCode: string
      allow: boolean | null
    }) => {
      const pid = await permissionIdByCode(permCode)
      if (allow === null) {
        const { error } = await supabase
          .from('user_permissions')
          .delete()
          .eq('user_id', userId)
          .eq('permission_id', pid)
        if (error) throw error
        return
      }
      const { error } = await supabase.from('user_permissions').upsert(
        { user_id: userId, permission_id: pid, allow },
        { onConflict: 'user_id,permission_id' },
      )
      if (error) throw error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user_permissions'] })
      void qc.invalidateQueries({ queryKey: ['my-permissions'] })
    },
  })
}

// ---- effective permissions for the signed-in user ------------------------

type PermsState = {
  loading: boolean
  isAdmin: boolean
  /** True when the current user holds this `<resource>.<action>` code. */
  can: (c: string) => boolean
}

const Ctx = createContext<PermsState | undefined>(undefined)

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const me = useCurrentUser()
  const roleId = me.data?.role_id ?? null
  const grants = useRoleGrants(roleId)
  const overrides = useUserOverrides(user?.id ?? null)

  const roleName = me.data?.roles?.name?.toLowerCase() ?? ''
  const isAdmin = roleName === 'admin' || roleName === 'owner'

  const value = useMemo<PermsState>(() => {
    // Admin/owner positions bypass everything.
    if (isAdmin) return { loading: false, isAdmin: true, can: () => true }

    // While loading stay permissive so the UI doesn't flash locked; this is a
    // UI-level gate by design (the DB keeps its authenticated-trust model).
    if (!user || me.isLoading || grants.isLoading || overrides.isLoading) {
      return { loading: true, isAdmin: false, can: () => true }
    }

    const granted = new Set(grants.data ?? [])
    const ov = overrides.data ?? {}
    return {
      loading: false,
      isAdmin: false,
      can(c) {
        const o = ov[c]
        if (o !== undefined) return o // explicit per-person override wins
        return granted.has(c) // else exactly what the position grants
      },
    }
  }, [isAdmin, user, me.isLoading, grants.isLoading, grants.data, overrides.isLoading, overrides.data])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePermissions(): PermsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePermissions must be used within <PermissionsProvider>')
  return ctx
}
