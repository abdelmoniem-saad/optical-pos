import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { User } from '../lib/database.types'

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
