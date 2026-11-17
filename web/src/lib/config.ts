// Build-time deployment flags. Read once; every module branches on these.
//
//   VITE_DATA_MODE=supabase  (default) today's behaviour: the browser talks to
//                            Supabase directly. Used by the hosted app.
//   VITE_DATA_MODE=local     the shop PC: IndexedDB is the system of record,
//                            works with no internet, and an outbox replicates
//                            every change one-way to Supabase when online.
//
//   VITE_READ_ONLY=true      (supabase mode only) the owner's phone view: reads
//                            Supabase, every write is refused client-side.
//
//   VITE_CLOUD_URL           public URL of the hosted app. The shop PC runs on
//                            localhost, which a phone can't reach, so QR codes
//                            for "attach from mobile" point here instead.

export type DataMode = 'supabase' | 'local'

const rawMode = String(import.meta.env.VITE_DATA_MODE ?? 'supabase').trim().toLowerCase()

export const DATA_MODE: DataMode = rawMode === 'local' ? 'local' : 'supabase'
export const IS_LOCAL = DATA_MODE === 'local'

export const READ_ONLY =
  !IS_LOCAL && String(import.meta.env.VITE_READ_ONLY ?? '').trim().toLowerCase() === 'true'

const cloudUrl = String(import.meta.env.VITE_CLOUD_URL ?? '').trim().replace(/\/+$/, '')

/** Base URL a phone should open (QR codes). Falls back to this origin. */
export function publicAppUrl(): string {
  return cloudUrl || window.location.origin
}

/** Message shown whenever a write is attempted in the read-only view. */
export const READ_ONLY_MESSAGE = 'Read-only view - changes are made on the shop computer.'
