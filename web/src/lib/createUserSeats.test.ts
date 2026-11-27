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
