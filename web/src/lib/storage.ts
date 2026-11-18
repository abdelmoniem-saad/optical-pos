import { supabase } from './supabase'
import { IS_LOCAL } from './config'
import { IMAGES, getAll, putImage, type StoredImage } from './local/db'
import { localMeta } from './local/state'

// Supabase Storage bucket for prescription/reading images. Create it once in the
// dashboard (Storage -> New bucket -> name "prescriptions", Public) - see
// web/supabase/SETUP.md.
//
// Local mode (shop PC): uploads are kept in IndexedDB and queued; the sync
// engine pushes them to the same bucket path later. The PC shows its own copy
// (blob URL) so photos display with no internet.
const BUCKET = 'prescriptions'

/** Upload a prescription image and return its storage path. */
export async function uploadPrescriptionImage(file: File): Promise<string> {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw error
  return path
}

// path -> blob URL for images this PC holds locally (local mode only).
const localUrls = new Map<string, string>()

/** Load the PC's stored photos so they render offline. Call once at startup. */
export async function initLocalImages(): Promise<void> {
  for (const img of await getAll<StoredImage>(IMAGES)) {
    if (!localUrls.has(img.path)) localUrls.set(img.path, URL.createObjectURL(img.blob))
  }
}

/** URL for a stored prescription image: the PC's local copy when it has one,
 *  else the public bucket URL (bucket must be public). */
export function prescriptionImageUrl(path: string): string {
  const local = localUrls.get(path)
  if (local) return local
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/** Downscale a camera/mobile photo so uploads stay light (max edge ~1600px). */
async function downscaleImage(file: File, max = 1600): Promise<File> {
  try {
    const img = await createImageBitmap(file)
    const scale = Math.min(1, max / Math.max(img.width, img.height))
    if (scale >= 1) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.82),
    )
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file // fall back to the original file if the browser can't decode
  }
}

/**
 * Upload one of an order's photos (prescriptions paper or frame picture) and
 * return its storage path. Every file lives under the STORE's folder
 * (`store/<store_id>/orders/...`) - the tenancy boundary enforced by the
 * storage policies. Images are downscaled client-side first.
 */
export async function uploadOrderImage(
  file: File,
  invoiceNo: string,
  slot: 'rx' | 'frame',
  storeId: string | null | undefined,
): Promise<string> {
  let store = storeId ?? (IS_LOCAL ? localMeta().storeId : null)
  if (!store && !IS_LOCAL) {
    // Signed in a moment ago (the store id was looked up before sign-in).
    const { data } = await supabase.rpc('auth_store_id')
    store = (data as string | null) ?? null
  }
  if (!store) throw new Error('This account is not linked to a store. Sign out and sign in again.')
  const safe = invoiceNo.replace(/[^\w-]/g, '') || 'order'
  const compressed = await downscaleImage(file)
  const path = `store/${store}/orders/${safe}-${slot}-${Date.now().toString(36)}.${imageExt(compressed)}`
  if (IS_LOCAL) {
    // Same path the cloud will use; the sync engine uploads it when online.
    await putImage({
      path,
      blob: compressed,
      contentType: compressed.type || 'image/jpeg',
      createdAt: new Date().toISOString(),
      uploaded: 0,
    })
    localUrls.set(path, URL.createObjectURL(compressed))
    void import('./local/sync').then((m) => m.syncNow())
    return path
  }
  const { error } = await supabase.storage.from(BUCKET).upload(path, compressed, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw error
  return path
}

/** A safe file extension: from the name if it is plain, else from the type. */
function imageExt(f: File): string {
  const fromName = (f.name.includes('.') ? f.name.split('.').pop() : '')?.toLowerCase() ?? ''
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName
  const fromType = (f.type.split('/')[1] ?? '').toLowerCase().replace('jpeg', 'jpg')
  return /^[a-z0-9]{1,5}$/.test(fromType) ? fromType : 'jpg'
}

/**
 * Keep a copy of a cloud photo on the shop PC (e.g. one adopted from the
 * phone) so it still shows with no internet.
 */
export async function cacheCloudImage(path: string): Promise<void> {
  if (!IS_LOCAL || localUrls.has(path)) return
  try {
    const url = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
    const res = await fetch(url)
    if (!res.ok) return
    const blob = await res.blob()
    await putImage({
      path,
      blob,
      contentType: blob.type || 'image/jpeg',
      createdAt: new Date().toISOString(),
      uploaded: 1,
    })
    localUrls.set(path, URL.createObjectURL(blob))
  } catch {
    // offline / not public - it shows from the cloud when online
  }
}

/** Remove a previously uploaded order image (used when replacing). */
export async function removeOrderImage(path: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([path])
  if (error) throw error
}

/** Milliseconds encoded in an order photo name (<inv>-<slot>-<base36 ms>.<ext>). */
function photoMs(name: string): number {
  const m = /-(?:rx|frame)-([0-9a-z]+)\.[a-z0-9]+$/i.exec(name)
  const n = m ? Number.parseInt(m[1], 36) : NaN
  return Number.isFinite(n) ? n : 0
}

/** Newest photo per slot for this invoice, ignoring photos taken before `since`. */
function latestBySlot(names: string[], safe: string, dir: string, since = 0) {
  const bySlot = (slot: 'rx' | 'frame'): string | undefined => {
    const files = names
      .filter((n) => n.startsWith(`${safe}-${slot}-`) && photoMs(n) >= since)
      .sort((a, b) => photoMs(a) - photoMs(b))
    const last = files[files.length - 1]
    return last ? `${dir}/${last}` : undefined
  }
  return { rx: bySlot('rx'), frame: bySlot('frame') }
}

/**
 * Photos for an invoice in CLOUD storage (uploaded from the phone). `since`
 * (ms): ignore older photos - they belong to an earlier, abandoned order that
 * had the same number.
 */
export async function findCloudOrderImages(
  storeId: string,
  invoiceNo: string,
  since = 0,
): Promise<{ rx?: string; frame?: string }> {
  const safe = invoiceNo.replace(/[^\w-]/g, '') || 'order'
  const dir = `store/${storeId}/orders`
  const { data, error } = await supabase.storage.from(BUCKET).list(dir, { limit: 30, search: `${safe}-` })
  if (error || !data) return {}
  return latestBySlot(
    data.map((f) => f.name),
    safe,
    dir,
    since,
  )
}

/**
 * Find mobile-uploaded photos for an invoice that were stored BEFORE the sale
 * row existed (pre-checkout QR flow uploads to storage only, keyed by the
 * invoice number). Checkout adopts them into the sales columns.
 * On the shop PC, photos held locally count too, and the cloud is only asked
 * when online.
 */
export async function findOrderImages(
  storeId: string,
  invoiceNo: string,
  since = 0,
): Promise<{ rx?: string; frame?: string }> {
  if (!IS_LOCAL) return findCloudOrderImages(storeId, invoiceNo, since)
  const store = storeId || localMeta().storeId || ''
  const safe = invoiceNo.replace(/[^\w-]/g, '') || 'order'
  const dir = `store/${store}/orders`
  const local = latestBySlot(
    [...localUrls.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    safe,
    dir,
    since,
  )
  if (local.rx && local.frame) return local
  if (!navigator.onLine || !store) return local
  try {
    // A flaky connection must never hold up checkout: give the cloud 4s.
    const cloud = await Promise.race([
      findCloudOrderImages(store, invoiceNo, since),
      new Promise<{ rx?: string; frame?: string }>((resolve) => setTimeout(() => resolve({}), 4000)),
    ])
    return { rx: local.rx ?? cloud.rx, frame: local.frame ?? cloud.frame }
  } catch {
    return local
  }
}
