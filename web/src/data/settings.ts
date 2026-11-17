import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'

const KEY = ['settings'] as const

/** All shop settings as a key→value map. Mirrors repo.getSettings(). */
export function useSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => getRepo().getSettings(),
  })
}

/** Upsert a single setting. Mirrors repo.setSetting(). */
export function useSetSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => getRepo().setSetting(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
