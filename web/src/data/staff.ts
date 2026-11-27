import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { User } from '../lib/database.types'
import { invalidateAccess } from './refresh'
import { ACCESS_STALE_MS } from './permissionModel'
import { usePermissions } from './permissions'

export function useUsers() {
  return useQuery({ queryKey: ['users'], queryFn: async (): Promise<User[]> => {
    const { data, error } = await supabase.from('users').select('*, roles(*)').order('username').returns<User[]>()
    if (error) throw error
    return data ?? []
  } })
}
/** Auth UUID is the only identity key, matching auth_store_id() in SQL. */
async function queryStaffRow(uid: string): Promise<User | null> {
  const { data, error } = await supabase.from('users').select('*, roles(*)').eq('id', uid).maybeSingle<User>()
  if (error) throw error
  return data
}
/** The signed-in staff row. Not polled (it was every 15 s while Notes/Staff
 *  was open): re-read on mount / tab return once stale, and at once after any
 *  server denial (lib/queryClient.ts). The database enforces access itself. */
export function currentUserQuery(uid: string | undefined) {
  return {
    queryKey: ['current-user', uid] as const,
    queryFn: () => queryStaffRow(uid!),
    staleTime: ACCESS_STALE_MS,
    refetchOnWindowFocus: true,
    refetchInterval: false as const,
  }
}
export function useCurrentUser() {
  const { user } = useAuth()
  return useQuery({ ...currentUserQuery(user?.id), enabled: !!user })
}
/** The staff id to stamp on a write. Reads the LOCAL session: getUser() always
 *  makes a network call, which made an offline checkout fail before it could
 *  be queued. A staff-row lookup that cannot reach the server falls back to
 *  null (the checkout RPC records auth.uid() itself). */
export async function resolveStaffUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  const uid = data.session?.user.id
  if (!uid) return null
  try {
    return (await queryStaffRow(uid))?.id ?? null
  } catch {
    return null
  }
}
/** Admin/owner of this shop, from my_permissions.is_admin (is_store_admin() in
 *  SQL: the same active + admin/owner rule this used to re-derive from a polled
 *  users row). */
export function useIsAdmin(): boolean {
  return usePermissions().isAdmin
}
export function useUpdateUserRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, role_id, is_active }: { id: string; role_id: string | null; is_active: boolean }) => {
      const { error } = await supabase.rpc('set_staff_access', { p_user: id, p_role: role_id, p_active: is_active })
      if (error) throw error
    }, onSuccess: () => invalidateAccess(qc),
  })
}
