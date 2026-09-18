import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import {
  useAddMetadata,
  useDeleteMetadata,
  useFrameColors,
  useLensTypes,
  type NamedRow,
} from '../../data/metadata'

/** Best-effort swatch for common color names (unknown names get no dot). */
const COLOR_SWATCHES: Record<string, string> = {
  black: '#1a1a1a',
  gold: '#d4af37',
  silver: '#c0c0c0',
  brown: '#795548',
  white: '#ffffff',
  blue: '#1976d2',
  'dark blue': '#0d47a1',
  red: '#e53935',
  green: '#43a047',
  gray: '#9e9e9e',
  grey: '#9e9e9e',
  pink: '#f48fb1',
  purple: '#8e24aa',
  violet: '#7e57c2',
  transparent: '#eceff1',
  tortoise: '#8d6e63',
  beige: '#efebe9',
  yellow: '#fdd835',
  orange: '#fb8c00',
  clear: '#e0f7fa',
}

function swatchFor(name: string): string | undefined {
  return COLOR_SWATCHES[name.trim().toLowerCase()]
}

function MetaList({
  title,
  icon,
  table,
  rows,
  colored = false,
}: {
  title: string
  icon: string
  table: string
  rows: NamedRow[]
  colored?: boolean
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

  const err = add.error ?? del.error

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
      {/* header: icon + title + live count */}
      <div className="flex items-center justify-between border-b border-line/60 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-brand-dark">
          <span>{icon}</span>
          {title}
        </h3>
        <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-muted">
          {rows.length}
        </span>
      </div>

      {/* chips */}
      <div className="flex min-h-16 flex-wrap content-start items-start gap-1.5 p-3">
        {rows.length === 0 && (
          <span className="py-1 text-sm text-faint">{t('No entries yet.')}</span>
        )}
        {rows.map((r) => {
          const swatch = colored ? swatchFor(r.name) : undefined
          return (
            <span
              key={r.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-sm transition hover:border-line/80"
            >
              {swatch && (
                <span
                  className="h-3 w-3 shrink-0 rounded-full border border-line"
                  style={{ background: swatch }}
                />
              )}
              {r.name}
              <button
                onClick={() => del.mutate(r.id)}
                disabled={del.isPending}
                className="-me-1 text-faint transition hover:text-danger disabled:opacity-40"
                title={t('Delete')}
              >
                ✕
              </button>
            </span>
          )
        })}
      </div>

      {/* add row */}
      <div className="flex gap-2 border-t border-line/40 p-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={`${t('Add')}...`}
          className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button
          onClick={submit}
          disabled={add.isPending || !name.trim()}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {add.isPending ? '...' : t('Add')}
        </button>
      </div>

      {err && (
        <div className="border-t border-line/40 bg-warning-bg/50 px-3 py-2 text-xs text-warning">
          {String((err as Error).message ?? err)}
        </div>
      )}
    </div>
  )
}

export function OpticalSettings() {
  const { t } = useI18n()
  const lens = useLensTypes()
  const colors = useFrameColors()

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-brand-dark">{t('Optical Settings')}</h2>
      {/* Frame Types removed: nothing in the app reads that list anymore. */}
      <p className="mb-4 text-sm text-muted">{t('Lens types and colors used in prescriptions.')}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetaList title={t('Lens Types')} icon="👓" table="lens_types" rows={lens.data ?? []} />
        <MetaList
          title={t('Frame Colors')}
          icon="🎨"
          table="frame_colors"
          rows={colors.data ?? []}
          colored
        />
      </div>
    </div>
  )
}
