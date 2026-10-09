import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import { isMissingRpc } from '../data/rpc'

/** The migration number this build of the app was written against (017 -> 17).
 *
 *  Bump this ONLY together with a migration in web/supabase/. It is the single
 *  fact the UI compares the live database against, so if the two ever disagree
 *  the banner tells the shop what to run instead of the app guessing from an
 *  error code. */
export const EXPECTED_SCHEMA_VERSION = 27

export type SchemaVersion =
  /** Database confirmed current (or newer) - nothing to show. */
  | { state: 'ok'; version: number }
  /** Database is behind this build: `version` is what it has, run the rest. */
  | { state: 'behind'; version: number }
  /** Could not determine (offline, or pre-017 database). Silent, not alarming. */
  | { state: 'unknown'; version: null }

/** Classify a raw RPC answer. Exported for the test, which is where the edge
 *  cases actually matter: the difference between 0, null and "function does
 *  not exist" decides whether a shop sees an accurate instruction or a lie. */
export function toState(data: unknown): SchemaVersion {
  // Order matters. Number(null) is 0 and Number(undefined) is NaN, and 0 is
  // the single most alarming value there is - so an absent answer has to be
  // rejected BEFORE it can be coerced into one.
  if (data === null || data === undefined || data === '') {
    return { state: 'unknown', version: null }
  }
  const version = typeof data === 'number' ? data : Number(data)
  if (!Number.isFinite(version)) return { state: 'unknown', version: null }
  return version < EXPECTED_SCHEMA_VERSION
    ? { state: 'behind', version }
    : { state: 'ok', version }
}

/** Read the database's schema version once per session.
 *
 *  Deliberately forgiving. A database that has never had 017 applied answers
 *  PGRST202, and that is NOT an error to shout about: it is the ordinary state
 *  of every shop that upgrades the app before the SQL, and the app keeps
 *  working. So an unreadable version resolves to 'unknown' rather than
 *  'behind' - a false alarm here would train people to ignore the one banner
 *  that matters. */
export function useSchemaVersion() {
  return useQuery({
    queryKey: ['schema-version'],
    // The version cannot change while the tab is open; re-checking would only
    // add a query per session.
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<SchemaVersion> => {
      const { data, error } = await supabase.rpc('schema_version')
      if (error) {
        if (isMissingRpc('schema_version', error)) return { state: 'unknown', version: null }
        throw error
      }
      return toState(data)
    },
  })
}
