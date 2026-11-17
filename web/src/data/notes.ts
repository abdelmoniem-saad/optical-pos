import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'
import type { Note } from '../lib/database.types'

const KEY = ['notes'] as const

export type { Note }

/** Notes visible to everyone (user_id IS NULL), newest first. */
export function useEveryoneNotes() {
  return useQuery({
    queryKey: [...KEY, 'everyone'],
    queryFn: () => getRepo().getEveryoneNotes(),
  })
}

/** The signed-in user's private notes, newest first. */
export function useMyNotes(userId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'mine', userId],
    enabled: !!userId,
    queryFn: () => getRepo().getMyNotes(userId as string),
  })
}

export function useAddNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ body, userId }: { body: string; userId: string | null }) =>
      getRepo().addNote({ body, userId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useUpdateNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => getRepo().updateNote(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

// ---- seen / confirm receipts (public notes, migration 006) ----

/** Seen confirmations for the given public notes. */
export function useNoteSeen(ids: string[]) {
  const idKey = [...ids].sort().join(',')
  return useQuery({
    queryKey: ['note-seen', idKey],
    enabled: ids.length > 0,
    queryFn: () => getRepo().getNoteSeen(ids),
  })
}

export function useMarkNoteSeen() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ noteId, userId }: { noteId: string; userId: string }) =>
      getRepo().markNoteSeen(noteId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['note-seen'] }),
  })
}

export function useDeleteNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => getRepo().deleteNote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
