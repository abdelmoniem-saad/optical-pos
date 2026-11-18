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
import { IS_LOCAL, READ_ONLY } from './config'
import {
  LOCAL_SESSION_KEY,
  getLocalSession,
  localSignIn,
  localSignOut,
  sessionAsAuthUser,
  setWindowSession,
  type LocalSession,
} from './local/localAuth'
import { clearPersistedWizard } from '../features/pos/wizardStore'

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

/** Supabase Auth online; local staff sign-in on the shop PC (VITE_DATA_MODE=local). */
export function AuthProvider({ children }: { children: ReactNode }) {
  return IS_LOCAL ? <LocalAuthProvider>{children}</LocalAuthProvider> : <CloudAuthProvider>{children}</CloudAuthProvider>
}

/**
 * Shop PC: staff sign in against verifiers stored on the PC, so login works
 * with no internet. The PC's Supabase session (the "device account" used for
 * replication) is untouched by staff sign-in/out.
 */
function LocalAuthProvider({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState<LocalSession | null>(() => getLocalSession())
  const user = local ? sessionAsAuthUser(local) : null
  // Screens only test the session for presence; give them a stand-in.
  const session = user ? ({ user, access_token: '', token_type: 'local' } as unknown as Session) : null

  // Sales made in this window are attributed to the person shown in it.
  useEffect(() => {
    setWindowSession(local)
  }, [local])

  // Signing in/out in another window of the app applies here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LOCAL_SESSION_KEY && e.key !== null) return
      const next = getLocalSession()
      setLocal((cur) => (cur?.userId === next?.userId && cur?.signedInAt === next?.signedInAt ? cur : next))
      if (!next) queryClient.clear()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  async function signIn(username: string, password: string) {
    setLocal(await localSignIn(username, password))
  }

  async function signOut() {
    localSignOut()
    clearPersistedWizard()
    setLocal(null)
    queryClient.clear()
  }

  return (
    <AuthContext.Provider value={{ session, user, loading: false, signIn, signOut }}>{children}</AuthContext.Provider>
  )
}

function CloudAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Hydrate from any persisted session, then subscribe to changes.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next)
      // Store id / license / vendor flag were possibly fetched before sign-in
      // (as anonymous = null): fetch them again for the new account.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        for (const key of ['my-store-id', 'my-license', 'is-platform-admin']) {
          void queryClient.invalidateQueries({ queryKey: [key] })
        }
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // Keep a `users` row linked to the signed-in auth user so invoices can be
  // attributed (sales.user_id → users.id, keyed BY the auth UUID - the same
  // convention staff.ts::useCurrentUser relies on).
  useEffect(() => {
    const u = session?.user
    // The read-only phone view never writes - not even this bookkeeping row.
    if (u && !READ_ONLY) void ensureStaffRecord(u)
  }, [session])

  async function signIn(username: string, password: string) {
    const email = usernameToEmail(username)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function signOut() {
    // 'local': end THIS device's session only. The default ('global') would
    // also sign out every other device of the same account - including the
    // shop PC's cloud sync when the owner signs out on the phone.
    await supabase.auth.signOut({ scope: 'local' })
    clearPersistedWizard()
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
