import { useSyncExternalStore } from 'react'
import { useI18n } from '../i18n/LanguageContext'
import { dismissJournalEntry, readJournal, subscribeJournal } from '../lib/checkoutJournal'
import { checkoutErrorMessage } from '../features/pos/checkoutErrors'

/** Sales the cashier was told were "Saved on this device" that never reached
 *  the shop: the server refused the replay, or the held queue was thrown away
 *  (sign-out, or held longer than the cache keeps it). Shown on every screen
 *  until dismissed, because the wizard that rang the sale up may be long gone.
 *  Still-queued sales are not listed: they are on their way. */
export function CheckoutJournalBanner() {
  const { t } = useI18n()
  const entries = useSyncExternalStore(subscribeJournal, () => readJournal(), () => [])
  const problems = entries.filter((e) => e.status !== 'queued')
  if (!problems.length) return null
  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] space-y-1 p-2">
      {problems.map((e) => (
        <div
          key={e.key}
          role="alert"
          className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 rounded-lg bg-danger px-3 py-2 text-sm text-white shadow-lg"
        >
          <span>
            <b>{t('A sale held on this device was NOT saved. Enter it again.')}</b>{' '}
            {e.invoiceNo ? `#${e.invoiceNo} · ` : ''}
            {e.net != null ? `${Number(e.net).toFixed(2)} · ` : ''}
            {new Date(e.at).toLocaleString()}
            {' - '}
            {e.status === 'failed'
              ? checkoutErrorMessage({ message: e.message }, t)
              : t('The held sale was discarded before it could sync (signed out, or held too long).')}
          </span>
          <button
            type="button"
            onClick={() => dismissJournalEntry(e.key)}
            className="rounded border border-white/60 px-2 py-0.5 text-xs hover:bg-white/10"
          >
            {t('Dismiss')}
          </button>
        </div>
      ))}
    </div>
  )
}
