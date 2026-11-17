import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { exportBackup, importBackup } from '../../lib/local/backup'
import { restoreFromCloud, useSyncStatus } from '../../lib/local/sync'
import { useLocalMeta } from '../../lib/local/state'

/** Settings → Backup (shop PC only): export / import / restore-from-cloud. */
export function BackupPanel() {
  const { t } = useI18n()
  const s = useSyncStatus()
  const meta = useLocalMeta()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const doExport = () =>
    run('export', async () => {
      const { blob, filename } = await exportBackup()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setMsg({ ok: true, text: t('Backup file saved.') })
    })

  const doImport = (file: File | undefined) => {
    if (!file) return
    if (!confirm(t('Replace ALL data on this computer with this backup file? This cannot be undone.'))) return
    void run('import', async () => {
      await importBackup(file)
      window.location.reload()
    })
  }

  const doRestore = () => {
    if (!confirm(t('Replace the data on this computer with the cloud copy?'))) return
    void run('restore', async () => {
      await restoreFromCloud()
      setMsg({ ok: true, text: t('Restored from the cloud.') })
    })
  }

  const btn = 'rounded-lg border border-line px-4 py-2 text-sm font-semibold text-brand-dark hover:bg-surface disabled:opacity-50'

  return (
    <div className="mt-8 rounded-xl bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-lg font-semibold text-brand-dark">{t('Backup')}</h2>
      <p className="mb-4 text-sm text-muted">
        {t('The cloud keeps an automatic off-site copy. You can also save a backup file (keep it somewhere safe - it contains all customer data).')}
      </p>
      <div className="flex flex-wrap gap-2">
        <button onClick={doExport} disabled={!!busy} className={btn}>
          {busy === 'export' ? t('Saving…') : t('Export backup file')}
        </button>
        <label className={`${btn} cursor-pointer ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          {busy === 'import' ? t('Loading…') : t('Import backup file')}
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              doImport(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
        <button
          onClick={doRestore}
          disabled={!!busy || !s.online || s.pending > 0}
          title={s.pending > 0 ? t('Some changes have not been uploaded yet.') : undefined}
          className={btn}
        >
          {busy === 'restore' ? t('Loading…') : t('Restore from cloud')}
        </button>
      </div>
      <p className="mt-3 text-xs text-faint">
        {t('Last full download')}: {meta.lastPullAt ? new Date(meta.lastPullAt).toLocaleString() : '-'}
      </p>
      {msg && (
        <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning'}`}>
          {t(msg.text)}
        </p>
      )}
    </div>
  )
}
