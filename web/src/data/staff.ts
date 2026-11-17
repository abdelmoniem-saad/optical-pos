import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'
import { useAuth } from '../lib/auth'

// Re-exported so existing imports from './staff' keep working.
export type { User } from '../lib/database.types'

/** Staff users with their role joined. Mirrors repo.getUsers().
 *  Note: creating/editing auth users is done via the Supabase dashboard or a
 *  service-role Edge Function (see supabase/SETUP.md) - not from the browser. */
export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => getRepo().getUsers(),
  })
}

/** Fetches the currently signed-in staff user (with role joined). Returns
 *  `null` while unauthenticated or when no row links to this account yet. */
export function useCurrentUser() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['current-user', user?.id ?? null, user?.email ?? null],
    enabled: !!user?.id,
    queryFn: () => getRepo().getCurrentUser(user!.id, user!.email ?? null),
  })
}

/**
 * Same resolution as useCurrentUser, as a plain function - used where hooks
 * can't run (e.g. inside checkout) to stamp sales.user_id. Works for BOTH
 * auth-keyed rows and linked legacy rows, so invoices attribute correctly
 * even on databases migrated from the desktop version.
 */
export async function resolveStaffUserId(): Promise<string | null> {
  return getRepo().resolveStaffUserId()
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
    mutationFn: ({ id, role_id }: { id: string; role_id: string | null }) =>
      getRepo().updateUserRole(id, role_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
}
