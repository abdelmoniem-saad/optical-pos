import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Setting } from '../lib/database.types'

const KEY = ['settings'] as const

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

/** Upsert a single setting. Mirrors repo.set_setting(). */
export function useSetSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { error } = await supabase
        .from('settings')
        .upsert({ key, value }, { onConflict: 'key' })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
