import { useMemo, useRef, useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import {
  useAddMetadata,
  useDeleteMetadata,
  useFrameColors,
  useLensTypes,
  useReorderMetadata,
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
  const reorder = useReorderMetadata(table)
  const [name, setName] = useState('')
  // 'custom' = the persistent order (drag-and-drop); 'alpha' = display-only.
  const [view, setView] = useState<'custom' | 'alpha'>('custom')
  const dragId = useRef<string | null>(null)

  const rowsAlpha = useMemo(
    () => [...rows].sort((a, b) => a.name.localeCompare(b.name)),
    [rows],
  )
  const displayRows = view === 'alpha' ? rowsAlpha : rows

  async function submit() {
    const v = name.trim()
    if (!v) return
    // In custom view a new entry goes LAST.
    const nextOrder =
      view === 'custom'
        ? Math.max(rows.length, ...rows.map((r) => r.sort_order ?? 0)) + 1
        : undefined
    await add.mutateAsync({ name: v, sortOrder: nextOrder })
    setName('')
  }

  function dropOn(targetId: string) {
    const from = rows.findIndex((r) => r.id === dragId.current)
    const to = rows.findIndex((r) => r.id === targetId)
    dragId.current = null
    if (from === -1 || to === -1 || from === to) return
    const next = [...rows]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    reorder.mutate(next.map((r) => r.id))
  }

  const err = add.error ?? del.error ?? reorder.error

  const toggleCls = (active: boolean) =>
    `rounded-md px-2 py-1 text-xs font-semibold transition ${
      active ? 'bg-brand text-white' : 'text-muted hover:bg-surface'
    }`

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
      {/* header: icon + title + count + view toggle */}
      <div className="flex items-center justify-between border-b border-line/60 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-brand-dark">
          <span>{icon}</span>
          {title}
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-line">
            <button
              type="button"
              onClick={() => setView('custom')}
              title={t('Custom order')}
              className={toggleCls(view === 'custom')}
            >
              ⇅
            </button>
            <button
              type="button"
              onClick={() => setView('alpha')}
              title={t('Alphabetical')}
              className={toggleCls(view === 'alpha')}
            >
              A-Z
            </button>
          </div>
          <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-muted">
            {rows.length}
          </span>
        </div>
      </div>

      {/* rows: each entry on its own line */}
      <div className="divide-y divide-line/40">
        {displayRows.length === 0 && (
          <p className="p-3 text-sm text-faint">{t('No entries yet.')}</p>
        )}
        {displayRows.map((r) => {
          const swatch = colored ? swatchFor(r.name) : undefined
          return (
            <div
              key={r.id}
              draggable={view === 'custom'}
              onDragStart={() => (dragId.current = r.id)}
              onDragOver={(e) => view === 'custom' && e.preventDefault()}
              onDrop={() => view === 'custom' && dropOn(r.id)}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm transition hover:bg-surface/60 ${
                view === 'custom' ? 'cursor-grab active:cursor-grabbing' : ''
              }`}
            >
              {view === 'custom' && (
                <span className="text-faint select-none" title={t('Custom order')}>
                  ⠆
                </span>
              )}
              {swatch && (
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-full border border-line"
                  style={{ background: swatch }}
                />
              )}
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <button
                onClick={() => del.mutate(r.id)}
                disabled={del.isPending}
                className="text-faint transition hover:text-danger disabled:opacity-40"
                title={t('Delete')}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>


      {/* add row: min-w-0 + shrink-0 so the button is never cropped */}
      <div className="flex flex-wrap gap-2 border-t border-line/40 p-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={`${t('Add')}...`}
          className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button
          onClick={submit}
          disabled={add.isPending || !name.trim()}
          className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
      <div className="grid grid-cols-1 gap-4">
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
