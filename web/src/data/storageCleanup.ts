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

const REFERENCED_PAGE = 1000

/** Every image path a sale references in this store's folder (or any sale of
 *  the store), walked page by page to the END (migration 031). The old version
 *  read every sale in one select, which PostgREST caps at 1,000 rows: past
 *  that, live photos were missing from the keep-list and listed as orphans.
 *  A page shorter than the limit is the last; an error fails the whole scan,
 *  never returns a partial list. */
export async function referencedPaths(storeId: string): Promise<string[]> {
  const out: string[] = []
  let after: string | null = null
  for (;;) {
    const res: { data: unknown; error: unknown } = await supabase.rpc('referenced_image_paths', {
      p_store: storeId,
      p_after: after,
      p_limit: REFERENCED_PAGE,
    })
    if (res.error) throw res.error
    const page: string[] = ((res.data ?? []) as { path: string }[]).map((r) => r.path)
    out.push(...page)
    if (page.length < REFERENCED_PAGE) return out
    after = page[page.length - 1]
  }
}

/**
 * Scan one store's orders folder for orphans. Listing is paginated by the
 * storage API, so this walks pages until they run out rather than trusting a
 * single 100-row page to be the whole folder.
 */
async function scanStore(
  store: { id: string; name: string },
): Promise<OrphanScan> {
  const folder = `store/${store.id}/orders`
  try {
    // The keep-list is read BEFORE the listing: a file uploaded in between is
    // listed but young, and the age gate keeps it.
    const referenced = new Set(await referencedPaths(store.id))
    const files: { name: string; created_at?: string | null; size?: number; metadata?: { size?: number } }[] = []
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

type StoreRow = { id: string; name: string; register_only?: boolean | null }

/** True when PostgREST refused because a selected column does not exist:
 *  stores.register_only before migration 033 is applied. */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  const msg = error.message ?? ''
  return error.code === '42703' ||
    (/register_only/i.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg))
}

/** The stores the sweep may touch. A register_only store (033) keeps every
 *  photo: the PC is its system of record and the storage policy refuses
 *  deletes there for everyone (design 2.9), so it is never listed. A row
 *  without the flag (a database before 033) is an ordinary store. */
export function storesToScan(rows: readonly StoreRow[]): { id: string; name: string }[] {
  return rows.filter((s) => s.register_only !== true).map(({ id, name }) => ({ id, name }))
}

/** Every store, with register_only when the column exists (033); before it,
 *  the plain list, so the sweep keeps working on an older database. */
export async function listStoresForScan(): Promise<{ id: string; name: string }[]> {
  const res = await supabase.from('stores').select('id, name, register_only').order('created_at')
    .returns<StoreRow[]>()
  if (!res.error) return storesToScan(res.data ?? [])
  if (!isMissingColumn(res.error)) throw res.error
  const old = await supabase.from('stores').select('id, name').order('created_at').returns<StoreRow[]>()
  if (old.error) throw old.error
  return storesToScan(old.data ?? [])
}

/** Read-only scan across every store. Does not delete anything. */
export function useOrphanScan() {
  const platform = useIsPlatformAdminQuery()
  return useQuery({
    queryKey: ['orphan-scan'],
    enabled: platform.data === true,
    queryFn: async (): Promise<OrphanScan[]> => {
      const stores = await listStoresForScan()
      const out: OrphanScan[] = []
      for (const s of stores) out.push(await scanStore(s))
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
