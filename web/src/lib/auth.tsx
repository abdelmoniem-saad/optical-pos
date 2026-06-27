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
