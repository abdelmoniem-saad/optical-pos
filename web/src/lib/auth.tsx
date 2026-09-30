import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { queryClient } from './queryClient'
import { clearPosDraft } from './posDraft'

// This module intentionally co-locates the AuthProvider with its hook/helpers
// (useAuth, usernameToEmail, displayName).
/* eslint-disable react-refresh/only-export-components */

// Staff log in with a username, but Supabase Auth keys on email. We map
// "admin" -> "admin@<domain>" unless the input already looks like an email.
// The admin sets this same domain when creating users in the Supabase dashboard.
const EMAIL_DOMAIN =
  (import.meta.env.VITE_AUTH_EMAIL_DOMAIN as string | undefined) ?? 'lensypos.local'

export function usernameToEmail(input: string): string {
  const v = input.trim()
  return v.includes('@') ? v : `${v}@${EMAIL_DOMAIN}`
}

type AuthState = {
  session: Session | null
  user: User | null
  loading: boolean
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Hydrate from any persisted session, then subscribe to changes.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // Keep a `users` row linked to the signed-in auth user so invoices can be
  // attributed (sales.user_id → users.id, keyed BY the auth UUID - the same
  // convention staff.ts::useCurrentUser relies on).
  useEffect(() => {
    const u = session?.user
    if (u) void ensureStaffRecord(u)
  }, [session])

  async function signIn(username: string, password: string) {
    const email = usernameToEmail(username)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function signOut() {
    await supabase.auth.signOut()
    // Don't leave another staff member's data cached on a shared tablet.
    clearPosDraft()
    queryClient.clear()
    try {
      window.localStorage.removeItem('lensy-query-cache')
    } catch {
      // ignore storage errors
    }
  }

  return (
    <AuthContext.Provider
      value={{ session, user: session?.user ?? null, loading, signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

/** Display name for the signed-in user, from auth metadata or email local-part. */
export function displayName(user: User | null): string {
  if (!user) return ''
  const meta = user.user_metadata ?? {}
  return (
    (meta.full_name as string) ||
    (meta.username as string) ||
    user.email?.split('@')[0] ||
    'User'
  )
}

/**
 * Keep the signed-in auth user's STAFF RECORD current, so invoices can be
 * attributed and roles/permissions apply.
 *
 * Resolution order (mirrors staff.ts):
 *   1. A row keyed by the auth UID - keep its display name fresh.
 *   2. A LEGACY row whose username equals the email local-part - leave it as
 *      is; it already carries the correct role (this is what makes the seeded
 *      'admin' account work).
 *
 * It used to have a third step: CREATE the staff record when neither of the
 * above matched. That step could never run, and the code hid the reason.
 *
 * A staff row is created two ways that DO work, and neither is this one:
 *   • the create-user Edge Function, which holds the service-role key and so
 *     bypasses RLS entirely (the Staff screen's "Add Staff" button), and
 *   • 015_link_staff_ids.sql, run by a superuser.
 *
 * A plain INSERT from the browser is refused twice over, and neither refusal
 * is a bug in the database:
 *   1. the INSERT policy on public.users requires a store OR a platform admin,
 *      so a brand-new login satisfies neither - the row it would create is
 *      what would give it a store, which is circular;
 *   2. `public.users.store_id` is NOT NULL (008), and a new login has no store.
 *      Postgres raises 23502, not an RLS error, which is why the message was
 *      so unrecognisable.
 *
 * The old code ran both steps inside `try { ... } catch {}`, so the failure was
 * invisible: an account that had never been provisioned simply never got a
 * staff record, and the app reported it as "This account is not linked to a
 * store" - a symptom pointing at provisioning when the cause was this insert.
 * Nothing was ever created here, so removing it changes no behaviour; what it
 * removes is a comment that promised a row the function could not write.
 *
 * Making self-service provisioning actually work needs a `security definer`
 * RPC (and a decision about store_id), which is a schema change and therefore
 * its own piece of work - not something to smuggle in by deleting a branch.
 */
async function ensureStaffRecord(user: User): Promise<void> {
  try {
    const meta = user.user_metadata ?? {}
    const fullName = (meta.full_name as string) || ''
    const username =
      (meta.username as string) || user.email?.split('@')[0] || 'staff'

    // 1) Already linked by id?
    const { data: byId } = await supabase
      .from('users')
      .select('id')
      .eq('id', user.id)
      .maybeSingle<{ id: string }>()
    if (byId) {
      if (fullName) {
        await supabase.from('users').update({ full_name: fullName }).eq('id', user.id)
      }
      return
    }

    // 2) Legacy row with the same username? Adopt silently - its role is the
    //    source of truth and sales can reference its existing PK safely.
    const { data: byName } = await supabase
      .from('users')
      .select('id')
      .eq('username', username)
      .maybeSingle<{ id: string }>()
    if (byName) return

    // 3) Nothing to do. Deliberately NOT an insert: see the note above. An
    //    unprovisioned login is now told so plainly by AppLayout, which is a
    //    better outcome than a silent attempt that could never have worked.
  } catch {
    // Attribution is best-effort - never block login over it.
  }
}
