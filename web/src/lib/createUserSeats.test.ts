import { describe, expect, it } from 'vitest'
// The seat count runs inside the Deno Edge Function (index.ts), which vitest
// cannot execute; its decision (authz.ts) is tested in createUserAuthz.test.ts
// from the count it is given. This pins the one fact the count itself must
// get right, by reading the deployed source.
import source from '../../../supabase/functions/create-user/index.ts?raw'

describe('create-user seat count (offline-v2 Phase 0b)', () => {
  const block = source.slice(source.indexOf("the plan's seat limit"), source.indexOf('authorizeCreateUser(caller'))

  it('counts the store\'s staff, and only the ACTIVE ones', () => {
    // A switched-off staff member must not hold a seat, or deactivating
    // someone could never make room for the person who replaces them.
    expect(block).toContain(".eq('store_id', storeId)")
    expect(block).toContain(".eq('is_active', true)")
  })
})

describe('create-user refuses a register_only store (offline-v2 Phase 1, 033)', () => {
  const check = source.indexOf("asCaller.rpc('store_is_register_only'")
  const precheck = source.indexOf('precheckCreateUser(caller, body)')
  const decide = source.indexOf('authorizeCreateUser(caller')
  const create = source.indexOf('admin.auth.admin.createUser')

  it('asks store_is_register_only as the caller, about the target store', () => {
    expect(check).toBeGreaterThan(-1)
    expect(source).toContain("asCaller.rpc('store_is_register_only', { p_store: target })")
    expect(source).toContain('const target = pre.storeId')
  })

  it('asks only after the permission checks, so their refusal is returned first', () => {
    // A cashier without staff.create must get its 403, not a 400 from a
    // store_is_register_only failure (EXECUTE missing, bad uuid, timeout).
    expect(precheck).toBeGreaterThan(-1)
    expect(precheck).toBeLessThan(check)
    const between = source.slice(precheck, check)
    expect(between).toContain('if (!pre.ok) return json({ error: pre.error }, pre.status)')
  })

  it('passes the answer to the decision, before any account is created', () => {
    expect(source).toContain('{ domain, plan, registerOnly }')
    expect(check).toBeLessThan(decide)
    expect(decide).toBeLessThan(create)
  })
})
