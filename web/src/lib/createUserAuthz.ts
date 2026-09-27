/**
 * Authorisation for the `create-user` Edge Function - the decision, with no I/O.
 *
 * WHY THIS EXISTS, SEPARATELY FROM THE FUNCTION ITSELF
 * ----------------------------------------------------
 * `create-user` holds the service-role key, because creating a Supabase Auth
 * user cannot be done with the anon key. Until now its only gate was a valid
 * JWT, and it took `role_id` and `store_id` straight from the request body. So
 * ANY signed-in staff member - a cashier - could POST to it and mint themselves
 * an admin login, in another shop if they liked, and then sail past every RLS
 * policy through that account.
 *
 * The rules live here, pure and dependency-free, so they can be unit-tested and
 * type-checked by `tsc -b` like the rest of the app. The Edge Function resolves
 * the facts (who is calling, what may they do, how many staff are there) and
 * hands them here; this module answers allow or refuse and says why.
 *
 * The service-role key is used ONLY to create the auth user, never to decide
 * anything: authorisation is asked of the database as the CALLER.
 */

/** What the database knows about whoever is calling. */
export type CreateUserCaller = {
  /** Supabase auth user id, or null when the request carried no session. */
  uid: string | null
  /** A vendor (platform) account. Bypasses the store pin and the staff quota. */
  isPlatformAdmin: boolean
  /** Result of `can('staff.create')` for this caller. */
  canCreateStaff: boolean
  /** Result of `can('staff.edit')` - needed to hand somebody a position. */
  canAssignRoles: boolean
  /** The caller's own store, or null when their account is not linked. */
  storeId: string | null
}

export type CreateUserRequest = {
  username?: string | null
  password?: string | null
  full_name?: string | null
  role_id?: string | null
  store_id?: string | null
}

/** The plan limit that lives in `store_licenses.max_staff`. */
export type CreateUserPlan = {
  /** NULL = unlimited. */
  maxStaff: number | null
  currentStaff: number
}

export type CreateUserDecision =
  | {
      ok: true
      email: string
      /** Always resolved - never the caller's word for it. */
      storeId: string
      roleId: string | null
      /** True when the role was actually applied; false when silently dropped. */
      roleGranted: boolean
    }
  | { ok: false; status: 400 | 401 | 403; error: string }

const MIN_PASSWORD = 6

/**
 * Decide whether this caller may create this account, and pin the values the
 * row will be written with.
 *
 * The store is never taken from the request for an ordinary staff member: it is
 * the caller's own. A vendor account may name any store, because that is the
 * one job it exists for.
 */
export function authorizeCreateUser(
  caller: CreateUserCaller,
  req: CreateUserRequest,
  opts: { domain: string; plan?: CreateUserPlan },
): CreateUserDecision {
  if (!caller.uid) {
    return { ok: false, status: 401, error: 'not signed in' }
  }

  const username = (req.username ?? '').trim()
  if (!username) {
    return { ok: false, status: 400, error: 'username is required' }
  }
  const password = req.password ?? ''
  if (password.length < MIN_PASSWORD) {
    return {
      ok: false,
      status: 400,
      error: `password must be at least ${MIN_PASSWORD} characters`,
    }
  }

  if (!caller.isPlatformAdmin && !caller.canCreateStaff) {
    return { ok: false, status: 403, error: 'insufficient permission: staff.create' }
  }

  // The store. Pinned, not requested.
  const requested = (req.store_id ?? '').trim() || null
  let storeId: string | null
  if (caller.isPlatformAdmin) {
    storeId = requested ?? caller.storeId
  } else {
    storeId = caller.storeId
  }
  if (!storeId) {
    return {
      ok: false,
      status: 403,
      error: 'no store for the signed-in user; ask an administrator to link this account',
    }
  }
  if (!caller.isPlatformAdmin && requested && requested !== storeId) {
    // Not a refusal: we simply do not honour a cross-store request. Saying so
    // would tell a probing cashier that another store exists.
    return { ok: false, status: 403, error: 'insufficient permission: staff.create' }
  }

  // The position. Handing out a role is a stronger act than creating a login.
  const roleId = (req.role_id ?? '').trim() || null
  const roleGranted = roleId !== null && (caller.isPlatformAdmin || caller.canAssignRoles)
  if (roleId !== null && !roleGranted) {
    return { ok: false, status: 403, error: 'insufficient permission: staff.edit' }
  }

  // The plan's seat limit, enforced here so it cannot be raced by two tabs.
  const plan = opts.plan
  if (
    !caller.isPlatformAdmin &&
    plan &&
    plan.maxStaff !== null &&
    plan.currentStaff >= plan.maxStaff
  ) {
    return {
      ok: false,
      status: 403,
      error: `staff limit reached (${plan.currentStaff}/${plan.maxStaff}) for this plan`,
    }
  }

  const email = username.includes('@') ? username : `${username}@${opts.domain}`
  return { ok: true, email, storeId, roleId: roleGranted ? roleId : null, roleGranted }
}
