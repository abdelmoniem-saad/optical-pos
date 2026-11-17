// Offline staff sign-in for the shop PC.
//
// Supabase Auth needs the network, so the PC keeps a salted PBKDF2 verifier of
// each staff member's password in IndexedDB (never replicated). Sign-in:
//   1. the local verifier matches            -> signed in (works offline)
//   2. otherwise, if online, ask Supabase     -> on success cache a verifier
// An admin can also set an "offline password" for a staff member who has never
// signed in online on this PC.
//
// This is staff identity on the PC only. Replication to the cloud runs as the
// separate "device account" that linked this PC during setup.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { CREDENTIALS, getAll, getOne, putCredential, type Credential } from './db'
import type { User } from '../database.types'

const SESSION_KEY = 'lensy-local-session'
const ITERATIONS = 150_000
const EMAIL_DOMAIN = (import.meta.env.VITE_AUTH_EMAIL_DOMAIN as string | undefined) ?? 'lensypos.local'

export type LocalSession = {
  userId: string
  username: string
  fullName: string | null
  signedInAt: string
}

// ---- session ----------------------------------------------------------------

export function getLocalSession(): LocalSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as LocalSession) : null
  } catch {
    return null
  }
}

function setLocalSession(s: LocalSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    // storage blocked - session lasts for this page only
  }
}

export function localSignOut(): void {
  setLocalSession(null)
}

// ---- hashing ----------------------------------------------------------------

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Offline sign-in needs a secure origin (https:// or http://localhost).')
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  )
  return toB64(new Uint8Array(bits))
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Store (or replace) the offline password verifier for a staff member. */
export async function setOfflinePassword(user: Pick<User, 'id' | 'username'>, password: string): Promise<void> {
  if (password.length < 4) throw new Error('Password must be at least 4 characters')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  await putCredential({
    user_id: user.id,
    username: user.username,
    salt: toB64(salt),
    hash: await derive(password, salt, ITERATIONS),
    iterations: ITERATIONS,
    updated_at: new Date().toISOString(),
  })
}

export async function hasOfflinePassword(userId: string): Promise<boolean> {
  return !!(await getOne<Credential>(CREDENTIALS, userId))
}

async function verifyLocal(userId: string, password: string): Promise<boolean> {
  const c = await getOne<Credential>(CREDENTIALS, userId)
  if (!c) return false
  return safeEqual(await derive(password, fromB64(c.salt), c.iterations), c.hash)
}

// ---- online verification (does NOT touch the device's sync session) --------

let verifier: SupabaseClient | null = null
function verifyClient(): SupabaseClient {
  if (!verifier) {
    verifier = createClient(
      import.meta.env.VITE_SUPABASE_URL as string,
      import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storageKey: 'lensy-verify',
        },
      },
    )
  }
  return verifier
}

type VerifyResult = 'ok' | 'bad' | 'unreachable'

async function verifyOnline(username: string, password: string): Promise<VerifyResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'unreachable'
  try {
    const email = username.includes('@') ? username : `${username}@${EMAIL_DOMAIN}`
    const { error } = await verifyClient().auth.signInWithPassword({ email, password })
    if (!error) return 'ok'
    const status = (error as { status?: number }).status ?? 0
    // 400 = wrong credentials; anything else (0/5xx/fetch failure) = can't tell.
    return status === 400 ? 'bad' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

// ---- sign-in ----------------------------------------------------------------

function normalizeUsername(input: string): string {
  const v = input.trim().toLowerCase()
  return v.includes('@') ? v.split('@')[0] : v
}

export async function localSignIn(usernameInput: string, password: string): Promise<LocalSession> {
  const uname = normalizeUsername(usernameInput)
  const users = await getAll<User>('users')
  const user = users.find((u) => (u.username ?? '').toLowerCase() === uname)
  if (!user || user.is_active === false) throw new Error('Invalid login credentials')

  let ok = await verifyLocal(user.id, password)
  if (!ok) {
    const online = await verifyOnline(usernameInput.trim(), password)
    if (online === 'ok') {
      await setOfflinePassword(user, password)
      ok = true
    } else if (online === 'unreachable' && !(await hasOfflinePassword(user.id))) {
      throw new Error(
        'This account has not signed in on this computer yet. Connect to the internet once, or ask an admin to set an offline password.',
      )
    }
  }
  if (!ok) throw new Error('Invalid login credentials')

  const session: LocalSession = {
    userId: user.id,
    username: user.username,
    fullName: user.full_name,
    signedInAt: new Date().toISOString(),
  }
  setLocalSession(session)
  return session
}

/**
 * The local session presented in the shape of a Supabase auth user, so every
 * screen that reads `useAuth().user` works unchanged. `id` is the STAFF row id
 * and the email is the username mapping - exactly what useCurrentUser resolves.
 */
export function sessionAsAuthUser(s: LocalSession): import('@supabase/supabase-js').User {
  return {
    id: s.userId,
    email: `${s.username}@${EMAIL_DOMAIN}`,
    app_metadata: {},
    user_metadata: { username: s.username, full_name: s.fullName ?? '' },
    aud: 'local',
    created_at: s.signedInAt,
  } as import('@supabase/supabase-js').User
}
