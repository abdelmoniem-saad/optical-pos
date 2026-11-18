// Offline staff sign-in for the shop PC.
//
// Supabase Auth needs the network, so the PC keeps a salted PBKDF2 verifier of
// each staff member's password in IndexedDB (never replicated, never exported).
// Sign-in:
//   - online:  Supabase checks the password of THAT staff member's own account
//              (email derived from the staff row, never from what was typed).
//              Success refreshes the verifier; a rejection (wrong password,
//              account deleted or banned in the cloud) also revokes it.
//   - offline: the local verifier must match.
// An admin can also set an "offline password" for a staff member who has
// never signed in online on this PC.
//
// This is staff identity on the PC only. Replication to the cloud runs as the
// separate "device account" that linked this PC during setup.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { CREDENTIALS, deleteCredential, getAll, getOne, putCredential, type Credential } from './db'
import type { User } from '../database.types'

const SESSION_KEY = 'lensy-local-session'
const ITERATIONS = 150_000
const ONLINE_CHECK_TIMEOUT_MS = 6_000
export const EMAIL_DOMAIN = (
  (import.meta.env.VITE_AUTH_EMAIL_DOMAIN as string | undefined) ?? 'lensypos.local'
).toLowerCase()

/** The Supabase Auth email of a staff username (same mapping as auth.tsx). */
export function staffEmail(username: string | null | undefined): string {
  const v = String(username ?? '').trim()
  return v.includes('@') ? v : `${v}@${EMAIL_DOMAIN}`
}

export type LocalSession = {
  userId: string
  username: string
  fullName: string | null
  signedInAt: string
}

// ---- session ----------------------------------------------------------------

export const LOCAL_SESSION_KEY = SESSION_KEY

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
  windowSession = null
}

// The person signed in on THIS window (each window attributes its own sales,
// even if someone signs in on another window meanwhile).
let windowSession: LocalSession | null = getLocalSession()

export function setWindowSession(s: LocalSession | null): void {
  windowSession = s
}

export function currentWindowSession(): LocalSession | null {
  return windowSession
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
  if (password.length < 6) throw new Error('Password must be at least 6 characters')
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

/** Forget a staff member's offline password on this PC. */
export async function revokeOfflinePassword(userId: string): Promise<void> {
  await deleteCredential(userId)
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

type VerifyResult = { result: 'ok'; authId: string; email: string } | { result: 'bad' } | { result: 'unreachable' }

/** Check `password` against the cloud account with exactly this email. */
async function verifyOnline(email: string, password: string): Promise<VerifyResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { result: 'unreachable' }
  try {
    const attempt = verifyClient().auth.signInWithPassword({ email, password })
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ONLINE_CHECK_TIMEOUT_MS))
    const res = await Promise.race([attempt, timeout])
    if (res === 'timeout') return { result: 'unreachable' }
    const { data, error } = res
    if (!error && data.user) {
      void verifyClient().auth.signOut({ scope: 'local' })
      return { result: 'ok', authId: data.user.id, email: (data.user.email ?? email).toLowerCase() }
    }
    const status = (error as { status?: number } | null)?.status ?? 0
    // 400 = wrong password / unknown or banned account; anything else = can't tell.
    return status === 400 ? { result: 'bad' } : { result: 'unreachable' }
  } catch {
    return { result: 'unreachable' }
  }
}

/** The cloud account that answered must be this staff row's own account. */
function belongsTo(row: Pick<User, 'id' | 'username'>, v: { authId: string; email: string }): boolean {
  return v.authId === row.id || v.email === staffEmail(row.username).toLowerCase()
}

// ---- sign-in ----------------------------------------------------------------

/** Exact username match; the configured staff domain may be typed or left off. */
function findStaff(users: User[], input: string): User | undefined {
  const v = input.trim().toLowerCase()
  const exact = users.find((u) => (u.username ?? '').toLowerCase() === v)
  if (exact) return exact
  const suffix = `@${EMAIL_DOMAIN}`
  if (v.endsWith(suffix)) {
    const bare = v.slice(0, -suffix.length)
    return users.find((u) => (u.username ?? '').toLowerCase() === bare)
  }
  return undefined
}

const INVALID = 'Invalid login credentials'

export async function localSignIn(usernameInput: string, password: string): Promise<LocalSession> {
  let user = findStaff(await getAll<User>('users'), usernameInput)

  if (!user) {
    // Added after this PC was set up (online app, vendor, dashboard)? Ask the cloud.
    const input = usernameInput.trim()
    const online = await verifyOnline(staffEmail(input), password)
    if (online.result === 'unreachable') {
      throw new Error('This person is not known on this computer yet. Connect to the internet once and sign in again.')
    }
    if (online.result === 'bad') throw new Error(INVALID)
    const { pullStaffMember } = await import('./sync')
    const bare = input.toLowerCase().endsWith(`@${EMAIL_DOMAIN}`) ? input.slice(0, -(EMAIL_DOMAIN.length + 1)) : input
    const row = await pullStaffMember(bare)
    if (!row || !belongsTo(row, online)) throw new Error(INVALID)
    user = row
  }
  if (user.is_active === false) throw new Error(INVALID)

  const online = await verifyOnline(staffEmail(user.username), password)
  if (online.result === 'ok') {
    if (!belongsTo(user, online)) throw new Error(INVALID)
    await setOfflinePassword(user, password).catch(() => undefined)
  } else if (online.result === 'bad') {
    // Wrong password, or the account was deleted/banned in the cloud: an old
    // offline password must not keep working either.
    if (await verifyLocal(user.id, password)) await revokeOfflinePassword(user.id)
    throw new Error(INVALID)
  } else {
    if (!(await hasOfflinePassword(user.id))) {
      throw new Error(
        'This account has not signed in on this computer yet. Connect to the internet once, or ask an admin to set an offline password.',
      )
    }
    if (!(await verifyLocal(user.id, password))) throw new Error(INVALID)
  }

  const session: LocalSession = {
    userId: user.id,
    username: user.username,
    fullName: user.full_name,
    signedInAt: new Date().toISOString(),
  }
  setLocalSession(session)
  windowSession = session
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
    email: staffEmail(s.username),
    app_metadata: {},
    user_metadata: { username: s.username, full_name: s.fullName ?? '' },
    aud: 'local',
    created_at: s.signedInAt,
  } as import('@supabase/supabase-js').User
}
