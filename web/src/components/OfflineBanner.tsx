import { useSyncExternalStore } from 'react'
import { onlineManager } from '@tanstack/react-query'
import { useI18n } from '../i18n/LanguageContext'
import { IS_LOCAL } from '../lib/config'
import { useSyncStatus } from '../lib/local/sync'

/** Thin fixed strip shown only while the device is offline. Reads are served
 *  from the persisted Query cache; writes pause and resume on reconnect. */
export function OfflineBanner() {
  // Shop PC: offline is normal - a calm in-page strip (LocalOfflineStrip,
  // rendered by the app shell) instead of an overlay.
  return IS_LOCAL ? null : <CloudOfflineBanner />
}

function CloudOfflineBanner() {
  const { t } = useI18n()
  const online = useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
    () => true,
  )
  if (online) return null
  return (
    <div className="fixed inset-x-0 top-0 z-[60] bg-warning px-4 py-1.5 text-center text-sm font-medium text-white shadow">
      {t('Offline - showing cached data. Changes will sync when you reconnect.')}
    </div>
  )
}

/** Shop PC: offline is a normal state - say so calmly, with the queue size. */
export function LocalOfflineStrip() {
  const { t } = useI18n()
  const s = useSyncStatus()
  if (s.online) return null
  const waiting = s.pending + s.pendingImages
  return (
    <div className="bg-muted px-4 py-1 text-center text-xs font-medium text-white">
      {t('Offline - everything keeps working on this computer.')}
      {waiting > 0 && ` ${waiting} ${t('changes will upload when the internet is back.')}`}
    </div>
  )
}
