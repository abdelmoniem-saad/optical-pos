import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useIsPlatformAdminQuery } from '../lib/licensing'
import { findOrphanedImages, orphanBytes } from '../lib/storageOrphans'

const BUCKET = 'prescriptions'

/**
 * Orphaned-image reconciliation (T15), as an operator action.
 *
 * WHAT AN ORPHAN IS. A photo sitting in a store's `orders/` folder that no
 * sales row references any more - left by a checkout that failed half-way (the
 * image uploaded, the sale row never wrote) or by older builds. A void and an
 * image-replace already delete their own photos; this sweeps up the rest.
 *
 * WHY IT IS CLIENT-SIDE. SQL cannot reach the storage API - the same reason
 * void deletes its images from the browser. So this lists the folder, asks the
 * database which paths are still referenced, and deletes the difference. The
 * DIFFERENCE is computed by the pure, tested storageOrphans module; this file
 * only does the I/O.
 *
 * WHY IT IS PLATFORM-ONLY. It iterates every store's folder, which only a
 * platform admin may do (the storage RLS grants a store access to its own
 * folder and a platform admin to all of them). Best-effort throughout: a file
 * that will not delete is reported, never thrown - a maintenance sweep must not
 * look like a crash.
 */
export type OrphanScan = {
  store_id: string
  store_name: string
  folder: string
  orphans: string[]
  bytes: number
  error?: string
}

/** Every image path still referenced by ANY sale, as full storage paths. */
async function referencedPaths(): Promise<string[]> {
  const { data, error } = await supabase
    .from('sales')
    .select('rx_image_path, frame_image_path')
  if (error) throw error
  const out: string[] = []
  for (const row of data ?? []) {
    const r = row as { rx_image_path: string | null; frame_image_path: string | null }
    if (r.rx_image_path) out.push(r.rx_image_path)
    if (r.frame_image_path) out.push(r.frame_image_path)
  }
  return out
}

/**
 * Scan one store's orders folder for orphans. Listing is paginated by the
 * storage API, so this walks pages until they run out rather than trusting a
 * single 100-row page to be the whole folder.
 */
async function scanStore(
  store: { id: string; name: string },
  referenced: Set<string>,
): Promise<OrphanScan> {
  const folder = `store/${store.id}/orders`
  try {
    const files: { name: string; size?: number; metadata?: { size?: number } }[] = []
    const PAGE = 100
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .list(folder, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
      if (error) throw error
      const page = (data ?? []) as typeof files
      files.push(...page)
      if (page.length < PAGE) break
    }
    const orphans = findOrphanedImages(files, referenced, folder)
    return {
      store_id: store.id,
      store_name: store.name,
      folder,
      orphans,
      bytes: orphanBytes(files, orphans.map((p) => p.slice(folder.length + 1))),
    }
  } catch (e) {
    return {
      store_id: store.id,
      store_name: store.name,
      folder,
      orphans: [],
      bytes: 0,
      error: e instanceof Error ? e.message : 'scan failed',
    }
  }
}

/** Read-only scan across every store. Does not delete anything. */
export function useOrphanScan() {
  const platform = useIsPlatformAdminQuery()
  return useQuery({
    queryKey: ['orphan-scan'],
    enabled: platform.data === true,
    queryFn: async (): Promise<OrphanScan[]> => {
      const { data: stores, error } = await supabase
        .from('stores')
        .select('id, name')
        .order('created_at')
        .returns<{ id: string; name: string }[]>()
      if (error) throw error
      const referenced = new Set(await referencedPaths())
      const out: OrphanScan[] = []
      for (const s of stores ?? []) out.push(await scanStore(s, referenced))
      return out
    },
  })
}

/**
 * Delete a store's orphaned files. Called with the full storage paths AFTER a
 * scan has identified them, so the operator sees the count and the reclaimable
 * size before anything is removed. Best-effort per file. (The store id is not
 * needed here: the paths are already fully-qualified, so the storage API
 * removes them directly - carrying a storeId would be a parameter that lies
 * about doing work.)
 */
export function useDeleteOrphans() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ paths }: { paths: string[] }): Promise<number> => {
      if (paths.length === 0) return 0
      const { error } = await supabase.storage.from(BUCKET).remove(paths)
      if (error) throw error
      return paths.length
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orphan-scan'] })
    },
  })
}
