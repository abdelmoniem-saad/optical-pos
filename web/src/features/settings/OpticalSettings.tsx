import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import {
  useAddMetadata,
  useDeleteMetadata,
  useFrameColors,
  useLensTypes,
  type NamedRow,
} from '../../data/metadata'

function MetaList({
  title,
  table,
  rows,
}: {
  title: string
  table: string
  rows: NamedRow[]
}) {
  const { t } = useI18n()
  const add = useAddMetadata(table)
  const del = useDeleteMetadata(table)
  const [name, setName] = useState('')

  async function submit() {
    const v = name.trim()
    if (!v) return
    await add.mutateAsync(v)
    setName('')
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <h3 className="mb-2 font-semibold text-brand-dark">{title}</h3>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {rows.length === 0 && <span className="text-sm text-faint">—</span>}
        {rows.map((r) => (
          <span key={r.id} className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-sm">
            {r.name}
            <button
              onClick={() => del.mutate(r.id)}
              className="text-faint hover:text-danger"
              title={t('Delete')}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={t('Add')}
          className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button
          onClick={submit}
          disabled={add.isPending}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {t('Add')}
        </button>
      </div>
    </div>
  )
}

export function OpticalSettings() {
  const { t } = useI18n()
  const lens = useLensTypes()
  const colors = useFrameColors()

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold text-brand-dark">{t('Optical Settings')}</h2>
      {/* Frame Types removed — nothing in the app reads that list anymore. */}
      <p className="mb-4 text-sm text-muted">{t('Lens types and colors used in prescriptions.')}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetaList title={t('Lens Types')} table="lens_types" rows={lens.data ?? []} />
        <MetaList title={t('Frame Colors')} table="frame_colors" rows={colors.data ?? []} />
      </div>
    </div>
  )
}
