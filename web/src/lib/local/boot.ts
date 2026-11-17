// Shop-PC startup: open the local database, load bookkeeping and stored photos
// into memory, and start replication once the PC has been set up.
import { openDb } from './db'
import { initLocalMeta, localMeta } from './state'
import { initLocalImages } from '../storage'
import { startSync } from './sync'

export async function bootLocal(): Promise<void> {
  await openDb()
  await initLocalMeta()
  await initLocalImages()
  // Ask the browser not to evict this origin's data under storage pressure.
  try {
    await navigator.storage?.persist?.()
  } catch {
    // not supported - data is still kept unless the user clears it
  }
  if (localMeta().provisioned) startSync()
}
