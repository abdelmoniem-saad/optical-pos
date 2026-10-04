import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { filterOptions, type SuggestOption } from '../lib/suggest'

/**
 * A free-text input with a searchable popup of suggestions.
 *
 * Replaces <datalist>, which cannot be styled, searched, or keyboard-driven -
 * its popup is drawn by the OS, truncates entries to the input's width, and
 * behaves differently on every machine. This one opens under the field, shows
 * full names, and filters as you type.
 *
 * FREE TEXT IS A FEATURE, NOT A FALLBACK. lens_info is a text column, not a
 * foreign key, and metadata.ts harvests lens types people TYPED into exams to
 * seed the catalogue - so entering something that is not in the list is normal
 * shop behaviour, not an error. Committing a suggestion is opt-in via Enter or
 * a click; committing whatever is in the box is always available.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  inputClassName = '',
  /** Called for every key this component does not itself consume - see the
   *  keyboard contract below. Prescription rows pass rxArrowNav here. */
  onPassthroughKey,
  ariaLabel,
  inputProps,
}: {
  value: string
  onChange: (next: string) => void
  options: readonly SuggestOption[]
  placeholder?: string
  inputClassName?: string
  onPassthroughKey?: (e: KeyboardEvent<HTMLInputElement>) => void
  ariaLabel?: string
  /** Spread onto the input. Carries the data-rxr / data-rxc tags that
   *  rxArrowNav reads off the DOM to locate this cell in the row. */
  inputProps?: Record<string, string | number>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  // -1 means "nothing highlighted yet", which is meaningfully different from 0:
  // it is why Enter still moves to the next field on a freshly focused box.
  const [active, setActive] = useState(-1)

  const listId = useId()
  const activeRef = useRef<HTMLDivElement>(null)

  const matches = filterOptions(options, query)

  // Derived rather than stored, so a stale index can never point past the end
  // of a list that just shrank under it.
  const highlighted = active >= 0 && active < matches.length ? active : -1

  // Bring the highlighted row into view, or arrow keys would wander past the
  // edge of the list on a long catalogue with no feedback that they had.
  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, open])

  function commit(text: string) {
    onChange(text)
    setQuery(text)
    setOpen(false)
    setActive(-1)
  }

  function cancel() {
    setQuery(value)
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && open) {
      cancel()
      e.preventDefault()
      return
    }

    // Only a VERTICAL arrow moves the highlight. Left/Right belong to the
    // prescription row's Excel-style navigation and must reach it untouched.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) {
      if (matches.length) {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => {
          const next = i + step
          if (next < 0) return matches.length - 1 // wrap up to the end
          if (next >= matches.length) return 0 // wrap down to the top
          return next
        })
      }
      return
    }

    // Enter only commits when there is something to commit, so tabbing past an
    // untouched box behaves exactly as it did before this component existed.
    // Swallowing it here also stops the container-level enterMovesNext, which
    // would otherwise move to the next field and drop the pending text.
    if (e.key === 'Enter' && open && (highlighted >= 0 || query.trim() !== '')) {
      e.preventDefault()
      e.stopPropagation()
      commit(highlighted >= 0 ? matches[highlighted].name : query)
      return
    }

    onPassthroughKey?.(e)
  }

  return (
    <div className="relative">
      <input
        value={query}
        placeholder={placeholder}
        aria-label={ariaLabel}
        {...inputProps}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
        onChange={(e) => {
          const q = e.target.value
          setQuery(q)
          setOpen(true)
          // Preselect the first match, so a large catalogue is reachable by
          // typing a few letters and pressing Enter instead of arrowing.
          // Only once there is something to search for: highlighting a merely
          // focused empty field would make Enter commit the first entry as the
          // cashier tabs down the prescription.
          setActive(q.trim() ? 0 : -1)
        }}
        onFocus={() => {
          setQuery(value)
          setOpen(true)
        }}
        // Leaving the field commits what is in the box. Must wrap in a
        // closure: passing `commit` directly hands it a FocusEvent, not the
        // text, and would write the event object into the value.
        onBlur={() => commit(query)}
        onKeyDown={onKeyDown}
        className={inputClassName}
      />

      {open && matches.length > 0 && (
        <div className="absolute z-50 mt-1 w-full min-w-[19rem] overflow-hidden rounded-xl border border-line bg-white shadow-lg">
          {/* Outside the scroll area so the position in the catalogue stays
              readable while the list itself scrolls past a long result. */}
          <div className="border-b border-line/40 px-3 py-1 text-[10px] font-semibold text-faint">
            {matches.length} of {options.length}
          </div>
          <div
            id={listId}
            role="listbox"
            className="max-h-72 overflow-auto py-1"
          >
            {matches.map((o, i) => (
              <div
                key={o.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlighted}
                ref={i === highlighted ? activeRef : undefined}
                // Keeping focus on the input means onBlur does not fire before the
                // click lands, so a selection cannot be lost to a race.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(o.name)}
                className={`cursor-pointer px-3 py-1.5 text-xs leading-snug ${
                  i === highlighted ? 'bg-brand text-white' : 'text-ink hover:bg-faint'
                }`}
              >
                {/* Whitespace-normal so a long lens name wraps in full rather than
                    being ellipsised by a fixed popup width. */}
                <span className="block whitespace-normal">{o.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
