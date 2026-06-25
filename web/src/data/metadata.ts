import { useQuery } from '@tanstack/react-query'
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
export const useFrameTypes = () => useNamedTable('frame_types')
