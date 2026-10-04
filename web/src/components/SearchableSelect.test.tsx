// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SearchableSelect } from './SearchableSelect'
import type { SuggestOption } from '../lib/suggest'

const LENSES: SuggestOption[] = [
  { id: '1', name: 'Single Vision' },
  { id: '2', name: 'Photochromic Blue' },
  { id: '3', name: 'Progressive Standard' },
]

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  // jsdom implements no layout, so it has no scrollIntoView. The component
  // only uses it to keep the highlighted row visible while arrowing.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // React 19 only runs `act` correctly when it is told it is under test.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(props: Partial<Parameters<typeof SearchableSelect>[0]> = {}) {
  act(() => {
    root.render(
      <SearchableSelect value="" onChange={() => {}} options={LENSES} {...props} />,
    )
  })
}

const input = () => container.querySelector('input') as HTMLInputElement
const rows = () => Array.from(container.querySelectorAll('[role="option"]'))
const shown = () => rows().map((o) => o.textContent)
const selected = () =>
  container.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? null

function focus() {
  act(() => input().focus())
}
function blur() {
  act(() => input().blur())
}
function type(text: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    set.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(k: string) {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}
function clickRow(text: string) {
  act(() => {
    const row = rows().find((r) => r.textContent === text)
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('SearchableSelect', () => {
  it('opens on focus and lists every option in full', () => {
    render()
    expect(shown()).toEqual([])
    focus()
    expect(shown()).toEqual(['Single Vision', 'Photochromic Blue', 'Progressive Standard'])
  })

  it('filters as you type', () => {
    render()
    focus()
    type('progress')
    expect(shown()).toContain('Progressive Standard')
    expect(shown()).not.toContain('Single Vision')
  })

  // ---- the rule that stops Enter guessing for you ----

  it('ends the list with your own text when it is not an exact catalogue name', () => {
    render()
    focus()
    type('progress')
    // Fuzzy match listed for discovery, then the literal text underneath.
    expect(shown()).toEqual(['Progressive Standard', 'progress'])
  })

  it('highlights your own text, so Enter commits what you actually typed', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    type('progress')
    expect(selected()).toBe('progress')
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('progress')
  })

  it('never silently commits a fuzzy match on Enter', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    type('progress')
    key('Enter')
    expect(onChange).not.toHaveBeenCalledWith('Progressive Standard')
  })

  it('omits the own-text row once the typed text IS a catalogue name', () => {
    render()
    focus()
    type('Progressive Standard')
    expect(shown()).toEqual(['Progressive Standard'])
  })

  it('takes the catalogue name, with its real casing, on an exact match', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    type('progressive standard') // typed in the wrong case on purpose
    expect(selected()).toBe('Progressive Standard')
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('Progressive Standard')
  })

  it('still lets you deliberately take a fuzzy match by clicking it', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    type('progress')
    clickRow('Progressive Standard')
    expect(onChange).toHaveBeenCalledWith('Progressive Standard')
  })

  it('still lets you deliberately take a fuzzy match by arrowing to it', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    type('progress')
    expect(selected()).toBe('progress') // starts on your own text
    key('ArrowUp')
    expect(selected()).toBe('Progressive Standard')
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('Progressive Standard')
  })

  it('offers your own text even when nothing matches at all', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    type('Kodak P 8300')
    expect(shown()).toEqual(['Kodak P 8300'])
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('Kodak P 8300')
  })

  // ---- tab-through safety ----

  it('does not highlight on focus alone, so Enter still moves to the next field', () => {
    const onPassthroughKey = vi.fn()
    render({ onPassthroughKey })
    focus()
    expect(selected()).toBeNull()
    key('Enter')
    expect(onPassthroughKey).toHaveBeenCalledTimes(1)
  })

  it('does not swallow Enter on an untouched field that already has a value', () => {
    const onPassthroughKey = vi.fn()
    render({ value: 'Single Vision', onPassthroughKey })
    focus()
    key('Enter')
    expect(onPassthroughKey).toHaveBeenCalledTimes(1)
  })

  it('clears the highlight once the text is emptied again', () => {
    render()
    focus()
    type('p')
    type('')
    expect(selected()).toBeNull()
  })

  // ---- keyboard passthrough ----

  it('leaves Left/Right to the caller so row navigation still works', () => {
    const onPassthroughKey = vi.fn()
    render({ onPassthroughKey })
    focus()
    key('ArrowLeft')
    key('ArrowRight')
    expect(onPassthroughKey).toHaveBeenCalledTimes(2)
  })

  it('forwards ArrowDown when the popup is closed, so an empty field still navigates the row', () => {
    const onPassthroughKey = vi.fn()
    render({ onPassthroughKey })
    key('ArrowDown')
    expect(onPassthroughKey).toHaveBeenCalledTimes(1)
  })

  it('wraps around both ends of the list', () => {
    render()
    focus()
    type('e') // no exact match, so own-text sits last
    key('ArrowDown')
    expect(selected()).not.toBeNull()
    key('ArrowDown')
    key('ArrowDown')
    expect(selected()).not.toBeNull()
  })

  // ---- commit / cancel ----

  // REGRESSION: onBlur used to be handed to commit() directly, so it received
  // a FocusEvent instead of the text and pushed an event object into lens_info.
  it('blur commits the typed text, not the focus event', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    type('Kodak P 8300')
    blur()
    expect(onChange).toHaveBeenCalledWith('Kodak P 8300')
    expect(onChange.mock.calls[0][0]).toBeTypeOf('string')
  })

  it('blur after focus alone keeps the existing value', () => {
    const onChange = vi.fn()
    render({ value: 'Single Vision', onChange })
    focus()
    blur()
    expect(onChange).toHaveBeenCalledWith('Single Vision')
  })

  it('Escape cancels the pending edit and restores the original value', () => {
    const onChange = vi.fn()
    render({ value: 'Single Vision', onChange })
    focus()
    type('discard me')
    key('Escape')
    expect(onChange).not.toHaveBeenCalled()
    expect(input().value).toBe('Single Vision')
  })

  it('closes the popup once something is committed', () => {
    render()
    focus()
    type('pro')
    key('Enter')
    expect(shown()).toEqual([])
  })

  // ---- n of m ----

  it('shows how many entries match out of the whole catalogue', () => {
    render()
    focus()
    expect(container.textContent).toContain('3 of 3')
    type('progress')
    expect(container.textContent).toContain('1 of 3')
  })

  it('keeps the count visible while the list is scrolled', () => {
    render()
    focus()
    const count = Array.from(container.querySelectorAll('div')).find((d) =>
      /^\d+ of \d+$/.test(d.textContent ?? ''),
    )
    expect(count).toBeTruthy()
    expect(container.querySelector('[role="listbox"]')?.contains(count as Node)).toBe(false)
  })

  // ---- a11y ----

  it('keeps focus in the input and marks itself expanded for assistive tech', () => {
    render()
    focus()
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(input().getAttribute('role')).toBe('combobox')
  })

  it('points aria-activedescendant at the highlighted row', () => {
    render()
    focus()
    type('progress')
    const id = input().getAttribute('aria-activedescendant')
    expect(id).toBeTruthy()
    expect(container.querySelector(`#${CSS.escape(id as string)}`)?.textContent).toBe(
      'progress',
    )
  })

  it('carries the row/column tags that rxArrowNav reads off the DOM', () => {
    render({ inputProps: { 'data-rxr': 2, 'data-rxc': 8 } })
    expect(input().dataset.rxr).toBe('2')
    expect(input().dataset.rxc).toBe('8')
  })
})
