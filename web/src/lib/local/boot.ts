// Shop-PC startup: open the local database, load bookkeeping and stored photos
// into memory, and start replication once the PC has been set up.
import { onCommit, openDb } from './db'
import { initLocalMeta, localMeta } from './state'
import { initLocalImages } from '../storage'
import { startSync } from './sync'
import { queryClient } from '../queryClient'
import { DEVICE_MARKER_KEY } from '../config'

/** Whether the browser promised not to evict this computer's data. */
export let storagePersisted: boolean | null = null

export async function bootLocal(): Promise<void> {
  await openDb()
  await initLocalMeta()
  await initLocalImages()
  // Ask the browser not to evict this origin's data under storage pressure.
  try {
    storagePersisted = (await navigator.storage?.persist?.()) ?? null
  } catch {
    // not supported - data is still kept unless the user clears it
  }
  // Another window of the app changed the data: show it here too.
  onCommit((_tables, _outboxed, remote) => {
    if (remote) void queryClient.invalidateQueries()
  })
  if (localMeta().provisioned) {
    try {
      localStorage.setItem(DEVICE_MARKER_KEY, 'local')
    } catch {
      // storage blocked
    }
    startSync()
  }
}
