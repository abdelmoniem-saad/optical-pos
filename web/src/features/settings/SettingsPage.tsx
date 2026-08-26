import { useEffect, useState } from 'react'
import { useSettings, useSetSetting } from '../../data/settings'
import { useI18n } from '../../i18n/LanguageContext'
import { OpticalSettings } from './OpticalSettings'
import { usePermissions } from '../../data/permissions'

const FIELDS: { key: string; label: string; multiline?: boolean }[] = [
  { key: 'shop_name', label: 'Shop Name' },
  { key: 'store_address', label: 'Address', multiline: true },
  { key: 'store_phone', label: 'Phone' },
  { key: 'currency', label: 'Currency' },
]

export function SettingsPage() {
  const { t } = useI18n()
  const settings = useSettings()
  const setSetting = useSetSetting()
  const perms = usePermissions()
  const canEdit = perms.isAdmin || perms.can('settings.edit' as never)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (settings.data) setForm(settings.data)
  }, [settings.data])

  async function save() {
    setSaved(false)
    for (const f of FIELDS) {
      await setSetting.mutateAsync({ key: f.key, value: form[f.key] ?? '' })
    }
    setSaved(true)
  }

  const cls = 'w-full rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand'

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">{t('Settings')}</h1>
      <p className="mb-5 text-sm text-muted">{t('Shop information shown on receipts.')}</p>

      {settings.isLoading && <p className="text-sm text-muted">{t('Loading…')}</p>}

      <div className="space-y-4 rounded-xl bg-white p-5 shadow-sm">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1 block text-sm font-medium text-muted">{t(f.label)}</span>
            {f.multiline ? (
              <textarea
                className={cls}
                rows={2}
                value={form[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            ) : (
              <input
                className={cls}
                value={form[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            )}
          </label>
        ))}

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={setSetting.isPending || !canEdit}
            title={canEdit ? undefined : t('You do not have access to this page.')}
            className="rounded-lg bg-brand px-5 py-2.5 font-semibold text-white disabled:opacity-60"
          >
            {setSetting.isPending ? t('Saving…') : t('Save Settings')}
          </button>
          {saved && <span className="text-sm text-success">✓ {t('Saved')}</span>}
        </div>
      </div>

      <div className="mt-8">
        <OpticalSettings />
      </div>
    </div>
  )
}
