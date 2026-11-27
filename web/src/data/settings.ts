import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Setting } from '../lib/database.types'

const KEY = ['settings'] as const

/** The upsert target: one value per key PER STORE (migration 031). The tenant
 *  trigger fills store_id before the conflict check, so the row is this store's. */
export const SETTINGS_CONFLICT = 'store_id,key'

/** All shop settings as a key→value map. Mirrors repo.get_setting() callers. */
export function useSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .returns<Setting[]>()
      if (error) throw error
      const map: Record<string, string> = {}
      for (const s of data ?? []) map[s.key] = s.value ?? ''
      return map
    },
  })
}

/** Upsert a single setting for the signed-in user's store. */
export async function saveSetting({ key, value }: { key: string; value: string }): Promise<void> {
  const { error } = await supabase
    .from('settings')
    .upsert({ key, value }, { onConflict: SETTINGS_CONFLICT })
  if (error) throw error
}

/** Upsert a single setting. Mirrors repo.set_setting(). */
export function useSetSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: saveSetting,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
