import { useSyncExternalStore } from 'react'
import { onlineManager } from '@tanstack/react-query'
import { useI18n } from '../i18n/LanguageContext'

/** Thin fixed strip shown only while the device is offline. Reads are served
 *  from the persisted Query cache; writes pause and resume on reconnect. */
export function OfflineBanner() {
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
