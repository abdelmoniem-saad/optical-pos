// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// permissions.tsx imports the Supabase client (plus auth/queryClient around it)
// at module load; these pure helpers need none of that, and the real client
// throws without VITE_SUPABASE_* env vars.
vi.mock('../lib/supabase', () => ({ supabase: {} }))

import {
  ACTIONS,
  ALL_CODES,
  RESOURCES,
  code,
  isBypassRoleName,
  isSuperUsername,
  resolveCan,
} from './permissions'

describe('permission universe', () => {
  it('builds one code per resource/action pair', () => {
    expect(code('pos', 'view')).toBe('pos.view')
    expect(ALL_CODES).toContain('settings.delete')
    expect(ALL_CODES).toHaveLength(RESOURCES.length * ACTIONS.length)
  })

  it('keeps the sidebar order: New Sale first, Settings last', () => {
    expect(RESOURCES[0].key).toBe('pos')
    expect(RESOURCES[RESOURCES.length - 1].key).toBe('settings')
  })
})

describe('isSuperUsername', () => {
  it('recognizes the reserved break-glass account regardless of case/whitespace', () => {
    expect(isSuperUsername('superadmin')).toBe(true)
    expect(isSuperUsername('  SUPERADMIN ')).toBe(true)
    expect(isSuperUsername('superadmin2')).toBe(false)
    expect(isSuperUsername(null)).toBe(false)
  })
})

describe('isBypassRoleName', () => {
  it('treats admin and owner positions as full access', () => {
    expect(isBypassRoleName('Admin')).toBe(true)
    expect(isBypassRoleName('OWNER')).toBe(true)
    expect(isBypassRoleName('Seller')).toBe(false)
    expect(isBypassRoleName(undefined)).toBe(false)
  })
})

describe('resolveCan', () => {
  const granted = new Set(['history.view'])

  it('falls back to exactly what the position grants', () => {
    expect(resolveCan(granted, {}, 'history.view')).toBe(true)
    expect(resolveCan(granted, {}, 'history.edit')).toBe(false)
  })

  it('lets an explicit allow override a missing position grant', () => {
    expect(resolveCan(granted, { 'history.edit': true }, 'history.edit')).toBe(true)
  })

  it('lets an explicit deny override a position grant', () => {
    expect(resolveCan(granted, { 'history.view': false }, 'history.view')).toBe(false)
  })
})
