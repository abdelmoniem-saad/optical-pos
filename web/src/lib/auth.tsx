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
 * Ensure a public.users row exists for the signed-in auth user so invoices can
 * be attributed and roles/permissions apply.
 *
 * Resolution order (mirrors staff.ts):
 *   1. A row keyed by the auth UID - keep its display name fresh.
 *   2. A LEGACY row whose username equals the email local-part - leave it as
 *      is; it already carries the correct role (this is what makes the seeded
 *      'admin' account work).
 *   3. Otherwise create one, auto-assigning the Admin position when the
 *      account looks administrative or when it's the very first staff member.
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

    // 3) Brand-new staff record. Default to the Admin position for
    //    administrative-looking accounts or the very first team member.
    let role_id: string | null = null
    const wantsAdmin = /admin|owner/i.test(username)
    const { count } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
    const isFirst = (count ?? 0) === 0
    if (wantsAdmin || isFirst) {
      const { data: adminRole } = await supabase
        .from('roles')
        .select('id')
        .ilike('name', 'admin')
        .limit(1)
        .returns<{ id: string }[]>()
      role_id = adminRole?.[0]?.id ?? null
    }

    await supabase.from('users').insert({
      id: user.id,
      username,
      full_name: fullName || null,
      role_id,
      is_active: true,
    })
  } catch {
    // Attribution is best-effort - never block login over it.
  }
}
