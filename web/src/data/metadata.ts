import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

export type NamedRow = { id: string; name: string }

/** Generic id+name lookup table (lens_types, frame_colors, frame_types, roles…).
 *  Mirrors repo.get_metadata(table_name). */
function useNamedTable(table: string) {
  return useQuery({
    queryKey: [table],
    queryFn: async (): Promise<NamedRow[]> => {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .order('name')
        .returns<NamedRow[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

export const useLensTypes = () => useNamedTable('lens_types')
export const useFrameColors = () => useNamedTable('frame_colors')
export const useRoles = () => useNamedTable('roles')

/** Add a row to a metadata table (lens_types, frame_types, frame_colors). */
export function useAddMetadata(table: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (name: string): Promise<NamedRow> => {
      const { data, error } = await supabase
        .from(table)
        .insert({ name: name.trim() })
        .select()
        .single<NamedRow>()
      if (error) throw error
      return data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  })
}

/** Delete a row from a metadata table by id. */
export function useDeleteMetadata(table: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from(table).delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  })
}
