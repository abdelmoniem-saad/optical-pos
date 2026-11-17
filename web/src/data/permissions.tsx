import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'
import { useAuth } from '../lib/auth'
import { useCurrentUser } from './staff'

// Co-locating provider + hook (same pattern as POSContext/auth).
/* eslint-disable react-refresh/only-export-components */

// ---- permission universe -------------------------------------------------

/** Every gated area of the app, in sidebar order. */
export const RESOURCES = [
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

/** Positions whose members ALWAYS have full access regardless of the matrix.
 *  Kept as data so the UI can explain (and disable) the matrix for them. */
export const BYPASS_ROLE_NAMES = ['admin', 'owner'] as const

export function isBypassRoleName(name: string | null | undefined): boolean {
  return BYPASS_ROLE_NAMES.includes((name ?? '').toLowerCase() as never)
}

/**
 * Reserved account for break-glass access. Whoever logs in with this username
 * sees and may do EVERYTHING, is never listed among employees, and can never
 * be edited through the app. Create the matching Supabase Auth user once
 * (e.g. superadmin@your-domain) and the app links it automatically.
 */
export const SUPERADMIN_USERNAME = 'superadmin'

export function isSuperUsername(username: string | null | undefined): boolean {
  return (username ?? '').trim().toLowerCase() === SUPERADMIN_USERNAME
}

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
    queryFn: () => getRepo().getRoleGrants(roleId as string),
  })
}

/** Per-user overrides: code -> allow true/false (absent = inherit role). */
export function useUserOverrides(userId: string | null) {
  return useQuery({
    queryKey: ['user_permissions', userId],
    enabled: !!userId,
    queryFn: () => getRepo().getUserOverrides(userId as string),
  })
}

// ---- mutations -----------------------------------------------------------

export function useToggleRoleGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      roleId,
      permCode,
      granted,
    }: {
      roleId: string
      permCode: string
      granted: boolean
    }) => getRepo().toggleRoleGrant(roleId, permCode, granted),
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
    mutationFn: ({
      userId,
      permCode,
      allow,
    }: {
      userId: string
      permCode: string
      allow: boolean | null
    }) => getRepo().setUserOverride(userId, permCode, allow),
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
    // Super admin + admin/owner positions bypass everything.
    if (isAdmin || isSuperUsername(me.data?.username)) {
      return { loading: false, isAdmin: true, can: () => true }
    }

    if (!user) return { loading: false, isAdmin: false, can: () => false }

    // While loading stay permissive so the UI doesn't flash locked; this is a
    // UI-level gate by design (the DB keeps its authenticated-trust model).
    if (me.isLoading || grants.isLoading || overrides.isLoading) {
      return { loading: true, isAdmin: false, can: () => true }
    }

    // Break-glass #1: no staff record could be resolved for this account
    // (lookup failure / never linked). Never brick a login over bookkeeping.
    // Break-glass #2: an account WITHOUT any position is treated as fully
    // trusted too - access control applies to people actually placed in a
    // position by the admin.
    if (!me.data || me.isError || !me.data.role_id) {
      return { loading: false, isAdmin: false, can: () => true }
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
  }, [isAdmin, user, me.isLoading, me.isError, me.data, grants.isLoading, grants.data, overrides.isLoading, overrides.data])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePermissions(): PermsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePermissions must be used within <PermissionsProvider>')
  return ctx
}
