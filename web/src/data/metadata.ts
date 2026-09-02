import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { queryClient } from '../lib/queryClient'
import { ensureFrameProduct } from './inventory'

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

// ---- order-confirmation reference sync ------------------------------------

const distinctNonEmpty = (values: (string | null | undefined)[]): string[] => {
  const out: string[] = []
  for (const v of values) {
    const s = (v ?? '').trim()
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out
}

async function metadataHas(table: string, name: string): Promise<boolean> {
  const { data } = await supabase
    .from(table)
    .select('id')
    .ilike('name', name)
    .limit(1)
    .returns<{ id: string }[]>()
  return !!data?.length
}

/** Add lens/color values used by a CONFIRMED order that don't exist yet.
 *  Called at checkout — never while the order is still being typed. */
export async function addMissingOrderMetadata(
  exams: { lens_info?: string | null; frame_color?: string | null }[],
): Promise<void> {
  const lens = distinctNonEmpty(exams.map((e) => e.lens_info))
  const colors = distinctNonEmpty(exams.map((e) => e.frame_color))

  for (const [table, values] of [
    ['lens_types', lens],
    ['frame_colors', colors],
  ] as const) {
    const missing: string[] = []
    for (const v of values) {
      if (!(await metadataHas(table, v))) missing.push(v)
    }
    if (missing.length) {
      const { error } = await supabase
        .from(table)
        .insert(missing.map((name) => ({ name })))
      if (error) throw error
    }
  }
  const qc = queryClient
  qc.invalidateQueries({ queryKey: ['lens_types'] })
  qc.invalidateQueries({ queryKey: ['frame_colors'] })
}

export type ExamRefRow = {
  lens_info?: string | null
  frame_color?: string | null
  frame_info?: string | null
}

/**
 * Sync the settings/inventory references after a CONFIRMED order is edited:
 *   • lens types / frame colors: newly typed values are ADDED; a replaced
 *     value is DELETED from its list — but only when NO other order still
 *     references it.
 *   • frames: a newly typed frame becomes an inventory product; a removed
 *     frame product is DELETED only when it was app-created clutter (no real
 *     stock, referenced by nothing) — deleting it also removes its phantom
 *     stock movement. Switching to an EXISTING frame never changes quantities.
 * Runs AFTER the order's examinations have been replaced.
 */
export async function syncExamReferences(params: {
  invoiceNo: string
  oldRows: ExamRefRow[]
  newRows: ExamRefRow[]
}): Promise<void> {
  const { oldRows, newRows } = params

  for (const [table, field] of [
    ['lens_types', 'lens_info'],
    ['frame_colors', 'frame_color'],
  ] as const) {
    const oldVals = distinctNonEmpty(oldRows.map((r) => r[field]))
    const newVals = distinctNonEmpty(newRows.map((r) => r[field]))

    for (const v of newVals) {
      if (!(await metadataHas(table, v))) {
        const { error } = await supabase.from(table).insert({ name: v })
        if (error) throw error
      }
    }

    for (const v of oldVals) {
      if (newVals.some((x) => x.toLowerCase() === v.toLowerCase())) continue
      // Delete only when NO other order still uses this value.
      const { data: used } = await supabase
        .from('order_examinations')
        .select('id')
        .ilike(field, v)
        .limit(1)
        .returns<{ id: string }[]>()
      if (used?.length) continue
      const { data: row } = await supabase
        .from(table)
        .select('id')
        .ilike('name', v)
        .limit(1)
        .returns<{ id: string }[]>()
      if (row?.[0]) {
        const { error } = await supabase.from(table).delete().eq('id', row[0].id)
        if (error) throw error
      }
    }
    queryClient.invalidateQueries({ queryKey: [table] })
  }

  // ---- frames vs inventory ----
  const oldFrames = distinctNonEmpty(oldRows.map((r) => r.frame_info))
  const newFrames = distinctNonEmpty(newRows.map((r) => r.frame_info))

  for (const v of newFrames) {
    if (!oldFrames.some((x) => x.toLowerCase() === v.toLowerCase())) {
      await ensureFrameProduct(v)
    }
  }
  queryClient.invalidateQueries({ queryKey: ['inventory'] })

  for (const v of oldFrames) {
    if (newFrames.some((x) => x.toLowerCase() === v.toLowerCase())) continue
    // Still referenced by another order? Keep the product.
    const { data: used } = await supabase
      .from('order_examinations')
      .select('id')
      .ilike('frame_info', v)
      .limit(1)
      .returns<{ id: string }[]>()
    if (used?.length) continue

    // Find the inventory product (case-insensitive).
    const { data: prod } = await supabase
      .from('inventory')
      .select('id')
      .eq('category', 'Frame')
      .ilike('name', v)
      .limit(1)
      .returns<{ id: string }[]>()
    const pid = prod?.[0]?.id
    if (!pid) continue

    // Referenced by a sale line item? Keep it (its stock history is real).
    const { data: si } = await supabase
      .from('sale_items')
      .select('id')
      .eq('product_id', pid)
      .limit(1)
      .returns<{ id: string }[]>()
    if (si?.length) continue

    // Only clean up app-created clutter: product whose net stock is zero or
    // negative (a phantom). Real stock (purchases / initial) is never touched.
    const { data: movs } = await supabase
      .from('stock_movements')
      .select('qty')
      .eq('product_id', pid)
      .returns<{ qty: number | null }[]>()
    const stock = (movs ?? []).reduce((sum, m) => sum + (m.qty ?? 0), 0)
    if (stock > 0) continue

    // Cascades away its phantom movements with it.
    const { error } = await supabase.from('inventory').delete().eq('id', pid)
    if (error) throw error
    queryClient.invalidateQueries({ queryKey: ['inventory'] })
  }
}
