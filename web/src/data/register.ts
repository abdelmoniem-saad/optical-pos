import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { isMissingRpc } from './rpc'
import { invalidateAccess } from './refresh'

/**
 * The owner's phone side of the register (offline-v2 design 2.8, migration 033).
 *
 * When a shop records on its register PC (stores.register_only), the cloud is
 * a read-only copy and the phone keeps only the owner's two levers: revoke the
 * register (a stolen or lost PC) and switch a staff member off (the PC applies
 * it when it next connects). Plus one line saying when the PC last synced
 * (owner decision 12); the full banner and Flags page are Phase 4.
 *
 * Every call here is reached only while my_permissions() says read_only, which
 * only a 033 database can say, so none of this runs in a shop without a
 * register. A database without the functions answers PGRST202 and the pieces
 * hide instead of failing.
 */

export type RegisterFreshness = {
  /** When the PC last delivered ops (falls back to its last contact). */
  lastSyncAt: string | null
  /** Ops the PC reported as not yet sent, or null when it has not said. */
  pending: number | null
}

function num(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : null
}

function str(x: unknown): string | null {
  return typeof x === 'string' && x.trim() ? x : null
}

/** register_status() answer -> the freshness line. The RPC returns one row
 *  (PostgREST may hand a set-returning function back as an array) or a json
 *  object; anything else, including no register row yet, is null. */
export function parseRegisterStatus(data: unknown): RegisterFreshness | null {
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const lastSyncAt = str(r.last_ingest_at) ?? str(r.last_contact_at)
  const pending = num(r.pending_reported)
  if (lastSyncAt === null && pending === null) return null
  return { lastSyncAt, pending }
}

/** Freshness of the store's register. Only asked while `enabled` (read-only
 *  sessions); a database without register_status() resolves to null. */
export function useRegisterStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['register-status'],
    enabled,
    staleTime: 60_000,
    refetchInterval: enabled ? 2 * 60_000 : false,
    retry: false,
    queryFn: async (): Promise<RegisterFreshness | null> => {
      const { data, error } = await supabase.rpc('register_status')
      if (error) {
        if (isMissingRpc('register_status', error)) return null
        throw error
      }
      return parseRegisterStatus(data)
    },
  })
}

/** Owner only (033 checks auth.uid() = stores.owner_uid): the register's
 *  credential stops working at once; the till keeps selling offline. */
export function useRevokeRegister() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ storeId }: { storeId: string }) => {
      const { error } = await supabase.rpc('revoke_register', { p_store: storeId })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['register-status'] }),
  })
}

/** Owner only: queues a 'staff.deactivate' command the PC applies when it
 *  next connects (design 2.7). Nothing changes in the cloud rows directly. */
export function useOwnerDeactivateStaff() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      const { error } = await supabase.rpc('owner_deactivate_staff', { p_user: userId })
      if (error) throw error
    },
    onSuccess: () => invalidateAccess(qc),
  })
}
