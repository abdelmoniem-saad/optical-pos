// One-way replication: shop PC (IndexedDB) -> Supabase.
//
//  * The outbox is drained strictly in order. Consecutive entries for the same
//    table/op are batched into one request; if a batch is rejected, its entries
//    are re-sent one at a time so the queue stops at the entry the cloud
//    actually refuses (never at a valid neighbour).
//  * Every request is idempotent: upserts and deletes are keyed by primary key
//    with client-generated UUIDs, so a retry after a dropped response (or a
//    replay of the whole queue) cannot duplicate anything.
//  * Network/server hiccups -> back off and retry. A data error (constraint,
//    RLS, ...) holds the queue at that entry - later entries may depend on it -
//    and is surfaced in the sync panel with the database's message.
//  * Photos queued while offline upload before the rows that reference them; a
//    photo the cloud refuses is set aside (shown in the panel) and never blocks
//    the rows.
//  * Only ONE window of the app replicates at a time (Web Locks), and only the
//    store's registered computer replicates at all (migration 011).
//
// Replication runs as the "device account" (a store admin) that linked the PC
// during setup; its Supabase session is persisted by the shared client and
// refreshed whenever the PC is online. Staff sign in locally (localAuth.ts).
import { useSyncExternalStore } from 'react'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import { queryClient } from '../queryClient'
import { TABLES, tableDef, type TableDef } from './schema'
import {
  IMAGES,
  commit,
  commitSeq,
  count,
  getByIndex,
  getOne,
  metaGet,
  metaSet,
  onCommit,
  outboxCount,
  outboxDelete,
  outboxPeek,
  outboxSkipHead,
  outboxUpdateIfPresent,
  pendingImages,
  putImage,
  replaceStores,
  withLock,
  deleteCredential,
  type OutboxEntry,
  type Row,
  type StoredImage,
} from './db'
import { localMeta, setLocalMeta, type CachedLicense, effectiveLicenseState } from './state'
import { setOfflinePassword, staffEmail } from './localAuth'
import { uuid } from './uuid'
import { DEVICE_MARKER_KEY } from '../config'
import type { Sale, User } from '../database.types'

const BUCKET = 'prescriptions'
const BATCH_ROWS = 500
const INTERVAL_MS = 30_000
const LICENSE_EVERY_MS = 10 * 60_000
const STAFF_EVERY_MS = 10 * 60_000
const ADOPT_EVERY_MS = 2 * 60_000
const HEARTBEAT_EVERY_MS = 5 * 60_000
const MAX_BACKOFF_MS = 15 * 60_000
/** Shared by every window of the app on this PC: one replicator at a time. */
export const SYNC_LOCK = 'lensypos-sync'

// ---------------------------------------------------------------------------
// status store
// ---------------------------------------------------------------------------

export type SyncStatus = {
  online: boolean
  syncing: boolean
  pending: number
  pendingImages: number
  /** Last time EVERYTHING queued on this PC had reached the cloud. */
  lastSyncAt: string | null
  /** Transient problem (network, auth) - retried automatically. */
  lastError: string | null
  /** A change the cloud rejected; the queue waits behind it. */
  blocked: { seq: number; table: string; op: string; error: string; attempts: number; createdAt: string } | null
  /** A photo the cloud rejected (rows keep syncing; the photo waits). */
  imageBlocked: { path: string; error: string; attempts: number } | null
  /** The device account's cloud session is gone - an admin must re-link. */
  needsLink: boolean
  /** Another computer is now this store's register: this one stopped syncing. */
  replaced: boolean
  /** The store license does not allow cloud writes right now. */
  licenseHold: boolean
}

let status: SyncStatus = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  pending: 0,
  pendingImages: 0,
  lastSyncAt: null,
  lastError: null,
  blocked: null,
  imageBlocked: null,
  needsLink: false,
  replaced: false,
  licenseHold: false,
}
const subs = new Set<() => void>()

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch }
  for (const fn of subs) fn()
}

export function getSyncStatus(): SyncStatus {
  return status
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => status,
    () => status,
  )
}

async function refreshCounts() {
  setStatus({ pending: await outboxCount(), pendingImages: (await pendingImages()).length })
}

// Connectivity is tracked from startup (also before the PC is set up).
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setStatus({ online: true }))
  window.addEventListener('offline', () => setStatus({ online: false }))
}

// ---------------------------------------------------------------------------
// error classification
// ---------------------------------------------------------------------------

type DbError = { code?: string; message?: string; details?: string; hint?: string } | null

class SyncError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}
class TransientError extends SyncError {}
class AuthError extends SyncError {}

function describe(e: DbError): string {
  if (!e) return 'Unknown error'
  return [e.message, e.details, e.hint].filter(Boolean).join(' - ') || e.code || 'Unknown error'
}

function classify(httpStatus: number, error: DbError): SyncError {
  const msg = describe(error)
  if (
    !Number.isFinite(httpStatus) ||
    httpStatus === 0 ||
    httpStatus === 408 ||
    httpStatus === 429 ||
    httpStatus >= 500 ||
    /failed to fetch|networkerror|load failed|fetch failed/i.test(msg)
  ) {
    return new TransientError(msg, error?.code)
  }
  if (httpStatus === 401 || error?.code === 'PGRST301' || error?.code === 'PGRST303' || /jwt/i.test(msg)) {
    return new AuthError(msg, error?.code)
  }
  return new SyncError(friendly(error, msg), error?.code)
}

/** Plain-language prefix for the rejections staff are most likely to meet. */
function friendly(error: DbError, msg: string): string {
  if (error?.code === '23505') {
    if (/invoice_no/i.test(msg)) {
      return `Invoice number already used in the cloud (another computer or the online app used it). ${msg}`
    }
    return `Duplicate value - the cloud already has this name/code. ${msg}`
  }
  if (error?.code === '42501') return `The cloud refused the change (permissions or license). ${msg}`
  return msg
}

function isMissingTable(error: DbError): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /could not find the table/i.test(error.message ?? '')
}

function isMissingFunction(error: DbError): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.code === '42883' || /could not find the function/i.test(error.message ?? '')
}

/** Column the cloud doesn't have (older schema) - strip it and retry. */
function missingColumn(error: DbError): string | null {
  const m = (error?.message ?? '').match(/could not find the '([^']+)' column/i)
  if (m) return m[1]
  const m2 = (error?.message ?? '').match(/column "?([\w]+)"? of relation .* does not exist/i)
  return m2 ? m2[1] : null
}

/** HTTP status of a storage-js error (statusCode in the body may be a word). */
function storageStatus(error: unknown): number {
  const e = error as { status?: unknown; statusCode?: unknown; name?: string }
  if (typeof e?.status === 'number') return e.status
  const n = Number(e?.statusCode)
  if (Number.isFinite(n) && n > 0) return n
  return e?.name === 'StorageApiError' ? 400 : 0
}

// ---------------------------------------------------------------------------
// pushing the outbox
// ---------------------------------------------------------------------------

let stripped: Record<string, string[]> | null = null
async function strippedColumns(): Promise<Record<string, string[]>> {
  if (!stripped) stripped = (await metaGet<Record<string, string[]>>('strippedColumns')) ?? {}
  return stripped
}

let conflictPick: Record<string, number> | null = null
async function conflictPicks(): Promise<Record<string, number>> {
  if (!conflictPick) conflictPick = (await metaGet<Record<string, number>>('conflictPick')) ?? {}
  return conflictPick
}

function prepare(table: string, row: Row): Row {
  const out: Row = { ...row }
  const def = tableDef(table)
  if (def.storeScoped && out.store_id == null && localMeta().storeId) out.store_id = localMeta().storeId
  return out
}

/** Keep only the LAST version of each row (one statement can't hit a row twice). */
function dedupe(rows: Row[], key: string[]): Row[] {
  const byKey = new Map<string, Row>()
  for (const r of rows) {
    const k = key.map((c) => String(r[c])).join('\u0001')
    byKey.delete(k)
    byKey.set(k, r)
  }
  return [...byKey.values()]
}

async function upsertGroup(table: string, def: TableDef, rows: Row[]): Promise<void> {
  const cols = await strippedColumns()
  const picks = await conflictPicks()
  const targets = def.conflict ?? [def.key]
  let conflictTries = 0
  for (let attempt = 0; attempt < 12; attempt++) {
    const drop = cols[table] ?? []
    const body = rows.map((r) => {
      const o = { ...r }
      for (const c of drop) delete o[c]
      return o
    })
    const pick = (picks[table] ?? 0) % targets.length
    const res = await supabase
      .from(table)
      .upsert(body, { onConflict: targets[pick].join(','), defaultToNull: false })
    if (!res.error) return
    // No unique constraint matches this target (schema before/after 011): try the next.
    if (res.error.code === '42P10' && targets.length > 1 && conflictTries < targets.length - 1) {
      conflictTries++
      picks[table] = (pick + 1) % targets.length
      await metaSet('conflictPick', picks)
      continue
    }
    const col = missingColumn(res.error)
    if (col && !drop.includes(col)) {
      cols[table] = [...drop, col]
      await metaSet('strippedColumns', cols)
      continue
    }
    throw classify(res.status, res.error)
  }
  throw new SyncError(`Could not replicate ${table}: the cloud schema does not match.`)
}

async function pushUpsert(table: string, key: string[], rows: Row[]): Promise<void> {
  const def = tableDef(table)
  const body = dedupe(
    rows.map((r) => prepare(table, r)),
    key,
  )
  // One request per column set: ON CONFLICT DO UPDATE then only touches the
  // columns each row actually carries (a missing created_at is never reset).
  const groups = new Map<string, Row[]>()
  for (const r of body) {
    const sig = Object.keys(r).sort().join(',')
    const g = groups.get(sig)
    if (g) g.push(r)
    else groups.set(sig, [r])
  }
  for (const g of groups.values()) await upsertGroup(table, def, g)
}

/**
 * A delete that RLS filters out "succeeds" with 0 rows. When fewer rows were
 * deleted than asked for, make sure that is because they are already gone -
 * not because this account may not delete right now.
 */
async function assertCanWrite(): Promise<void> {
  const { data, error } = await supabase.rpc('my_license_state').maybeSingle<{ state: string }>()
  if (error) throw classify(0, error)
  if (!data) throw new AuthError('Cloud sign-in needed')
  if (data.state !== 'active') {
    throw new SyncError('The store license does not allow changes right now - this change waits until it is renewed.')
  }
}

async function pushDelete(table: string, key: string[], rows: Row[]): Promise<void> {
  let requested = 0
  let deleted = 0
  if (key.length === 1) {
    const ids = [...new Set(rows.map((r) => r[key[0]] as string))]
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const res = await supabase.from(table).delete({ count: 'exact' }).in(key[0], chunk)
      if (res.error) throw classify(res.status, res.error)
      requested += chunk.length
      deleted += res.count ?? chunk.length
    }
  } else {
    for (const r of rows) {
      const match: Record<string, unknown> = {}
      for (const c of key) match[c] = r[c]
      const res = await supabase.from(table).delete({ count: 'exact' }).match(match)
      if (res.error) throw classify(res.status, res.error)
      requested += 1
      deleted += res.count ?? 1
    }
  }
  if (deleted < requested) await assertCanWrite()
}

/** Consecutive entries with the same table/op, capped by row count. */
function nextGroup(entries: OutboxEntry[]): OutboxEntry[] {
  const first = entries[0]
  const group = [first]
  let rows = first.rows.length
  for (const e of entries.slice(1)) {
    if (e.table !== first.table || e.op !== first.op || e.key.join() !== first.key.join()) break
    if (rows + e.rows.length > BATCH_ROWS) break
    group.push(e)
    rows += e.rows.length
  }
  return group
}

async function pushGroup(group: OutboxEntry[]): Promise<void> {
  const head = group[0]
  const rows = group.flatMap((e) => e.rows)
  if (head.op === 'upsert') await pushUpsert(head.table, head.key, rows)
  else await pushDelete(head.table, head.key, rows)
}

function blockedOf(e: OutboxEntry, error: string, attempts: number): SyncStatus['blocked'] {
  return { seq: e.seq as number, table: e.table, op: e.op, error, attempts, createdAt: e.createdAt }
}

/** The cloud rejected this entry: keep it at the head and back off. */
async function hold(entry: OutboxEntry, e: unknown): Promise<void> {
  const attempts = entry.attempts + 1
  const msg = e instanceof Error ? e.message : String(e)
  await outboxUpdateIfPresent(entry.seq as number, {
    attempts,
    lastError: msg,
    nextAttemptAt: Date.now() + Math.min(MAX_BACKOFF_MS, 2 ** Math.min(attempts, 10) * 5_000),
  })
  setStatus({ blocked: blockedOf(entry, msg, attempts) })
}

const isRetryable = (e: unknown): boolean => e instanceof TransientError || e instanceof AuthError

/** Returns how many entries reached the cloud. */
async function drainOutbox(): Promise<number> {
  let pushed = 0
  for (;;) {
    const entries = await outboxPeek(200)
    if (!entries.length) {
      setStatus({ blocked: null })
      return pushed
    }
    const head = entries[0]
    const wait = (head.nextAttemptAt ?? 0) - Date.now()
    // (A wait longer than the maximum back-off means the clock was changed.)
    if (wait > 0 && wait <= MAX_BACKOFF_MS && !manualRun) {
      if (head.lastError) setStatus({ blocked: blockedOf(head, head.lastError, head.attempts) })
      return pushed
    }
    const group = nextGroup(entries)
    try {
      await pushGroup(group)
      await outboxDelete(group.map((e) => e.seq as number))
      pushed += group.length
    } catch (e) {
      if (isRetryable(e)) throw e
      if (group.length === 1) {
        await hold(head, e)
        return pushed
      }
      // Find the entry the cloud actually refuses: send them one at a time.
      for (const entry of group) {
        try {
          await pushGroup([entry])
          await outboxDelete([entry.seq as number])
          pushed += 1
        } catch (e2) {
          if (isRetryable(e2)) throw e2
          await hold(entry, e2)
          return pushed
        }
      }
    }
    setStatus({ blocked: null, pending: await outboxCount() })
  }
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

/** Upload queued photos. A photo the cloud refuses is set aside, never blocks rows. */
async function uploadImages(): Promise<void> {
  let problem: SyncStatus['imageBlocked'] = null
  for (const img of await pendingImages()) {
    if (img.skipped) continue
    if (img.nextAttemptAt && img.nextAttemptAt > Date.now() && !manualRun) {
      problem ??= { path: img.path, error: img.lastError ?? 'Upload refused', attempts: img.attempts ?? 0 }
      continue
    }
    let err: SyncError | null = null
    if (!(img.blob instanceof Blob)) {
      err = new SyncError('The photo data is missing on this computer.')
    } else {
      const { error } = await supabase.storage.from(BUCKET).upload(img.path, img.blob, {
        cacheControl: '3600',
        contentType: img.contentType,
        upsert: false,
      })
      const st = error ? storageStatus(error) : 200
      // Already there (a previous attempt succeeded but we never heard back).
      const exists = !!error && (st === 409 || /exists|duplicate/i.test(error.message ?? ''))
      if (error && !exists) err = classify(st, { message: error.message })
    }
    if (err) {
      if (isRetryable(err)) throw err
      const attempts = (img.attempts ?? 0) + 1
      await putImage({
        ...img,
        attempts,
        lastError: err.message,
        nextAttemptAt: Date.now() + Math.min(MAX_BACKOFF_MS, 2 ** Math.min(attempts, 10) * 5_000),
      })
      problem ??= { path: img.path, error: err.message, attempts }
      continue
    }
    await putImage({ ...img, uploaded: 1, attempts: 0, lastError: null, nextAttemptAt: undefined })
  }
  setStatus({ imageBlocked: problem })
}

/** Admin: stop trying to upload a photo the cloud keeps refusing (kept on this PC). */
export async function skipBlockedImage(path: string): Promise<void> {
  const img = await getOne<StoredImage>(IMAGES, path)
  if (img) {
    await putImage({ ...img, uploaded: 1, skipped: true })
    const list = (await metaGet<string[]>('skippedImages')) ?? []
    await metaSet('skippedImages', [...list, path].slice(-500))
  }
  setStatus({ imageBlocked: null })
  await refreshCounts()
  void syncNow(true)
}

// ---------------------------------------------------------------------------
// license, register claim, staff, phone photos, heartbeat
// ---------------------------------------------------------------------------

async function fetchLicense(): Promise<CachedLicense | null> {
  const { data, error } = await supabase.rpc('my_license_state').maybeSingle<Omit<CachedLicense, 'checked_at'>>()
  if (error) throw classify(0, error)
  return data ? { ...data, checked_at: new Date().toISOString() } : null
}

let lastLicenseAt = 0
async function refreshLicense(force = false): Promise<void> {
  const cachedOk = effectiveLicenseState(localMeta().license) === 'active'
  // Not active locally: check every pass so a renewal is picked up at once.
  if (!force && cachedOk && Date.now() - lastLicenseAt < LICENSE_EVERY_MS) return
  const lic = await fetchLicense()
  lastLicenseAt = Date.now()
  if (lic) {
    await setLocalMeta({ license: lic })
    queryClient.invalidateQueries({ queryKey: ['my-license'] })
  }
}

/** This PC's id for the store's single-register claim (migration 011). */
async function deviceId(): Promise<string> {
  let id = await metaGet<string>('deviceId')
  if (!id) {
    id = uuid()
    await metaSet('deviceId', id)
  }
  return id
}

export class RegisterTakenError extends Error {
  constructor() {
    super('This store already has a register computer. Tick "Replace the old register" to move it to this computer.')
    this.name = 'RegisterTakenError'
  }
}

/** Claim the store's register slot. No-op on databases without migration 011. */
async function claimRegister(takeover: boolean): Promise<void> {
  const { data, error } = await supabase.rpc('claim_register', { p_device: await deviceId(), p_takeover: takeover })
  if (error) {
    if (isMissingFunction(error)) return
    throw classify(0, error)
  }
  if (data === false) throw new RegisterTakenError()
}

let lastClaimCheckAt = 0
/**
 * Still the store's register? Checked before every pass that has something to
 * upload (so a replaced PC never uploads again), else every 10 minutes.
 */
async function checkRegister(force: boolean): Promise<boolean> {
  if (!force && Date.now() - lastClaimCheckAt < LICENSE_EVERY_MS && !status.replaced) return true
  lastClaimCheckAt = Date.now()
  const { data, error } = await supabase.rpc('register_is_current', { p_device: await deviceId() })
  if (error) {
    if (isMissingFunction(error)) return true
    throw classify(0, error)
  }
  if (data === null || data === undefined) {
    // Nothing claimed yet (PC set up before 011): claim it now.
    await claimRegister(false).catch(() => undefined)
    return true
  }
  return data === true
}

let lastStaffAt = 0
async function refreshStaff(): Promise<void> {
  if (Date.now() - lastStaffAt < STAFF_EVERY_MS) return
  lastStaffAt = Date.now()
  await pullNewStaff()
}

/** Milliseconds encoded in an order photo name (<inv>-<slot>-<base36 ms>.<ext>). */
export function photoTime(path: string | null | undefined): number {
  const m = /-(?:rx|frame)-([0-9a-z]+)\.[a-z0-9]+$/i.exec(path ?? '')
  const n = m ? Number.parseInt(m[1], 36) : NaN
  return Number.isFinite(n) ? n : 0
}

/** A photo is only taken for an order around the time the order is made. */
const ADOPT_BEFORE_ORDER_MS = 12 * 3600_000

/**
 * Photos taken on the phone (QR flow) land in cloud storage keyed by invoice
 * number; the phone view is read-only, so the PC adopts them into its own
 * sales rows. Driven by the newest files in storage (one request), so a photo
 * taken today for an old order is picked up too. A photo older than its order
 * (abandoned or mistyped invoice number) is never adopted; a newer photo for a
 * filled slot replaces it (the phone's "Replace").
 */
let lastAdoptAt = 0
export async function adoptPhoneImages(force = false): Promise<number> {
  if (!force && Date.now() - lastAdoptAt < ADOPT_EVERY_MS) return 0
  lastAdoptAt = Date.now()
  const storeId = localMeta().storeId
  if (!storeId) return 0
  const dir = `store/${storeId}/orders`
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(dir, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } })
  if (error || !data) return 0
  const { getRepo } = await import('../repository')
  const { cacheCloudImage } = await import('../storage')
  let adopted = 0
  for (const f of data) {
    const m = /^(.+)-(rx|frame)-[0-9a-z]+\.[a-z0-9]+$/i.exec(f.name)
    if (!m) continue
    const [, inv, slot] = m
    if (inv.startsWith('PRESC-')) continue
    const path = `${dir}/${f.name}`
    if (await getOne(IMAGES, path)) continue // uploaded by this PC itself
    const sale = (await getByIndex<Sale>('sales', 'invoice_no', inv))[0]
    if (!sale) continue
    const taken = photoTime(path)
    const ordered = Date.parse(String(sale.order_date ?? ''))
    if (Number.isFinite(ordered) && taken && taken < ordered - ADOPT_BEFORE_ORDER_MS) continue
    const current = slot === 'rx' ? sale.rx_image_path : sale.frame_image_path
    if (current === path) continue
    if (current && photoTime(current) >= taken) continue
    try {
      await getRepo().setOrderImage(sale.id, slot as 'rx' | 'frame', path)
      adopted++
      void cacheCloudImage(path)
    } catch {
      // license hold etc. - try again on a later pass
    }
  }
  if (adopted) {
    queryClient.invalidateQueries({ queryKey: ['sales'] })
    queryClient.invalidateQueries({ queryKey: ['customer-orders'] })
  }
  return adopted
}

/** Tell the cloud (owner's phone view) when this PC last caught up. */
let lastHeartbeatAt = 0
async function heartbeat(pushed: number): Promise<void> {
  if (!pushed && Date.now() - lastHeartbeatAt < HEARTBEAT_EVERY_MS) return
  lastHeartbeatAt = Date.now()
  await pushUpsert('settings', ['key'], [{ key: 'pc_last_sync', value: new Date().toISOString() }])
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

let running: Promise<void> | null = null
let manualRun = false

type CloudSession = 'ok' | 'none' | 'unreachable'

async function cloudSession(): Promise<CloudSession> {
  const { data, error } = await supabase.auth.getSession()
  if (data.session) return 'ok'
  // Expired access token + no internet: the session is still stored.
  if (error && isAuthRetryableFetchError(error)) return 'unreachable'
  return 'none'
}

async function cycle(): Promise<true> {
  await refreshCounts()
  if (!navigator.onLine) {
    setStatus({ online: false })
    return true
  }
  setStatus({ online: true, syncing: true })
  try {
    const session = await cloudSession()
    if (session === 'unreachable') throw new TransientError('No internet connection')
    if (session === 'none') {
      setStatus({ needsLink: true, lastError: 'Cloud sign-in needed' })
      return true
    }
    const waiting = (await outboxCount()) + (await pendingImages()).length
    if (!(await checkRegister(waiting > 0 || manualRun))) {
      setStatus({ replaced: true, lastError: 'Another computer is now the register for this store. This one no longer uploads.' })
      return true
    }
    setStatus({ replaced: false })

    await refreshLicense()
    const licState = effectiveLicenseState(localMeta().license)
    if (licState && licState !== 'active') {
      setStatus({ licenseHold: true, needsLink: false })
      return true
    }
    setStatus({ licenseHold: false })

    let imageError: unknown = null
    try {
      await uploadImages()
    } catch (e) {
      if (e instanceof AuthError) throw e
      imageError = e
    }
    const pushed = await drainOutbox()
    await refreshStaff().catch(() => undefined)
    await adoptPhoneImages().catch(() => undefined)
    if (imageError) throw imageError

    const left = await outboxCount()
    const patch: Partial<SyncStatus> = { lastError: null, needsLink: false }
    if (left === 0) {
      const at = new Date().toISOString()
      await metaSet('lastSyncAt', at)
      patch.lastSyncAt = at
      await heartbeat(pushed).catch(() => undefined)
    }
    setStatus(patch)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof AuthError) {
      // Try one refresh; if the refresh token is dead an admin must re-link.
      const { error } = await supabase.auth.refreshSession()
      setStatus({ needsLink: !!error && !isAuthRetryableFetchError(error), lastError: msg })
    } else {
      setStatus({ lastError: msg })
    }
  } finally {
    setStatus({ syncing: false })
    await refreshCounts()
  }
  return true
}

/** Run one sync pass now (no-op if one is running here or in another window). */
export function syncNow(manual = false): Promise<void> {
  if (running) return running
  manualRun = manual
  running = withLock(SYNC_LOCK, cycle, { ifAvailable: true })
    .then(async (r) => {
      // Another window is replicating: just show its progress.
      if (r === null) await refreshCounts()
    })
    .finally(() => {
      running = null
      manualRun = false
    })
  return running
}

let started = false
let kickTimer: ReturnType<typeof setTimeout> | null = null

/** Start background replication (local mode only, once provisioned). */
export function startSync(): void {
  if (started) return
  started = true
  void metaGet<string>('lastSyncAt').then((at) => setStatus({ lastSyncAt: at }))
  onCommit((_tables, outboxed, remote) => {
    if (!outboxed && !remote) return
    void refreshCounts()
    if (remote) return
    if (kickTimer) clearTimeout(kickTimer)
    kickTimer = setTimeout(() => void syncNow(), 1500)
  })
  window.addEventListener('online', () => void syncNow())
  setInterval(() => void syncNow(), INTERVAL_MS)
  void syncNow()
}

/**
 * Drop the rejected change the admin was shown (by its seq). Refuses - and
 * returns false - if that entry already synced or is no longer at the head.
 */
export async function skipBlockedEntry(seq: number): Promise<boolean> {
  const ok = await withLock(SYNC_LOCK, () => outboxSkipHead(seq))
  setStatus({ blocked: null })
  await refreshCounts()
  void syncNow(true)
  return !!ok
}

// ---------------------------------------------------------------------------
// linking the PC + full download (setup, restore-from-cloud)
// ---------------------------------------------------------------------------

export type PullProgress = (table: string, done: number, total: number) => void

type Query = ReturnType<ReturnType<typeof supabase.from>['select']>

async function pullTable(name: string, storeId: string, narrow?: (q: Query) => Query): Promise<Row[]> {
  const def = tableDef(name)
  const rows: Row[] = []
  const single = def.key.length === 1
  let last: unknown = null
  let from = 0
  for (;;) {
    let q = supabase.from(name).select('*') as Query
    if (def.storeScoped) q = q.eq('store_id', storeId)
    if (narrow) q = narrow(q)
    for (const k of def.key) q = q.order(k)
    // Keyset paging for single-column keys (OFFSET gets slower page by page).
    if (single) {
      if (last !== null) q = q.gt(def.key[0], last as string)
      q = q.limit(1000)
    } else {
      q = q.range(from, from + 999)
    }
    const { data, error } = await q
    if (error) {
      if (def.optional && isMissingTable(error)) return []
      throw new Error(`${name}: ${describe(error)}`)
    }
    if (!data?.length) break
    rows.push(...(data as unknown as Row[]))
    from += data.length
    if (single) last = (data[data.length - 1] as unknown as Row)[def.key[0]]
  }
  return rows
}

/** Download every mirrored table of THIS store from the cloud (does not write locally). */
async function pullAll(storeId: string, progress?: PullProgress): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {}
  for (const [i, t] of TABLES.entries()) {
    progress?.(t.name, i, TABLES.length)
    if (t.name === 'role_permissions') {
      const ids = (out.roles ?? []).map((r) => r.id as string)
      out[t.name] = ids.length ? await pullTable(t.name, storeId, (q) => q.in('role_id', ids)) : []
    } else if (t.name === 'user_permissions') {
      const ids = (out.users ?? []).map((u) => u.id as string)
      out[t.name] = ids.length ? await pullTable(t.name, storeId, (q) => q.in('user_id', ids)) : []
    } else {
      out[t.name] = await pullTable(t.name, storeId)
    }
  }
  progress?.('', TABLES.length, TABLES.length)
  return out
}

function maxInvoice(sales: Row[]): number {
  let max = 0
  for (const s of sales) {
    const str = String(s.invoice_no ?? '').trim()
    if (/^\d+$/.test(str)) max = Math.max(max, Number.parseInt(str, 10))
  }
  return max
}

/** Highest numeric invoice number the cloud has for this store (online only). */
export async function cloudMaxInvoice(): Promise<number> {
  const storeId = localMeta().storeId
  if (!storeId) return 0
  const { data, error } = await supabase
    .from('sales')
    .select('invoice_no')
    .eq('store_id', storeId)
    .filter('invoice_no', 'match', '^[0-9]+$')
    .order('invoice_no', { ascending: false })
    .limit(50)
  if (error) throw new Error(describe(error))
  return maxInvoice((data ?? []) as unknown as Row[])
}

async function requireStore(): Promise<string> {
  const { data, error } = await supabase.rpc('auth_store_id')
  if (error) throw new Error(describe(error))
  if (!data) throw new Error('This account is not linked to a store.')
  return data as string
}

/** The signed-in cloud account's staff row (same resolution as the cloud). */
async function myStaffRow(): Promise<(User & { roles?: { name?: string | null } | null }) | null> {
  const { data: auth } = await supabase.auth.getUser()
  const u = auth.user
  if (!u) return null
  const cols = 'id, username, full_name, role_id, is_active, store_id, roles(name)'
  const { data: byId } = await supabase.from('users').select(cols).eq('id', u.id).maybeSingle()
  if (byId) return byId as unknown as User & { roles?: { name?: string | null } | null }
  const local = (u.email ?? '').split('@')[0]
  const { data: byName } = await supabase.from('users').select(cols).eq('username', local).limit(1)
  const row = (byName?.[0] ?? null) as unknown as (User & { roles?: { name?: string | null } | null }) | null
  // Legacy rows link by username only when the email is exactly the staff mapping.
  return row && staffEmail(row.username).toLowerCase() === (u.email ?? '').toLowerCase() ? row : null
}

/** Sign the device account in (setup or re-link). Store admins of THIS store only. */
export async function linkDevice(email: string, password: string): Promise<string> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  try {
    const { data: vendor } = await supabase.rpc('is_platform_admin')
    if (vendor === true) throw new Error('Use the admin account of this store here, not a vendor (platform) account.')
    const storeId = await requireStore()
    const known = localMeta().storeId
    if (known && known !== storeId) throw new Error('That account belongs to a different store than this computer.')
    const me = await myStaffRow()
    const role = String(me?.roles?.name ?? '').toLowerCase()
    const isAdmin =
      !!me &&
      me.is_active !== false &&
      (role === 'admin' || role === 'owner' || !me.role_id || String(me.username).toLowerCase() === 'superadmin')
    if (!isAdmin) throw new Error('Only a store admin account can link this computer.')
    setStatus({ needsLink: false, lastError: null })
    if (localMeta().provisioned) {
      await setLocalMeta({ deviceAccount: data.user?.email ?? email })
      void syncNow(true)
    }
    return storeId
  } catch (e) {
    await supabase.auth.signOut({ scope: 'local' })
    throw e
  }
}

/**
 * First-run setup: link the PC to the store with an admin's cloud account,
 * claim the store's register slot, download everything, and remember that
 * admin's password for offline sign-in.
 */
export async function provisionDevice(
  email: string,
  password: string,
  progress?: PullProgress,
  opts: { takeover?: boolean } = {},
): Promise<void> {
  const storeId = await linkDevice(email, password)
  const license = await fetchLicense()
  if (!license || (license.state !== 'active' && license.state !== 'grace')) {
    throw new Error('This store has no active license. Ask your vendor to renew it, then try again.')
  }
  await claimRegister(!!opts.takeover)
  const data = await pullAll(storeId, progress)

  const { data: auth } = await supabase.auth.getUser()
  const users = (data.users ?? []) as unknown as User[]
  const me =
    users.find((u) => u.id === auth.user?.id) ??
    users.find((u) => staffEmail(u.username).toLowerCase() === (auth.user?.email ?? email).toLowerCase())
  if (!me) throw new Error('Your staff record was not in the download. Check your connection and try again.')

  await replaceStores(data)
  const high = (await metaGet<number>('invoiceHigh')) ?? 0
  await metaSet('invoiceHigh', Math.max(high, maxInvoice(data.sales ?? [])))
  // The admin who set the PC up can sign in offline straight away.
  await setOfflinePassword(me, password)

  await setLocalMeta({
    provisioned: true,
    storeId,
    license,
    deviceAccount: auth.user?.email ?? null,
    lastPullAt: new Date().toISOString(),
  })
  try {
    // Lets a wrongly deployed cloud build recognise this computer (config.ts).
    localStorage.setItem(DEVICE_MARKER_KEY, 'local')
  } catch {
    // storage blocked
  }
  startSync()
}

/**
 * Replace the local mirror with the cloud copy (e.g. after a disk problem).
 * Refused while local changes are still waiting to upload - they would be lost
 * - and if anything is committed on this PC while it downloads.
 */
export async function restoreFromCloud(progress?: PullProgress): Promise<void> {
  const result = await withLock(SYNC_LOCK, async () => {
    if ((await outboxCount()) > 0) {
      throw new Error('Some changes have not been uploaded yet. Sync (or export a backup) before restoring.')
    }
    if (!navigator.onLine) throw new Error('Restoring from the cloud needs an internet connection.')
    if ((await cloudSession()) !== 'ok') throw new Error('Cloud sign-in needed')
    const storeId = await requireStore()
    if (storeId !== localMeta().storeId) throw new Error('The cloud account is linked to a different store.')
    const license = await fetchLicense()
    if (!license || (license.state !== 'active' && license.state !== 'grace')) {
      throw new Error('The store license does not allow reading the cloud copy right now.')
    }
    await setLocalMeta({ license })
    const seq = await commitSeq()
    const data = await pullAll(storeId, progress)
    if ((await cloudSession()) !== 'ok') throw new Error('Cloud sign-in was lost during the download. Nothing was replaced.')
    if (!(data.users ?? []).length) throw new Error('The cloud copy came back empty. Nothing was replaced.')
    for (const t of ['customers', 'sales', 'inventory']) {
      const here = await count(t)
      if (here > 0 && !(data[t] ?? []).length) {
        throw new Error(`The cloud copy has no ${t} but this computer has ${here}. Nothing was replaced.`)
      }
    }
    await replaceStores(data, { expectCommitSeq: seq })
    const high = (await metaGet<number>('invoiceHigh')) ?? 0
    await metaSet('invoiceHigh', Math.max(high, maxInvoice(data.sales ?? [])))
    await setLocalMeta({ lastPullAt: new Date().toISOString() })
    return true
  })
  if (result === null) throw new Error('Sync is busy in another window. Try again.')
  await queryClient.invalidateQueries()
}

/**
 * Bring staff records created in the cloud (Add Staff, vendor, dashboard) down
 * to the PC. Only ADDS rows the PC doesn't have yet - local edits are never
 * overwritten - except that a person deactivated in the cloud is deactivated
 * here too (and their offline password is revoked).
 */
export async function pullNewStaff(): Promise<number> {
  const storeId = localMeta().storeId
  if (!storeId) return 0
  const [users, roles] = await Promise.all([pullTable('users', storeId), pullTable('roles', storeId)])
  const newUsers: Row[] = []
  const deactivated: Row[] = []
  for (const u of users) {
    const mine = await getOne<Row>('users', u.id as string)
    if (!mine) newUsers.push(u)
    else if (u.is_active === false && mine.is_active !== false) deactivated.push({ ...mine, is_active: false })
  }
  const newRoles: Row[] = []
  for (const r of roles) if (!(await getOne('roles', r.id as string))) newRoles.push(r)
  await commit([
    { table: 'roles', op: 'upsert', rows: newRoles, localOnly: true },
    { table: 'users', op: 'upsert', rows: [...newUsers, ...deactivated], localOnly: true },
  ])
  for (const u of deactivated) await deleteCredential(u.id as string)
  if (newUsers.length || deactivated.length || newRoles.length) {
    queryClient.invalidateQueries({ queryKey: ['users'] })
    queryClient.invalidateQueries({ queryKey: ['roles'] })
  }
  return newUsers.length
}

/** Fetch one staff row of this store from the cloud and keep it locally. */
export async function pullStaffMember(username: string): Promise<User | null> {
  const storeId = localMeta().storeId
  if (!storeId || !navigator.onLine) return null
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('store_id', storeId)
    .ilike('username', username.replace(/[%_\\]/g, '\\$&'))
    .limit(1)
  if (error || !data?.length) return null
  const row = data[0] as unknown as Row
  if (!(await getOne('users', row.id as string))) {
    await commit([{ table: 'users', op: 'upsert', rows: [row], localOnly: true }])
  }
  return row as unknown as User
}
