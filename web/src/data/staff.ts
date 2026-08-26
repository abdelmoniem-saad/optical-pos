import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
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

/**
 * Resolve the signed-in auth user's public.users row.
 * Tries, in order:
 *   1. users.id === auth UID            (the convention for rows we create)
 *   2. users.username === email local   (links LEGACY desktop-era rows — e.g.
 *      the seeded 'admin' — to their auth account without touching their PK)
 * Returns null when neither matches.
 */
async function queryStaffRow(uid: string, username: string): Promise<User | null> {
  const { data: byId } = await supabase
    .from('users')
    .select('*, roles(*)')
    .eq('id', uid)
    .maybeSingle<User>()
  if (byId) return byId
  if (!username) return null
  const { data: byName } = await supabase
    .from('users')
    .select('*, roles(*)')
    .eq('username', username)
    .maybeSingle<User>()
  return byName ?? null
}

/** Fetches the currently signed-in staff user (with role joined). Returns
 *  `null` while unauthenticated or when no row links to this account yet. */
export function useCurrentUser() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['current-user', user?.id ?? null, user?.email ?? null],
    enabled: !!user?.id,
    queryFn: async (): Promise<User | null> => {
      const uname = user!.email?.split('@')[0] ?? ''
      return queryStaffRow(user!.id, uname)
    },
  })
}

/**
 * Same resolution as useCurrentUser, as a plain function — used where hooks
 * can't run (e.g. inside checkout) to stamp sales.user_id. Works for BOTH
 * auth-keyed rows and linked legacy rows, so invoices attribute correctly
 * even on databases migrated from the desktop version.
 */
export async function resolveStaffUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser()
  const uid = data.user?.id
  if (!uid) return null
  const uname = data.user?.email?.split('@')[0] ?? ''
  const row = await queryStaffRow(uid, uname)
  return row?.id ?? null
}

/** True when the signed-in user has a privileged role (Admin/Owner).
 *  Used to gate destructive actions like customer deletion. */
export function useIsAdmin(): boolean {
  const me = useCurrentUser()
  const name = me.data?.roles?.name?.toLowerCase() ?? ''
  return name === 'admin' || name === 'owner'
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
