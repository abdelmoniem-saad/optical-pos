import type { KeyboardEvent } from 'react'

/**
 * Excel-style arrow navigation across a WHOLE prescription row.
 * Attach to every field (selects, inputs) and tag them with `data-rxr` (row
 * index) and `data-rxc` (column index, in visual left-to-right order).
 *
 * Arrow keys only JUMP between fields while an input's value is fully
 * selected (the state right after Enter/Tab) or empty — i.e. when you're "on"
 * a field rather than inside it. Once you start editing, arrows move the
 * caret normally. Selects only navigate horizontally (Up/Down stays native
 * so it can open their dropdown).
 */
export function rxArrowNav(e: KeyboardEvent<HTMLElement>): void {
  const el = e.currentTarget
  const row = Number(el.dataset.rxr)
  const col = Number(el.dataset.rxc)
  if (Number.isNaN(row) || Number.isNaN(col)) return

  const isInput = el instanceof HTMLInputElement
  const empty = isInput && el.value.length === 0
  const fullySelected =
    isInput && !empty && el.selectionStart === 0 && el.selectionEnd === el.value.length

  const horizontal = e.key === 'ArrowRight' || e.key === 'ArrowLeft'
  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown'
  if (!horizontal && !vertical) return
  // Inside an input with the caret placed (editing), arrows stay native.
  if (isInput && !empty && !fullySelected) return
  // Selects: Up/Down opens their dropdown, so only Left/Right navigate.
  if (!isInput && vertical) return

  e.preventDefault()
  let r = row
  let c = col
  if (e.key === 'ArrowRight') c += 1
  else if (e.key === 'ArrowLeft') c -= 1
  else r += e.key === 'ArrowDown' ? 1 : -1

  const target = document.querySelector<HTMLElement>(
    `[data-rxr="${r}"][data-rxc="${c}"]`,
  )
  if (target) {
    target.focus()
    if (target instanceof HTMLInputElement) target.select()
  }
}

/**
 * Page-wide "Enter behaves like Tab" for POS forms.
 * Attach this to a container's onKeyDown (see CartStep / CustomerStep).
 * Pressing Enter inside any editable input focuses the NEXT visible editable
 * field (and selects its text), so the cashier can run through the entire page
 * from the keyboard - prescription numbers, doctor name and the payment
 * amounts alike. Previously only the prescription table had a row-local copy
 * of this behaviour.
 *
 * Deliberately NOT intercepted:
 * - buttons / links: Enter must still click them;
 * - <select>: Enter opens/closes its native dropdown;
 * - textareas: Enter inserts a newline;
 * - readonly / disabled / hidden / file inputs;
 * - anything marked `data-skip-enter` (quick-add keeps its dedicated
 *   "Enter adds the item" behaviour).
 */
export function enterMovesNext(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return

  const target = e.target
  if (!(target instanceof HTMLInputElement)) return
  if (target.disabled || target.readOnly) return
  const type = target.type
  if (type === 'hidden' || type === 'file' || type === 'button' || type === 'submit') return
  if (target.closest('[data-skip-enter]')) return

  e.preventDefault()

  const root = e.currentTarget
  const fields = Array.from(
    root.querySelectorAll<HTMLElement>('input, select, textarea'),
  ).filter((el) => {
    if (el.closest('[data-skip-enter]')) return false
    if (el instanceof HTMLTextAreaElement) return false
    if (el instanceof HTMLSelectElement) return !el.disabled
    if (!(el instanceof HTMLInputElement)) return false
    if (el.disabled || el.readOnly) return false
    const t = el.type
    if (t === 'hidden' || t === 'file' || t === 'button' || t === 'submit') return false
    // Skip elements hidden via CSS (offsetParent is null when not rendered).
    return el.offsetParent !== null
  })

  const idx = fields.indexOf(target)
  if (idx === -1) return
  for (let i = idx + 1; i < fields.length; i++) {
    const next = fields[i]
    if (!next) break
    next.focus()
    if (next instanceof HTMLInputElement) next.select()
    return
  }
}
