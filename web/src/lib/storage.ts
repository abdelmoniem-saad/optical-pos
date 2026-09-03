import { supabase } from './supabase'

// Supabase Storage bucket for prescription/reading images. Create it once in the
// dashboard (Storage → New bucket → name "prescriptions", Public) - see
// web/supabase/SETUP.md.
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

/** Public URL for a stored prescription image (bucket must be public). */
export function prescriptionImageUrl(path: string): string {
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
 * return its storage path. Images are downscaled client-side first.
 */
export async function uploadOrderImage(
  file: File,
  invoiceNo: string,
  slot: 'rx' | 'frame',
): Promise<string> {
  const safe = invoiceNo.replace(/[^\w-]/g, '') || 'order'
  const compressed = await downscaleImage(file)
  const ext = (compressed.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `orders/${safe}-${slot}-${Date.now().toString(36)}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, compressed, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw error
  return path
}

/** Remove a previously uploaded order image (used when replacing). */
export async function removeOrderImage(path: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([path])
  if (error) throw error
}
