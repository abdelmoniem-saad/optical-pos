import { useI18n } from '../i18n/LanguageContext'
import { EXPECTED_SCHEMA_VERSION, useSchemaVersion } from '../lib/schemaVersion'

/** Persistent strip shown when the database is behind this build.
 *
 *  Migrations are applied by hand, so a shop can be running a new build against
 *  an old database. Until 017 existed the app could only discover that by
 *  catching a failed RPC, and its three recovery paths were silent - a cashier
 *  could be handed an invented invoice number with no indication anything was
 *  wrong. This states the fact up front, once, and says which file to run.
 *
 *  Sits under the OfflineBanner (z-50) so an offline device shows the offline
 *  reason first; the schema notice is not actionable while offline anyway. */
export function SchemaBanner() {
  const { t } = useI18n()
  const { data } = useSchemaVersion()

  // 'unknown' renders nothing on purpose - see useSchemaVersion.
  if (data?.state !== 'behind') return null

  return (
    <div className="fixed inset-x-0 top-0 z-50 bg-danger px-4 py-1.5 text-center text-sm font-medium text-white shadow">
      {t('This app needs a database update. Ask your administrator to run the latest migration file.')}
      <span className="ms-2 opacity-80">
        {t('Expected')}: {EXPECTED_SCHEMA_VERSION} · {t('installed')}: {data.version}
      </span>
    </div>
  )
}
