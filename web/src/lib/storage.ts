import { supabase } from './supabase'

// Supabase Storage bucket for prescription/reading images. Create it once in the
// dashboard (Storage → New bucket → name "prescriptions", Public) — see
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
