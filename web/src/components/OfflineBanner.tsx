import { useSyncExternalStore } from 'react'
import { onlineManager } from '@tanstack/react-query'
import { useI18n } from '../i18n/LanguageContext'

/** Thin fixed strip shown only while the device is offline. Reads are served
 *  from the persisted Query cache, but a WRITE made here is not queued: it fails
 *  and the cashier is told to try again. The copy below says exactly that, and
 *  the distinction is the whole point of the component — an earlier version
 *  promised "Changes will sync when you reconnect", which was false: no write
 *  queue exists (migration 018 adds one for checkout, and this copy is updated
 *  with it). A banner that reassures staff about money it is about to drop is
 *  worse than no banner. */
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
      {t('Offline - showing saved data. New sales cannot be saved until you reconnect.')}
    </div>
  )
}
