import { describe, expect, it } from 'vitest'
// The module lives beside the Edge Function, so the deploy bundles it with a
// same-directory import that always resolves. The TEST lives here because vitest
// only collects src/** - and importing it from here is what puts it inside
// 	sc -b, so these rules stay type-checked with the rest of the app.
import {
  REGISTER_ONLY_ERROR,
  authorizeCreateUser,
  precheckCreateUser,
  registerOnlyValue,
  rpcValue,
  targetStoreId,
  type CreateUserCaller,
} from '../../../supabase/functions/create-user/authz'

/** A store manager: may create staff and hand out positions, in their own store. */
const manager: CreateUserCaller = {
  uid: 'manager-uuid',
  isPlatformAdmin: false,
  canCreateStaff: true,
  canAssignRoles: true,
  storeId: 'store-a',
}

/** A cashier. May not create staff at all. */
const cashier: CreateUserCaller = {
  uid: 'cashier-uuid',
  isPlatformAdmin: false,
  canCreateStaff: false,
  canAssignRoles: false,
  storeId: 'store-a',
}

/** The vendor account: bypasses the store pin and the quota. */
const vendor: CreateUserCaller = {
  uid: 'vendor-uuid',
  isPlatformAdmin: true,
  canCreateStaff: false,
  canAssignRoles: false,
  storeId: null,
}

const req = { username: 'newperson', password: 'secret123' }
const opts = { domain: 'lensypos.local' }

describe('authorizeCreateUser', () => {
  it('unwraps false authority values instead of treating response envelopes as truthy', () => {
    expect(rpcValue({ data: false, error: null })).toBe(false)
    expect(() => rpcValue({ data: null, error: { message: 'denied' } })).toThrow('denied')
    expect(authorizeCreateUser(manager, { ...req, username: 'superadmin@other.test' }, opts).ok).toBe(false)
  })
  it('lets a manager create a login in their own store', () => {
    const d = authorizeCreateUser(manager, req, opts)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.email).toBe('newperson@lensypos.local')
    expect(d.storeId).toBe('store-a')
  })

  it('refuses a caller with no session', () => {
    const d = authorizeCreateUser({ ...manager, uid: null }, req, opts)
    expect(d).toMatchObject({ ok: false, status: 401 })
  })

  it('refuses a short password and a missing username', () => {
    expect(authorizeCreateUser(manager, { ...req, password: 'x'.repeat(5) }, opts)).toMatchObject({
      ok: false,
      status: 400,
    })
    expect(authorizeCreateUser(manager, { ...req, username: '  ' }, opts)).toMatchObject({
      ok: false,
      status: 400,
    })
  })

  // This is the escalation the audit found: a cashier minting themselves an
  // admin, in another shop, through a service-role function.
  it('refuses a cashier outright, even asking for admin in another store', () => {
    const d = authorizeCreateUser(
      cashier,
      { ...req, role_id: 'admin-role', store_id: 'store-b' },
      opts,
    )
    expect(d).toMatchObject({ ok: false, status: 403 })
    if (d.ok) return
    expect(d.error).toContain('staff.create')
  })

  it('pins the store to the caller and ignores a cross-store request', () => {
    const same = authorizeCreateUser(manager, { ...req, store_id: 'store-a' }, opts)
    expect(same.ok && same.storeId).toBe('store-a')

    // store-b is refused, and the message deliberately does not confirm that a
    // store called store-b exists.
    const other = authorizeCreateUser(manager, { ...req, store_id: 'store-b' }, opts)
    expect(other).toMatchObject({ ok: false, status: 403 })
    if (other.ok) return
    expect(other.error).not.toContain('store-b')
  })

  it('refuses a manager whose account is not linked to any store', () => {
    const d = authorizeCreateUser({ ...manager, storeId: null }, req, opts)
    expect(d).toMatchObject({ ok: false, status: 403 })
    if (d.ok) return
    expect(d.error).toContain('no store for the signed-in user')
  })

  it('needs staff.edit to hand out a position, and drops it otherwise', () => {
    const noRoles = authorizeCreateUser(
      { ...manager, canAssignRoles: false },
      { ...req, role_id: 'seller-role' },
      opts,
    )
    expect(noRoles).toMatchObject({ ok: false, status: 403 })

    const withRole = authorizeCreateUser(manager, { ...req, role_id: 'seller-role' }, opts)
    expect(withRole.ok && withRole.roleId).toBe('seller-role')
  })

  it('a manager who may create staff but not assign roles still gets a login, without the role', () => {
    // Denying the whole request would leave them unable to onboard anyone.
    const d = authorizeCreateUser(
      { ...manager, canAssignRoles: false },
      { ...req, role_id: 'seller-role' },
      opts,
    )
    // either refused outright or created unroled - never created WITH the role
    if (d.ok) {
      expect(d.roleGranted).toBe(false)
      expect(d.roleId).toBeNull()
    } else {
      expect(d.status).toBe(403)
    }
  })

  it('enforces the plan seat limit so it cannot be raced', () => {
    const atLimit = authorizeCreateUser(manager, req, {
      ...opts,
      plan: { maxStaff: 5, currentStaff: 5 },
    })
    expect(atLimit).toMatchObject({ ok: false, status: 403 })
    if (atLimit.ok) return
    expect(atLimit.error).toContain('5/5')

    const oneSeatLeft = authorizeCreateUser(manager, req, {
      ...opts,
      plan: { maxStaff: 5, currentStaff: 4 },
    })
    expect(oneSeatLeft.ok).toBe(true)
  })

  it('treats a NULL maxStaff as unlimited', () => {
    const d = authorizeCreateUser(manager, req, {
      ...opts,
      plan: { maxStaff: null, currentStaff: 99 },
    })
    expect(d.ok).toBe(true)
  })

  it('lets a vendor create in any store, bypass role limits and the quota', () => {
    const d = authorizeCreateUser(
      vendor,
      { ...req, store_id: 'store-b', role_id: 'admin-role' },
      { ...opts, plan: { maxStaff: 1, currentStaff: 10 } },
    )
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.storeId).toBe('store-b')
    expect(d.roleId).toBe('admin-role')
  })

  it('a vendor with no store named still needs somewhere to put the account', () => {
    const d = authorizeCreateUser(vendor, req, opts)
    expect(d).toMatchObject({ ok: false, status: 403 })
  })

  it('accepts a full email address as the username', () => {
    const d = authorizeCreateUser(manager, { ...req, username: 'a@b.com' }, opts)
    expect(d.ok && d.email).toBe('a@b.com')
  })
})

describe('a store that records on its register PC (033 register_only)', () => {
  it('refuses with 409 "Add staff at the shop PC"', () => {
    const d = authorizeCreateUser(manager, req, { ...opts, registerOnly: true })
    expect(d).toEqual({ ok: false, status: 409, error: 'Add staff at the shop PC' })
    expect(REGISTER_ONLY_ERROR).toBe('Add staff at the shop PC')
  })

  it('refuses the vendor too: the PC is the only place staff are added', () => {
    const d = authorizeCreateUser(vendor, { ...req, store_id: 'store-b' }, { ...opts, registerOnly: true })
    expect(d).toMatchObject({ ok: false, status: 409 })
  })

  it('is decided before the seat limit and the role, so nothing is created', () => {
    const d = authorizeCreateUser(
      manager,
      { ...req, role_id: 'cashier-role' },
      { ...opts, registerOnly: true, plan: { maxStaff: 1, currentStaff: 1 } },
    )
    expect(d).toMatchObject({ ok: false, status: 409 })
  })

  it('does not tell a cashier anything new: permission is refused first', () => {
    expect(authorizeCreateUser(cashier, req, { ...opts, registerOnly: true })).toMatchObject({ ok: false, status: 403 })
  })

  it('is inert when the store is not register_only or the answer is absent', () => {
    expect(authorizeCreateUser(manager, req, { ...opts, registerOnly: false }).ok).toBe(true)
    expect(authorizeCreateUser(manager, req, opts).ok).toBe(true)
  })

  it('asks about the store the account would land in', () => {
    expect(targetStoreId(manager, { ...req, store_id: 'store-b' })).toBe('store-a')
    expect(targetStoreId(vendor, { ...req, store_id: ' store-b ' })).toBe('store-b')
    expect(targetStoreId(vendor, req)).toBeNull()
    expect(targetStoreId({ ...vendor, storeId: 'store-v' }, req)).toBe('store-v')
  })

  it('the precheck refuses before the store is asked about, and pins the store it asks about', () => {
    // index.ts calls store_is_register_only only when this says ok, so a
    // cashier gets 403 even if that query would have failed.
    expect(precheckCreateUser(cashier, req)).toEqual({
      ok: false, status: 403, error: 'insufficient permission: staff.create',
    })
    expect(precheckCreateUser({ ...manager, uid: null }, req)).toMatchObject({ ok: false, status: 401 })
    expect(precheckCreateUser(manager, { ...req, password: '1' })).toMatchObject({ ok: false, status: 400 })
    // A cross-store request by a manager is refused, never queried.
    expect(precheckCreateUser(manager, { ...req, store_id: 'store-b' })).toMatchObject({ ok: false, status: 403 })
    expect(precheckCreateUser(vendor, req)).toMatchObject({ ok: false, status: 403 })
    expect(precheckCreateUser(manager, req)).toEqual({ ok: true, storeId: 'store-a' })
    expect(precheckCreateUser(vendor, { ...req, store_id: 'store-b' })).toEqual({ ok: true, storeId: 'store-b' })
  })

  it('the decision agrees with the precheck on every refusal it makes', () => {
    for (const [c, r] of [
      [cashier, req],
      [{ ...manager, uid: null }, req],
      [manager, { ...req, username: '' }],
      [manager, { ...req, store_id: 'store-b' }],
      [vendor, req],
    ] as const) {
      expect(authorizeCreateUser(c, r, { ...opts, registerOnly: true })).toEqual(precheckCreateUser(c, r))
    }
  })

  it('reads store_is_register_only: missing function = false, other errors fail closed', () => {
    expect(registerOnlyValue({ data: true, error: null })).toBe(true)
    expect(registerOnlyValue({ data: false, error: null })).toBe(false)
    expect(registerOnlyValue({ data: null, error: null })).toBe(false)
    expect(registerOnlyValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })).toBe(false)
    expect(registerOnlyValue({ data: null, error: { code: '42883', message: 'function does not exist' } })).toBe(false)
    expect(() => registerOnlyValue({ data: null, error: { code: '57014', message: 'timeout' } })).toThrow('timeout')
  })
})
