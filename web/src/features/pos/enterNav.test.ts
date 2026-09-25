// @vitest-environment jsdom
import type { KeyboardEvent } from 'react'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { enterMovesNext, rxArrowNav } from './enterNav'

// jsdom does no layout, so `offsetParent` is always null - which would make the
// "visible field" filter reject everything. Approximate it with the parent.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement
    },
  })
})

beforeEach(() => {
  document.body.innerHTML = ''
})

type FakeEvent = KeyboardEvent<HTMLElement> & { defaultPrevented: boolean }

function keyEvent(props: Record<string, unknown>): FakeEvent {
  const e = {
    key: 'Enter',
    nativeEvent: { isComposing: false },
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true
    },
  }
  Object.assign(e, props)
  return e as unknown as FakeEvent
}

function mount(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  document.body.appendChild(div)
  return div
}

function el<T extends Element>(root: HTMLElement, sel: string): T {
  const found = root.querySelector(sel)
  if (!found) throw new Error(`missing element: ${sel}`)
  return found as T
}

describe('enterMovesNext', () => {
  it('moves Enter to the next field and selects its text', () => {
    const root = mount('<input id="a"><input id="b" value="x">')
    const a = el<HTMLInputElement>(root, '#a')
    const b = el<HTMLInputElement>(root, '#b')
    const e = keyEvent({ target: a, currentTarget: root })
    enterMovesNext(e)
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(b)
    expect(b.selectionStart).toBe(0)
    expect(b.selectionEnd).toBe(1)
  })

  it('skips fields marked data-skip-enter', () => {
    const root = mount('<input id="a"><div data-skip-enter><input id="skip"></div><input id="c">')
    const e = keyEvent({ target: el<HTMLInputElement>(root, '#a'), currentTarget: root })
    enterMovesNext(e)
    expect(document.activeElement).toBe(el<HTMLInputElement>(root, '#c'))
  })

  it('leaves Enter alone inside a textarea (newline) or on a button', () => {
    const root = mount('<textarea id="ta"></textarea><button id="btn">go</button>')
    const ta = keyEvent({ target: el<HTMLTextAreaElement>(root, '#ta'), currentTarget: root })
    enterMovesNext(ta)
    expect(ta.defaultPrevented).toBe(false)
    const btn = keyEvent({ target: el<HTMLButtonElement>(root, '#btn'), currentTarget: root })
    enterMovesNext(btn)
    expect(btn.defaultPrevented).toBe(false)
  })

  it('skips readonly, disabled and hidden inputs', () => {
    const root = mount(
      '<input id="a"><input id="ro" readonly><input id="dis" disabled><input id="hid" type="hidden"><input id="last">',
    )
    const e = keyEvent({ target: el<HTMLInputElement>(root, '#a'), currentTarget: root })
    enterMovesNext(e)
    expect(document.activeElement).toBe(el<HTMLInputElement>(root, '#last'))
  })

  it('includes selects in the tab order', () => {
    const root = mount('<input id="a"><select id="s"><option>1</option></select><input id="z">')
    const e = keyEvent({ target: el<HTMLInputElement>(root, '#a'), currentTarget: root })
    enterMovesNext(e)
    expect(document.activeElement).toBe(el<HTMLSelectElement>(root, '#s'))
  })

  it('does nothing while an IME composition is active', () => {
    const root = mount('<input id="a"><input id="b">')
    const e = keyEvent({
      target: el<HTMLInputElement>(root, '#a'),
      currentTarget: root,
      nativeEvent: { isComposing: true },
    })
    enterMovesNext(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('rxArrowNav', () => {
  it('moves right from an empty field and selects the target', () => {
    const root = mount(
      '<input data-rxr="0" data-rxc="0"><input data-rxr="0" data-rxc="1" value="5">',
    )
    const a = el<HTMLInputElement>(root, '[data-rxc="0"]')
    const b = el<HTMLInputElement>(root, '[data-rxc="1"]')
    const e = keyEvent({ key: 'ArrowRight', target: a, currentTarget: a })
    rxArrowNav(e)
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(b)
    expect(b.selectionStart).toBe(0)
    expect(b.selectionEnd).toBe(1)
  })

  it('moves down from a fully selected field', () => {
    const root = mount(
      '<input data-rxr="0" data-rxc="0" value="123"><input data-rxr="1" data-rxc="0">',
    )
    const a = el<HTMLInputElement>(root, '[data-rxr="0"]')
    const below = el<HTMLInputElement>(root, '[data-rxr="1"]')
    a.focus()
    a.setSelectionRange(0, 3)
    expect(a.selectionStart).toBe(0)
    expect(a.selectionEnd).toBe(3)
    const e = keyEvent({ key: 'ArrowDown', target: a, currentTarget: a })
    rxArrowNav(e)
    expect(document.activeElement).toBe(below)
  })

  it('stays native while the caret is inside the value', () => {
    const root = mount(
      '<input data-rxr="0" data-rxc="0" value="123"><input data-rxr="0" data-rxc="1">',
    )
    const a = el<HTMLInputElement>(root, '[data-rxc="0"]')
    a.focus()
    a.setSelectionRange(1, 1)
    const e = keyEvent({ key: 'ArrowRight', target: a, currentTarget: a })
    rxArrowNav(e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('leaves Up/Down native on selects but navigates sideways', () => {
    const root = mount(
      '<select data-rxr="0" data-rxc="0"><option>1</option></select><input data-rxr="0" data-rxc="1">',
    )
    const s = el<HTMLSelectElement>(root, 'select')
    const down = keyEvent({ key: 'ArrowDown', target: s, currentTarget: s })
    rxArrowNav(down)
    expect(down.defaultPrevented).toBe(false)
    const right = keyEvent({ key: 'ArrowRight', target: s, currentTarget: s })
    rxArrowNav(right)
    expect(document.activeElement).toBe(el<HTMLInputElement>(root, 'input'))
  })

  it('ignores fields without rx row/column tags', () => {
    const root = mount('<input id="a"><input id="b">')
    const a = el<HTMLInputElement>(root, '#a')
    const e = keyEvent({ key: 'ArrowRight', target: a, currentTarget: a })
    rxArrowNav(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
