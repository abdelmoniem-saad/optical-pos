// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { POS_DRAFT_KEY, clearPosDraft, readPosDraft, writePosDraft } from './posDraft'

type Draft = { step: string; cartItems?: number[] }

beforeEach(() => {
  sessionStorage.clear()
})

describe('posDraft', () => {
  it('round-trips a draft for the same user and store', () => {
    writePosDraft<Draft>('u1', 's1', { step: 'cart', cartItems: [1, 2] })
    expect(readPosDraft<Draft>('u1', 's1')).toEqual({ step: 'cart', cartItems: [1, 2] })
  })

  it('ignores a draft written by another user', () => {
    writePosDraft<Draft>('u1', 's1', { step: 'cart' })
    expect(readPosDraft<Draft>('u2', 's1')).toBeNull()
  })

  it('ignores a draft written for another store', () => {
    writePosDraft<Draft>('u1', 's1', { step: 'cart' })
    expect(readPosDraft<Draft>('u1', 's2')).toBeNull()
  })

  it('returns null when nothing was stored or the payload is corrupt', () => {
    expect(readPosDraft<Draft>('u1', 's1')).toBeNull()
    sessionStorage.setItem(POS_DRAFT_KEY, '{not json')
    expect(readPosDraft<Draft>('u1', 's1')).toBeNull()
  })

  it('clears the draft', () => {
    writePosDraft<Draft>('u1', 's1', { step: 'cart' })
    clearPosDraft()
    expect(readPosDraft<Draft>('u1', 's1')).toBeNull()
  })
})
