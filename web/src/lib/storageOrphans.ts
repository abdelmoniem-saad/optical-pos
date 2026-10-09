/**
 * Orphaned-image reconciliation (T15) - the pure diff, no I/O.
 *
 * WHY THIS EXISTS. A void now deletes the invoice's photos client-side, and
 * replacing an image already did. What was NEVER handled: a photo uploaded
 * during a checkout that then FAILED half-way (the image is in the bucket, the
 * sale row was never written), and any orphans left by older builds. Those
 * accumulate in storage forever, and storage is the one thing a shop pays for
 * by the gigabyte.
 *
 * DELIBERATELY IN ITS OWN MODULE, for the same reason platformReportShape.ts
 * and createUserAuthz.ts exist: importing the data/supabase module throws at
 * load time without VITE_SUPABASE_*, so a test that pulls it in cannot run.
 * The diff is the part worth testing - "which files are safe to delete" is
 * exactly the decision that must not be wrong, because a mistake here DELETES
 * a photo a real invoice still points at.
 *
 * THE ONE RULE, STATED ONCE: a file is an orphan ONLY if no sales row still
 * references it. Anything referenced - by any store, voided or not - is kept.
 * The cost of keeping a stray file is a few kilobytes; the cost of deleting a
 * live one is a lost prescription. So the bias is unmistakably toward KEEP.
 */

/** A file as the storage API lists it: `name` is the path WITHIN the folder. */
export type StorageFile = { name: string }

/**
 * The set of image paths that are still referenced by sales rows, already
 * normalised to full storage paths (`store/<id>/orders/<file>`). Built by the
 * caller from `sales.rx_image_path` + `sales.frame_image_path`.
 */
export type ReferencedPaths = Iterable<string | null | undefined>

/** Normalise to the comparable form: trim, and treat empty as absent. */
function norm(p: string | null | undefined): string | null {
  if (p == null) return null
  const t = p.trim()
  return t === '' ? null : t
}

/**
 * Which listed files are safe to delete: present in the bucket folder but
 * referenced by NO sales row.
 *
 * `folderPrefix` is the store's orders folder (`store/<id>/orders`), because
 * the storage API lists by NAME and the caller holds full paths - joining them
 * here keeps the comparison honest instead of trusting a partial match. A file
 * whose name, once prefixed, is in the referenced set is KEPT.
 *
 * The `.emptyFolderPlaceholder` that Supabase writes into an empty folder is
 * never an orphan: deleting it is meaningless and would just make the next
 * list re-create it.
 */
export function findOrphanedImages(
  files: readonly StorageFile[],
  referenced: ReferencedPaths,
  folderPrefix: string,
): string[] {
  const prefix = folderPrefix.replace(/\/+$/, '')
  const keep = new Set<string>()
  for (const r of referenced) {
    const n = norm(r)
    if (n) keep.add(n)
  }

  const orphans: string[] = []
  for (const f of files) {
    const name = norm(f?.name)
    if (!name) continue
    if (name === '.emptyFolderPlaceholder') continue
    const full = `${prefix}/${name}`
    // Keep if the full path is referenced. Also keep if the bare name is
    // referenced - defensive, so a caller that passed unprefixed paths still
    // protects its files rather than deleting them.
    if (keep.has(full) || keep.has(name)) continue
    orphans.push(full)
  }
  return orphans
}

/**
 * How many bytes the orphans represent, from the storage listing's own size
 * field. Best-effort: `size`/`metadata.size` may be absent on some paths, in
 * which case a file counts as 0 rather than throwing. This is for the "you can
 * reclaim ~N MB" line, not for billing.
 */
export function orphanBytes(files: readonly StorageFile[], orphanNames: readonly string[]): number {
  const set = new Set(orphanNames)
  let total = 0
  for (const f of files) {
    const name = norm(f?.name)
    if (!name || !set.has(name)) continue
    const size = (f as { size?: unknown; metadata?: { size?: unknown } }).size
      ?? (f as { metadata?: { size?: unknown } }).metadata?.size
    const n = typeof size === 'number' ? size : Number(size)
    if (Number.isFinite(n) && n > 0) total += n
  }
  return total
}
