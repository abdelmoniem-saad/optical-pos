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
      <SearchableSelect
        value=""
        onChange={() => {}}
        options={LENSES}
        {...props}
      />,
    )
  })
}

const input = () => container.querySelector('input') as HTMLInputElement
const shown = () =>
  Array.from(container.querySelectorAll('[role="option"]')).map((o) => o.textContent)

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
    expect(shown()).toEqual(['Progressive Standard'])
  })

  it('keeps focus in the input and marks itself expanded for assistive tech', () => {
    render()
    focus()
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(input().getAttribute('role')).toBe('combobox')
  })

  it('arrow + Enter commits the highlighted option', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    key('ArrowDown')
    key('ArrowDown')
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('Photochromic Blue')
  })

  it('wraps around at both ends of the list', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    key('ArrowDown')
    key('ArrowUp') // back past the top
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('Progressive Standard')
  })

  it('Enter with nothing highlighted commits the free text', () => {
    const onChange = vi.fn()
    render({ onChange })
    focus()
    type('Kodak P 8300')
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('Kodak P 8300')
  })

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

  it('blur after arrow-keying without typing still keeps the existing value', () => {
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
    key('ArrowDown')
    key('Enter')
    expect(shown()).toEqual([])
  })

  it('leaves Left/Right to the caller so row navigation still works', () => {
    // rxArrowNav owns horizontal movement across a prescription row; if the
    // select swallowed these, the cashier could no longer leave the field.
    const onPassthroughKey = vi.fn()
    render({ onPassthroughKey })
    focus()
    key('ArrowLeft')
    key('ArrowRight')
    expect(onPassthroughKey).toHaveBeenCalledTimes(2)
  })

  it('forwards ArrowDown when the popup is closed, so an empty field still navigates the row', () => {
    const onPassthroughKey = vi.fn()
    render({ value: 'x', onChange: () => {}, onPassthroughKey })
    // No focus: popup closed.
    key('ArrowDown')
    expect(onPassthroughKey).toHaveBeenCalledTimes(1)
  })

  it('does not swallow Enter on an untouched field', () => {
    const onPassthroughKey = vi.fn()
    render({ onPassthroughKey })
    focus() // opens the popup, but nothing typed and nothing highlighted
    key('Enter')
    expect(onPassthroughKey).toHaveBeenCalledTimes(1)
  })

  it('carries the row/column tags that rxArrowNav reads off the DOM', () => {
    render({ inputProps: { 'data-rxr': 2, 'data-rxc': 8 } })
    expect(input().dataset.rxr).toBe('2')
    expect(input().dataset.rxc).toBe('8')
  })
})
