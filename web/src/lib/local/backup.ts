// Local export / import of the shop PC's database: all business data, the
// changes not uploaded yet, and photos that exist only on this PC. The
// Supabase replica is the off-site backup; this file is the manual one (USB
// stick). Never included: offline password verifiers (they are derived from
// staff members' real passwords) and photos already in the cloud.
import {
  CREDENTIALS,
  IMAGES,
  META,
  OUTBOX,
  allStoreNames,
  getAll,
  metaGet,
  metaSet,
  putImage,
  replaceStores,
  snapshot,
  type OutboxEntry,
  type Row,
  type StoredImage,
} from './db'
import { localMeta } from './state'

const FORMAT = 'lensypos-backup'
const VERSION = 2

type BackupFile = {
  format: typeof FORMAT
  version: number
  exportedAt: string
  storeId: string | null
  deviceId?: string | null
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

function maxInvoice(rows: Row[]): number {
  let max = 0
  for (const s of rows) {
    const str = String(s.invoice_no ?? '').trim()
    if (/^\d+$/.test(str)) max = Math.max(max, Number.parseInt(str, 10))
  }
  return max
}

export async function exportBackup(): Promise<{ blob: Blob; filename: string }> {
  const names = allStoreNames().filter((n) => n !== CREDENTIALS)
  const stores = await snapshot(names)
  // Only photos the cloud doesn't have (waiting, or kept on this PC only).
  const images = (stores[IMAGES] as unknown as StoredImage[]).filter((i) => i.uploaded === 0 || i.skipped)
  stores[IMAGES] = await Promise.all(
    images.map(async (img) => ({ ...img, blob: await blobToDataUrl(img.blob) }) as unknown as Row),
  )
  const file: BackupFile = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    storeId: localMeta().storeId,
    deviceId: (await metaGet<string>('deviceId')) ?? null,
    stores,
  }
  const stamp = file.exportedAt.slice(0, 16).replace(/[:T]/g, '-')
  return {
    blob: new Blob([JSON.stringify(file)], { type: 'application/json' }),
    filename: `lensypos-backup-${stamp}.json`,
  }
}

export type BackupInfo = {
  file: BackupFile
  exportedAt: string
  /** Made on this same computer. */
  sameDevice: boolean
  /** Older than the last time this computer was fully synced. */
  olderThanLastSync: boolean
  lastSyncAt: string | null
  sales: number
  waitingChanges: number
}

/** Parse and check a backup file (nothing is changed yet). */
export async function readBackup(file: File): Promise<BackupInfo> {
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
  const deviceId = (await metaGet<string>('deviceId')) ?? null
  const lastSyncAt = (await metaGet<string>('lastSyncAt')) ?? localMeta().lastPullAt
  return {
    file: parsed,
    exportedAt: parsed.exportedAt,
    sameDevice: !!deviceId && parsed.deviceId === deviceId,
    olderThanLastSync: !!lastSyncAt && String(parsed.exportedAt) < lastSyncAt,
    lastSyncAt,
    sales: Array.isArray(parsed.stores.sales) ? parsed.stores.sales.length : 0,
    waitingChanges: Array.isArray(parsed.stores[OUTBOX]) ? parsed.stores[OUTBOX].length : 0,
  }
}

/**
 * Replace this PC's business data with the backup's. This PC keeps its own
 * link to the store (device account, license, register id), its offline
 * passwords and its photos; the invoice sequence never moves backwards (also
 * not behind the cloud, when online).
 */
export async function importBackup(info: BackupInfo, cloudMax: number): Promise<void> {
  const parsed = info.file
  const skip = new Set([META, CREDENTIALS, IMAGES])
  const known = new Set(allStoreNames())
  const data: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(parsed.stores)) {
    if (!known.has(name) || skip.has(name) || !Array.isArray(rows)) continue
    data[name] = rows
  }
  // Changes in a backup of THIS computer made before its last full sync
  // already reached the cloud: replaying them would undo newer cloud edits.
  if (info.sameDevice && info.lastSyncAt && Array.isArray(data[OUTBOX])) {
    const since = info.lastSyncAt
    data[OUTBOX] = (data[OUTBOX] as unknown as OutboxEntry[]).filter((e) => e.createdAt >= since) as unknown as Row[]
  }

  const backupMeta = new Map(((parsed.stores[META] ?? []) as Row[]).map((r) => [r.key, r.value]))
  const high = Math.max(
    (await metaGet<number>('invoiceHigh')) ?? 0,
    maxInvoice(await getAll<Row>('sales')),
    Number(backupMeta.get('invoiceHigh') ?? 0) || 0,
    maxInvoice(data.sales ?? []),
    cloudMax,
  )

  await replaceStores(data)
  await metaSet('invoiceHigh', high)
  for (const r of (parsed.stores[IMAGES] ?? []) as Row[]) {
    if (typeof r.blob !== 'string') continue
    const img = r as unknown as StoredImage & { blob: string }
    await putImage({ ...img, blob: await dataUrlToBlob(img.blob) })
  }
}
