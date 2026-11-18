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

const rawMode = String(import.meta.env.VITE_DATA_MODE ?? '').trim().toLowerCase() || 'supabase'
const rawReadOnly = String(import.meta.env.VITE_READ_ONLY ?? '').trim().toLowerCase() || 'false'

export const DATA_MODE: DataMode = rawMode === 'local' ? 'local' : 'supabase'
export const IS_LOCAL = DATA_MODE === 'local'

export const READ_ONLY = !IS_LOCAL && rawReadOnly === 'true'

/**
 * A misspelt flag must never silently produce the wrong kind of app (e.g. a
 * read-write phone view, or a shop PC writing straight to the cloud). The
 * build already refuses these (vite.config.ts); this is the runtime backstop.
 */
export const CONFIG_ERROR: string | null =
  rawMode !== 'supabase' && rawMode !== 'local'
    ? `VITE_DATA_MODE must be "supabase" or "local" (it is "${rawMode}").`
    : rawReadOnly !== 'true' && rawReadOnly !== 'false'
      ? `VITE_READ_ONLY must be "true" or "false" (it is "${rawReadOnly}").`
      : null

/** Set on the shop PC when it is linked (see sync.ts provisionDevice). */
export const DEVICE_MARKER_KEY = 'lensypos-device'

const cloudUrl = String(import.meta.env.VITE_CLOUD_URL ?? '').trim().replace(/\/+$/, '')

/** Whether a public cloud URL was configured for QR codes. */
export function hasCloudUrl(): boolean {
  return !!cloudUrl
}

/** Base URL a phone should open (QR codes). Falls back to this origin. */
export function publicAppUrl(): string {
  return cloudUrl || window.location.origin
}

/** Message shown whenever a write is attempted in the read-only view. */
export const READ_ONLY_MESSAGE = 'Read-only view - changes are made on the shop computer.'
