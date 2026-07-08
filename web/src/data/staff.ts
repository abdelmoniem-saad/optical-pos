import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { User } from '../lib/database.types'

/** Fetches the currently signed-in staff user (with role joined). Returns
 *  `null` while unauthenticated or the row hasn't propagated yet. */
export function useCurrentUser() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['current-user', user?.id ?? null],
    enabled: !!user?.id,
    queryFn: async (): Promise<User | null> => {
      const { data, error } = await supabase
        .from('users')
        .select('*, roles(*)')
        .eq('id', user!.id)
        .maybeSingle<User>()
      if (error) throw error
      return data
    },
  })
}

/** True when the signed-in user has a privileged role (Admin/Owner).
 *  Used to gate destructive actions like customer deletion. */
export function useIsAdmin(): boolean {
  const me = useCurrentUser()
  const name = me.data?.roles?.name?.toLowerCase() ?? ''
  return name === 'admin' || name === 'owner'
}

/** Staff users with their role joined. Mirrors repo.get_users().
 *  Note: creating/editing auth users is done via the Supabase dashboard or a
 *  service-role Edge Function (see supabase/SETUP.md) — not from the browser. */
export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: async (): Promise<User[]> => {
      const { data, error } = await supabase
        .from('users')
        .select('*, roles(*)')
        .order('username')
        .returns<User[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

/** Change a user's role. */
export function useUpdateUserRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, role_id }: { id: string; role_id: string | null }) => {
      const { error } = await supabase.from('users').update({ role_id }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
}
