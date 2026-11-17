// In-memory copy of the shop PC's local bookkeeping (loaded once at startup so
// screens can read it synchronously): provisioning status, store id, and the
// last known license from the cloud.
import { useSyncExternalStore } from 'react'
import { metaGet, metaSet } from './db'

export type LicenseState = 'active' | 'grace' | 'expired' | 'none'

export type CachedLicense = {
  state: LicenseState
  plan: string | null
  expires_at: string | null
  store_name: string | null
  /** When the cloud last confirmed this license. */
  checked_at: string
}

export type LocalMeta = {
  provisioned: boolean
  storeId: string | null
  license: CachedLicense | null
  /** Cloud account the sync engine replicates as (shown in the sync panel). */
  deviceAccount: string | null
  lastPullAt: string | null
}

const KEYS: (keyof LocalMeta)[] = ['provisioned', 'storeId', 'license', 'deviceAccount', 'lastPullAt']

let meta: LocalMeta = {
  provisioned: false,
  storeId: null,
  license: null,
  deviceAccount: null,
  lastPullAt: null,
}
const subs = new Set<() => void>()

export async function initLocalMeta(): Promise<void> {
  const next = { ...meta }
  for (const k of KEYS) {
    const v = await metaGet<unknown>(k)
    if (v !== null) (next as Record<string, unknown>)[k] = v
  }
  meta = next
}

export function localMeta(): LocalMeta {
  return meta
}

export async function setLocalMeta(patch: Partial<LocalMeta>): Promise<void> {
  for (const [k, v] of Object.entries(patch)) await metaSet(k, v)
  meta = { ...meta, ...patch }
  for (const fn of subs) fn()
}

export function subscribeLocalMeta(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** Reactive view of the local bookkeeping. */
export function useLocalMeta(): LocalMeta {
  return useSyncExternalStore(subscribeLocalMeta, localMeta, localMeta)
}

const GRACE_DAYS = 30
const RANK: Record<LicenseState, number> = { active: 0, grace: 1, expired: 2, none: 3 }

/**
 * Effective license state while offline: the cloud's last answer, made
 * stricter as time passes past the cached expiry (active → grace → expired),
 * so going offline can't extend a license.
 */
export function effectiveLicenseState(lic: CachedLicense | null): LicenseState | null {
  if (!lic) return null
  let byDate: LicenseState = 'active'
  if (lic.expires_at) {
    const exp = new Date(lic.expires_at).getTime()
    const now = Date.now()
    if (now > exp + GRACE_DAYS * 86_400_000) byDate = 'expired'
    else if (now > exp) byDate = 'grace'
  }
  return RANK[byDate] > RANK[lic.state] ? byDate : lic.state
}
