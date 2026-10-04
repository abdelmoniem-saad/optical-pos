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
 * ENTER IS NEVER AMBIGUOUS. Every row visible in the list is something the
 * user can knowingly take with Enter, and the highlighted row always wins.
 * The list ends with a "your own text" row whenever the typed text is not an
 * exact catalogue entry, and that row is what gets highlighted - so Enter
 * commits the words the user actually typed.
 *
 * The earlier version highlighted the first FUZZY match instead, which meant
 * typing "progress" and pressing Enter silently saved "Progressive Standard".
 * Anything the user did not deliberately choose was being recorded as if they
 * had chosen it. Fuzzy matches are still listed, because they are how you
 * discover the catalogue, but taking one now requires an arrow or a click.
 *
 * FREE TEXT IS A FEATURE, NOT A FALLBACK. lens_info is a text column, not a
 * foreign key, and metadata.ts harvests values people TYPED into exams in
 * order to seed the catalogue - so entering something not in the list is
 * normal shop behaviour, not an error.
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
  // -1 means "nothing highlighted", which is what a merely focused field must
  // keep so Enter still passes through to the next control.
  const [active, setActive] = useState(-1)

  const listId = useId()
  const activeRef = useRef<HTMLDivElement>(null)

  const matches = filterOptions(options, query)
  const typed = query.trim()

  /** Index of the exact catalogue entry equal to what was typed, else -1. */
  function exactIndex(q: string): number {
    const t = q.trim()
    if (!t) return -1
    return filterOptions(options, q).findIndex(
      (o) => o.name.toLowerCase() === t.toLowerCase(),
    )
  }

  const exact = exactIndex(query)
  const showOwnText = typed !== '' && exact < 0
  // The "your own text" row always sits after the real matches.
  const ownIndex = showOwnText ? matches.length : -1
  const rowCount = matches.length + (showOwnText ? 1 : 0)

  /** Which row Enter should take, for a given query. */
  function defaultActive(q: string): number {
    const t = q.trim()
    if (!t) return -1
    const hit = exactIndex(q)
    if (hit >= 0) return hit // typing a real name in full: take that entry
    return filterOptions(options, q).length // otherwise: take "your own text"
  }

  // Derived rather than stored, so a stale index can never point past the end
  // of a list that just shrank under it.
  const highlighted = active >= 0 && active < rowCount ? active : -1

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

  function commitHighlighted() {
    if (highlighted === ownIndex) commit(typed)
    else if (highlighted >= 0 && highlighted < matches.length) {
      commit(matches[highlighted].name)
    }
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
      if (rowCount) {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => {
          const next = i + step
          if (next < 0) return rowCount - 1 // wrap up to the end
          if (next >= rowCount) return 0 // wrap down to the top
          return next
        })
      }
      return
    }

    // Enter commits only when the box holds something the user did not already
    // have, or when a row is highlighted. That keeps tabbing through an
    // untouched prescription moving the focus along, and it stops the
    // container-level enterMovesNext from swallowing Enter while committing.
    const edited = query !== value
    if (e.key === 'Enter' && open && (highlighted >= 0 || edited)) {
      e.preventDefault()
      e.stopPropagation()
      commitHighlighted()
      return
    }

    onPassthroughKey?.(e)
  }

  const rowClass = (isActive: boolean) =>
    `cursor-pointer px-3 py-1.5 text-xs leading-snug ${
      isActive ? 'bg-brand text-white' : 'text-ink hover:bg-faint'
    }`

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
          setActive(defaultActive(q))
        }}
        onFocus={() => {
          setQuery(value)
          setOpen(true)
          setActive(-1)
        }}
        // Leaving the field commits what is in the box. Must wrap in a
        // closure: passing `commit` directly hands it a FocusEvent, not the
        // text, and would write the event object into the value.
        onBlur={() => commit(query)}
        onKeyDown={onKeyDown}
        className={inputClassName}
      />

      {open && rowCount > 0 && (
        <div className="absolute z-50 mt-1 w-full min-w-[19rem] overflow-hidden rounded-xl border border-line bg-white shadow-lg">
          {/* Outside the scroll area so the position in the catalogue stays
              readable while the list itself scrolls past a long result. */}
          <div className="border-b border-line/40 px-3 py-1 text-[10px] font-semibold text-faint">
            {matches.length} of {options.length}
          </div>
          <div id={listId} role="listbox" className="max-h-72 overflow-auto py-1">
            {matches.map((o, i) => (
              <div
                key={o.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlighted}
                ref={i === highlighted ? activeRef : undefined}
                // Keeping focus on the input means onBlur does not fire before
                // the click lands, so a selection cannot be lost to a race.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(o.name)}
                className={rowClass(i === highlighted)}
              >
                {/* Whitespace-normal so a long name wraps in full rather than
                    being ellipsised by a fixed popup width. */}
                <span className="block whitespace-normal">{o.name}</span>
              </div>
            ))}

            {showOwnText && (
              <div
                id={`${listId}-${ownIndex}`}
                role="option"
                aria-selected={ownIndex === highlighted}
                ref={ownIndex === highlighted ? activeRef : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(typed)}
                className={`border-t border-dashed border-line ${rowClass(ownIndex === highlighted)}`}
              >
                <span className="block whitespace-normal">{typed}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
