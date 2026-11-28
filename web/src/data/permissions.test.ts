// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// permissions.tsx imports the Supabase client (plus auth/queryClient around it)
// at module load; these pure helpers need none of that, and the real client
// throws without VITE_SUPABASE_* env vars.
vi.mock('../lib/supabase', () => ({ supabase: {} }))

import {
  ALL_CODES,
  RESOURCES,
  code,
  isBypassRoleName,
  isSuperUsername,
  resolveCan,
  readEffectiveAccess,
  accessAllows,
  readOnlyAllows,
} from './permissionModel'

describe('permission universe', () => {
  it('builds one code per resource/action pair', () => {
    expect(code('pos', 'view')).toBe('pos.view')
    expect(ALL_CODES).not.toContain('settings.delete')
    expect(ALL_CODES).toContain('history.refund')
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length)
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

  it('blocks actions when view is removed, without erasing the action grant', () => {
    const grants = new Set(['history.view', 'history.edit'])
    expect(resolveCan(grants, { 'history.view': false }, 'history.edit')).toBe(false)
    expect(resolveCan(grants, {}, 'history.edit')).toBe(true)
    expect(resolveCan(grants, { 'settings.delete': true }, 'settings.delete')).toBe(false)
  })

  it('rejects missing and malformed authority responses', () => {
    for (const value of [null, {}, { codes: ['history.edit'] }, { is_admin: 'false', active: true, assigned: true, codes: [] }]) {
      expect(() => readEffectiveAccess(value)).toThrow('Could not load permissions.')
    }
    expect(readEffectiveAccess({ is_admin: false, active: false, assigned: false, codes: [] }).active).toBe(false)
  })

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

describe('read-only access (033 register_only)', () => {
  const base = { is_admin: true, active: true, assigned: true, codes: ['pos.view', 'history.view', 'history.void'] }

  it('treats missing read_only / is_owner as false: a database before 033 is unchanged', () => {
    const v = readEffectiveAccess(base)
    expect(v.read_only).toBe(false)
    expect(v.is_owner).toBe(false)
    expect(v.is_admin).toBe(true)
    expect(v.codes).toEqual(base.codes)
  })

  it('reads read_only and is_owner when 033 sends them', () => {
    const v = readEffectiveAccess({ ...base, is_admin: false, read_only: true, is_owner: true })
    expect(v.read_only).toBe(true)
    expect(v.is_owner).toBe(true)
  })

  it('never reads a non-boolean flag as true', () => {
    const v = readEffectiveAccess({ ...base, read_only: 'true', is_owner: 1 })
    expect(v.read_only).toBe(false)
    expect(v.is_owner).toBe(false)
  })

  it('narrows every code to viewing when read_only, and hides the POS', () => {
    const ro = { codes: base.codes, read_only: true }
    expect(accessAllows(ro, 'history.view')).toBe(true)
    expect(accessAllows(ro, 'history.void')).toBe(false)
    expect(accessAllows(ro, 'pos.view')).toBe(false)
    expect(accessAllows(ro, 'customers.view')).toBe(false) // never granted
    expect(readOnlyAllows('settings.edit')).toBe(false)
  })

  it('answers exactly the granted codes otherwise, including a cached answer with no flag', () => {
    for (const v of [{ codes: base.codes, read_only: false }, { codes: base.codes }]) {
      expect(accessAllows(v, 'history.void')).toBe(true)
      expect(accessAllows(v, 'pos.view')).toBe(true)
      expect(accessAllows(v, 'settings.edit')).toBe(false)
    }
  })
})
