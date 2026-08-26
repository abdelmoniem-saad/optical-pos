import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Note } from '../lib/database.types'

const KEY = ['notes'] as const

export type { Note }

/** Notes visible to everyone (user_id IS NULL), newest first. */
export function useEveryoneNotes() {
  return useQuery({
    queryKey: [...KEY, 'everyone'],
    queryFn: async (): Promise<Note[]> => {
      const { data, error } = await supabase
        .from('notes')
        .select('*')
        .is('user_id', null)
        .order('created_at', { ascending: false })
        .returns<Note[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

/** The signed-in user's private notes, newest first. */
export function useMyNotes(userId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'mine', userId],
    enabled: !!userId,
    queryFn: async (): Promise<Note[]> => {
      const { data, error } = await supabase
        .from('notes')
        .select('*')
        .eq('user_id', userId as string)
        .order('created_at', { ascending: false })
        .returns<Note[]>()
      if (error) throw error
      return data ?? []
    },
  })
}

export function useAddNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ body, userId }: { body: string; userId: string | null }): Promise<void> => {
      let createdBy: string | null = null
      const { data: me } = await supabase.auth.getUser()
      if (me.user?.id) createdBy = me.user.id
      const { error } = await supabase.from('notes').insert({
        body: body.trim(),
        user_id: userId,
        created_by: createdBy,
      })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from('notes').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
