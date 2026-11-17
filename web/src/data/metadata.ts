import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'
import type { ExamRefRow } from '../lib/repository'

// Re-exported so existing imports from './metadata' keep working.
export type { NamedRow } from '../lib/repository'

/**
 * Generic id+name lookup table (lens_types, frame_colors, roles…).
 * order 'name'   → alphabetical (roles, generic lists)
 * order 'custom' → persistent sort_order, then creation order (settings).
 */
export const useLensTypes = () =>
  useQuery({ queryKey: ['lens_types', 'custom'], queryFn: () => getRepo().getLensTypes() })

export const useFrameColors = () =>
  useQuery({ queryKey: ['frame_colors', 'custom'], queryFn: () => getRepo().getFrameColors() })

export const useRoles = () => useQuery({ queryKey: ['roles', 'name'], queryFn: () => getRepo().getRoles() })

/** Add a row to a metadata table (lens_types, frame_types, frame_colors).
 *  Pass sortOrder to place the new row in the custom order (settings lists). */
export function useAddMetadata(table: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, sortOrder }: { name: string; sortOrder?: number }) =>
      getRepo().addMetadata(table, name, sortOrder),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  })
}

/** Persist a drag-and-drop reorder: every id gets its new position. */
export function useReorderMetadata(table: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (orderedIds: string[]) => getRepo().reorderMetadata(table, orderedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  })
}

/** Delete a row from a metadata table by id. */
export function useDeleteMetadata(table: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => getRepo().deleteMetadata(table, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [table] }),
  })
}

// ---- order-confirmation reference sync ------------------------------------

/** Add lens/color values used by a CONFIRMED order that don't exist yet.
 *  Called at checkout - never while the order is still being typed. */
export async function addMissingOrderMetadata(
  exams: { lens_info?: string | null; frame_color?: string | null }[],
): Promise<void> {
  return getRepo().addMissingOrderMetadata(exams)
}

/**
 * Sync the settings/inventory references after a CONFIRMED order is edited:
 *   • lens types / frame colors: newly typed values are ADDED; a replaced
 *     value is DELETED from its list - but only when NO other order still
 *     references it.
 *   • frames: a newly typed frame becomes an inventory product; a removed
 *     frame product is DELETED only when it was app-created clutter (no real
 *     stock, referenced by nothing) - deleting it also removes its phantom
 *     stock movement. Switching to an EXISTING frame never changes quantities.
 * Runs AFTER the order's examinations have been replaced.
 */
export async function syncExamReferences(params: {
  invoiceNo: string
  oldRows: ExamRefRow[]
  newRows: ExamRefRow[]
}): Promise<void> {
  return getRepo().syncExamReferences(params)
}
