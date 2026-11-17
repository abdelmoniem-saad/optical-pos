import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n/LanguageContext'
import { useLensTypes } from '../data/metadata'

/**
 * Modal picker for the lens type field: ALL options listed clearly, a search
 * field underneath (filters live), and an "add new" row when the typed name
 * doesn't exist yet. Rendered through a portal so it escapes the form's
 * page-wide Enter/arrow handlers.
 */
export function LensTypePicker({
  open,
  onClose,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  /** Pass '' to clear the field. */
  onSelect: (name: string) => void
}) {
  const { t } = useI18n()
  const lensTypes = useLensTypes()
  const [q, setQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      const id = setTimeout(() => searchRef.current?.focus(), 0)
      return () => clearTimeout(id)
    }
  }, [open])

  const ql = q.trim().toLowerCase()
  const options = useMemo(
    () => (lensTypes.data ?? []).filter((l) => l.name.toLowerCase().includes(ql)),
    [lensTypes.data, ql],
  )
  const exactExists = (lensTypes.data ?? []).some(
    (l) => l.name.toLowerCase() === ql,
  )
  const canAdd = q.trim().length > 0 && !exactExists

  /** What Enter in the search selects: exact match, first visible, or add-new. */
  function chooseDefault(): string | null {
    if (canAdd) return q.trim()
    const exact = (lensTypes.data ?? []).find((l) => l.name.toLowerCase() === ql)
    if (exact) return exact.name
    return options[0]?.name ?? null
  }

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-sm font-semibold text-brand-dark">{t('Lens Type')}</div>

        {/* ALL options, clearly listed */}
        <div className="max-h-56 overflow-auto rounded-lg border border-line">
          {(lensTypes.data ?? []).length === 0 && (
            <p className="p-3 text-sm text-faint">{t('No entries yet.')}</p>
          )}
          {(lensTypes.data ?? []).map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => pick(l.name)}
              className={`block w-full px-3 py-2 text-start text-sm hover:bg-brand-bg ${
                ql && l.name.toLowerCase() === ql ? 'bg-brand-bg/60 font-semibold' : ''
              }`}
            >
              {l.name}
            </button>
          ))}
        </div>

        {/* search field underneath - filters the list live */}
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              const choice = chooseDefault()
              if (choice !== null) pick(choice)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
          placeholder={`${t('Search')}...`}
          className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
        />

        {canAdd && (
          <button
            type="button"
            onClick={() => pick(q.trim())}
            className="mt-2 w-full rounded-lg bg-brand-bg px-3 py-2 text-start text-sm font-semibold text-brand-dark hover:opacity-90"
          >
            + {t('Add')} "{q.trim()}"
          </button>
        )}

        <button
          type="button"
          onClick={() => pick('')}
          className="mt-2 w-full rounded-lg border border-line py-2 text-xs text-muted hover:bg-surface"
        >
          {t('None')}
        </button>
      </div>
    </div>,
    document.body,
  )

  function pick(name: string) {
    onSelect(name)
  }
}