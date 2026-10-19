import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { User } from '../lib/database.types'
import { invalidateAccess } from './refresh'
import { isBypassRoleName } from './permissionModel'

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
export function useCurrentUser() {
  const { user } = useAuth()
  return useQuery({ queryKey: ['current-user', user?.id], enabled: !!user,
    queryFn: () => queryStaffRow(user!.id), refetchOnWindowFocus: true, refetchInterval: 15_000 })
}
export async function resolveStaffUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  return data.user ? (await queryStaffRow(data.user.id))?.id ?? null : null
}
export function useIsAdmin(): boolean {
  const me = useCurrentUser()
  return !me.isError && me.data?.is_active === true && isBypassRoleName(me.data.roles?.name)
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
