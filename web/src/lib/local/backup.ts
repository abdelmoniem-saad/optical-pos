// Local export / import of the shop PC's entire database (data, unsynced
// outbox, stored photos, offline sign-in verifiers). The Supabase replica is
// the off-site backup; this file is the manual one (USB stick, email to self).
import { IMAGES, allStoreNames, getAll, replaceStores, type Row, type StoredImage } from './db'
import { localMeta } from './state'

const FORMAT = 'lensypos-backup'
const VERSION = 1

type BackupFile = {
  format: typeof FORMAT
  version: number
  exportedAt: string
  storeId: string | null
  stores: Record<string, Row[]>
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob()
}

export async function exportBackup(): Promise<{ blob: Blob; filename: string }> {
  const stores: Record<string, Row[]> = {}
  for (const name of allStoreNames()) {
    const rows = await getAll<Row>(name)
    if (name === IMAGES) {
      stores[name] = await Promise.all(
        (rows as unknown as StoredImage[]).map(async (img) => ({
          ...img,
          blob: await blobToDataUrl(img.blob),
        })),
      )
    } else {
      stores[name] = rows
    }
  }
  const file: BackupFile = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    storeId: localMeta().storeId,
    stores,
  }
  const stamp = file.exportedAt.slice(0, 16).replace(/[:T]/g, '-')
  return {
    blob: new Blob([JSON.stringify(file)], { type: 'application/json' }),
    filename: `lensypos-backup-${stamp}.json`,
  }
}

/**
 * Replace EVERYTHING on this PC with the backup's contents (including its
 * unsynced changes, which will then upload). Refuses another store's backup.
 */
export async function importBackup(file: File): Promise<void> {
  let parsed: BackupFile
  try {
    parsed = JSON.parse(await file.text()) as BackupFile
  } catch {
    throw new Error('This file is not a LensyPOS backup.')
  }
  if (parsed?.format !== FORMAT || typeof parsed.stores !== 'object') {
    throw new Error('This file is not a LensyPOS backup.')
  }
  if (parsed.version > VERSION) throw new Error('This backup was made by a newer version of LensyPOS.')
  const mine = localMeta().storeId
  if (mine && parsed.storeId && mine !== parsed.storeId) {
    throw new Error('This backup belongs to a different store.')
  }
  const known = new Set(allStoreNames())
  const data: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(parsed.stores)) {
    if (!known.has(name) || !Array.isArray(rows)) continue
    data[name] =
      name === IMAGES
        ? await Promise.all(rows.map(async (r) => ({ ...r, blob: await dataUrlToBlob(String(r.blob)) })))
        : rows
  }
  await replaceStores(data)
}
