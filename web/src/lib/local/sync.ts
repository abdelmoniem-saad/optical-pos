// One-way replication: shop PC (IndexedDB) -> Supabase.
//
//  * The outbox is drained strictly in order. Consecutive entries for the same
//    table/op are batched into one request.
//  * Every request is idempotent: upserts and deletes are keyed by primary key
//    with client-generated UUIDs, so a retry after a dropped response (or a
//    replay of the whole queue) cannot duplicate anything.
//  * Network/server hiccups -> back off and retry. A data error (constraint,
//    RLS, ...) blocks the queue at that entry - later entries may depend on it -
//    and is surfaced in the sync panel with the database's message.
//  * Images queued while offline upload before the rows that reference them.
//
// Replication runs as the "device account" (a store admin) that linked the PC
// during setup; its Supabase session is persisted by the shared client and
// refreshed whenever the PC is online. Staff sign in locally (localAuth.ts).
import { useSyncExternalStore } from 'react'
import { supabase } from '../supabase'
import { queryClient } from '../queryClient'
import { TABLES, tableDef } from './schema'
import {
  getAll,
  metaGet,
  metaSet,
  onCommit,
  outboxCount,
  outboxDelete,
  outboxPeek,
  outboxPut,
  pendingImages,
  putImage,
  replaceStores,
  type OutboxEntry,
  type Row,
} from './db'
import { localMeta, setLocalMeta, type CachedLicense } from './state'
import { setOfflinePassword } from './localAuth'
import type { Sale, User } from '../database.types'

const BUCKET = 'prescriptions'
const BATCH_ROWS = 500
const INTERVAL_MS = 30_000
const LICENSE_EVERY_MS = 10 * 60_000
const ADOPT_EVERY_MS = 2 * 60_000

// ---------------------------------------------------------------------------
// status store
// ---------------------------------------------------------------------------

export type SyncStatus = {
  online: boolean
  syncing: boolean
  pending: number
  pendingImages: number
  lastSyncAt: string | null
  /** Transient problem (network, auth) - retried automatically. */
  lastError: string | null
  /** A change the cloud rejected; the queue waits behind it. */
  blocked: { table: string; op: string; error: string; attempts: number; createdAt: string } | null
  /** The device account's cloud session is gone - an admin must re-link. */
  needsLink: boolean
}

let status: SyncStatus = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  pending: 0,
  pendingImages: 0,
  lastSyncAt: null,
  lastError: null,
  blocked: null,
  needsLink: false,
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

// ---------------------------------------------------------------------------
// error classification
// ---------------------------------------------------------------------------

type DbError = { code?: string; message?: string; details?: string; hint?: string } | null

class TransientError extends Error {}
class AuthError extends Error {}

function describe(e: DbError): string {
  if (!e) return 'Unknown error'
  return [e.message, e.details, e.hint].filter(Boolean).join(' - ') || e.code || 'Unknown error'
}

function classify(status: number, error: DbError): Error {
  const msg = describe(error)
  if (status === 0 || status >= 500 || /failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    return new TransientError(msg)
  }
  if (status === 401 || error?.code === 'PGRST301' || /jwt/i.test(msg)) return new AuthError(msg)
  return new Error(msg)
}

function isMissingTable(error: DbError): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /(does not exist|schema cache|could not find the table)/i.test(error.message ?? '')
}

/** Column the cloud doesn't have (older schema) - strip it and retry. */
function missingColumn(error: DbError): string | null {
  const m = (error?.message ?? '').match(/could not find the '([^']+)' column/i)
  if (m) return m[1]
  const m2 = (error?.message ?? '').match(/column "?([\w]+)"? of relation .* does not exist/i)
  return m2 ? m2[1] : null
}

// ---------------------------------------------------------------------------
// pushing the outbox
// ---------------------------------------------------------------------------

let stripped: Record<string, string[]> | null = null
async function strippedColumns(): Promise<Record<string, string[]>> {
  if (!stripped) stripped = (await metaGet<Record<string, string[]>>('strippedColumns')) ?? {}
  return stripped
}

function prepare(table: string, row: Row, drop: string[]): Row {
  const out: Row = { ...row }
  const def = tableDef(table)
  if (def.storeScoped && out.store_id == null && localMeta().storeId) out.store_id = localMeta().storeId
  for (const c of drop) delete out[c]
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

async function pushUpsert(table: string, key: string[], rows: Row[]): Promise<void> {
  const cols = await strippedColumns()
  for (let attempt = 0; attempt < 8; attempt++) {
    const drop = cols[table] ?? []
    const body = dedupe(
      rows.map((r) => prepare(table, r, drop)),
      key,
    )
    const res = await supabase.from(table).upsert(body, { onConflict: key.join(','), defaultToNull: false })
    if (!res.error) return
    const col = missingColumn(res.error)
    if (col && !drop.includes(col)) {
      cols[table] = [...drop, col]
      await metaSet('strippedColumns', cols)
      continue
    }
    throw classify(res.status, res.error)
  }
  throw new Error(`Could not replicate ${table}: too many unknown columns.`)
}

async function pushDelete(table: string, key: string[], rows: Row[]): Promise<void> {
  if (key.length === 1) {
    const ids = [...new Set(rows.map((r) => r[key[0]] as string))]
    for (let i = 0; i < ids.length; i += 200) {
      const res = await supabase.from(table).delete().in(key[0], ids.slice(i, i + 200))
      if (res.error) throw classify(res.status, res.error)
    }
    return
  }
  for (const r of rows) {
    const match: Record<string, unknown> = {}
    for (const c of key) match[c] = r[c]
    const res = await supabase.from(table).delete().match(match)
    if (res.error) throw classify(res.status, res.error)
  }
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

async function drainOutbox(): Promise<void> {
  for (;;) {
    const entries = await outboxPeek(200)
    if (!entries.length) {
      setStatus({ blocked: null })
      return
    }
    const head = entries[0]
    if (head.nextAttemptAt && head.nextAttemptAt > Date.now() && !manualRun) {
      // Still backing off from a rejected change - keep it visible.
      if (head.lastError) {
        setStatus({
          blocked: {
            table: head.table,
            op: head.op,
            error: head.lastError,
            attempts: head.attempts,
            createdAt: head.createdAt,
          },
        })
      }
      return
    }
    const group = nextGroup(entries)
    const rows = group.flatMap((e) => e.rows)
    try {
      if (head.op === 'upsert') await pushUpsert(head.table, head.key, rows)
      else await pushDelete(head.table, head.key, rows)
    } catch (e) {
      if (e instanceof TransientError || e instanceof AuthError) throw e
      // The cloud rejected the data itself: hold the queue here.
      const attempts = head.attempts + 1
      const msg = e instanceof Error ? e.message : String(e)
      await outboxPut({
        ...head,
        attempts,
        lastError: msg,
        nextAttemptAt: Date.now() + Math.min(15 * 60_000, 2 ** Math.min(attempts, 10) * 5_000),
      })
      setStatus({
        blocked: { table: head.table, op: head.op, error: msg, attempts, createdAt: head.createdAt },
      })
      return
    }
    await outboxDelete(group.map((e) => e.seq as number))
    setStatus({ blocked: null, pending: await outboxCount() })
  }
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

async function uploadImages(): Promise<void> {
  for (const img of await pendingImages()) {
    const { error } = await supabase.storage.from(BUCKET).upload(img.path, img.blob, {
      cacheControl: '3600',
      contentType: img.contentType,
      upsert: false,
    })
    // Already there (a previous attempt succeeded but we never heard back).
    const exists = !!error && /exists|duplicate/i.test(error.message ?? '')
    if (error && !exists) {
      const st = (error as { statusCode?: string | number }).statusCode
      throw classify(Number(st ?? 0), { message: error.message })
    }
    await putImage({ ...img, uploaded: 1 })
  }
}

// ---------------------------------------------------------------------------
// license + phone photos
// ---------------------------------------------------------------------------

async function fetchLicense(): Promise<CachedLicense | null> {
  const { data, error } = await supabase.rpc('my_license_state').maybeSingle<Omit<CachedLicense, 'checked_at'>>()
  if (error) throw classify(0, error)
  return data ? { ...data, checked_at: new Date().toISOString() } : null
}

let lastLicenseAt = 0
async function refreshLicense(): Promise<void> {
  if (Date.now() - lastLicenseAt < LICENSE_EVERY_MS) return
  const lic = await fetchLicense()
  lastLicenseAt = Date.now()
  if (lic) {
    await setLocalMeta({ license: lic })
    queryClient.invalidateQueries({ queryKey: ['my-license'] })
  }
}

/**
 * Photos taken on the phone (QR flow) land in cloud storage keyed by invoice
 * number; the phone view is read-only, so the PC adopts them into its own
 * sales rows. Covers recent orders that still have an empty photo slot.
 */
let lastAdoptAt = 0
async function adoptPhoneImages(): Promise<void> {
  if (Date.now() - lastAdoptAt < ADOPT_EVERY_MS) return
  lastAdoptAt = Date.now()
  const storeId = localMeta().storeId
  if (!storeId) return
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const recent = (await getAll<Sale>('sales'))
    .filter((s) => String(s.order_date ?? '') >= since && (!s.rx_image_path || !s.frame_image_path))
    .slice(0, 15)
  if (!recent.length) return
  const { findCloudOrderImages } = await import('../storage')
  const { getRepo } = await import('../repository')
  let changed = false
  for (const s of recent) {
    const found = await findCloudOrderImages(storeId, s.invoice_no)
    if (!s.rx_image_path && found.rx) {
      await getRepo().setOrderImage(s.id, 'rx', found.rx)
      changed = true
    }
    if (!s.frame_image_path && found.frame) {
      await getRepo().setOrderImage(s.id, 'frame', found.frame)
      changed = true
    }
  }
  if (changed) queryClient.invalidateQueries({ queryKey: ['sales'] })
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

let running: Promise<void> | null = null
let manualRun = false

async function hasCloudSession(): Promise<boolean> {
  const { data } = await supabase.auth.getSession()
  return !!data.session
}

async function cycle(): Promise<void> {
  await refreshCounts()
  if (!navigator.onLine) {
    setStatus({ online: false })
    return
  }
  setStatus({ online: true, syncing: true })
  try {
    if (!(await hasCloudSession())) {
      setStatus({ needsLink: true, lastError: 'Cloud sign-in needed' })
      return
    }
    await uploadImages()
    await drainOutbox()
    await refreshLicense()
    await adoptPhoneImages()
    const at = new Date().toISOString()
    await metaSet('lastSyncAt', at)
    setStatus({ lastSyncAt: at, lastError: null, needsLink: false })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof AuthError) {
      // Try one refresh; if the refresh token is dead an admin must re-link.
      const { error } = await supabase.auth.refreshSession()
      setStatus({ needsLink: !!error, lastError: msg })
    } else {
      setStatus({ lastError: msg })
    }
  } finally {
    setStatus({ syncing: false })
    await refreshCounts()
  }
}

/** Run one sync pass now (no-op if one is already running). */
export function syncNow(manual = false): Promise<void> {
  if (running) return running
  manualRun = manual
  running = cycle().finally(() => {
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
  onCommit((_tables, outboxed) => {
    if (!outboxed) return
    void refreshCounts()
    if (kickTimer) clearTimeout(kickTimer)
    kickTimer = setTimeout(() => void syncNow(), 1500)
  })
  window.addEventListener('online', () => {
    setStatus({ online: true })
    void syncNow()
  })
  window.addEventListener('offline', () => setStatus({ online: false }))
  setInterval(() => void syncNow(), INTERVAL_MS)
  void syncNow()
}

/** Drop the change at the head of the queue (admin, after reading the error). */
export async function skipBlockedEntry(): Promise<void> {
  const [head] = await outboxPeek(1)
  if (!head) return
  const skipped = (await metaGet<OutboxEntry[]>('skippedEntries')) ?? []
  await metaSet('skippedEntries', [...skipped, head])
  await outboxDelete([head.seq as number])
  setStatus({ blocked: null })
  await refreshCounts()
  void syncNow(true)
}

// ---------------------------------------------------------------------------
// linking the PC + full download (setup, restore-from-cloud)
// ---------------------------------------------------------------------------

export type PullProgress = (table: string, done: number, total: number) => void

async function pullTable(name: string, optional: boolean): Promise<Row[]> {
  const def = tableDef(name)
  const rows: Row[] = []
  for (let from = 0; ; ) {
    let q = supabase.from(name).select('*')
    for (const k of def.key) q = q.order(k)
    const { data, error } = await q.range(from, from + 999)
    if (error) {
      if (optional && isMissingTable(error)) return []
      throw new Error(`${name}: ${describe(error)}`)
    }
    if (!data?.length) break
    rows.push(...(data as Row[]))
    from += data.length
  }
  return rows
}

/** Download every mirrored table from the cloud (does not write locally). */
async function pullAll(progress?: PullProgress): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {}
  for (const [i, t] of TABLES.entries()) {
    progress?.(t.name, i, TABLES.length)
    out[t.name] = await pullTable(t.name, !!t.optional)
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

async function requireStore(): Promise<string> {
  const { data, error } = await supabase.rpc('auth_store_id')
  if (error) throw new Error(describe(error))
  if (!data) throw new Error('This account is not linked to a store.')
  return data as string
}

/** Sign the device account in (setup or re-link). Rejects another store's account. */
export async function linkDevice(email: string, password: string): Promise<string> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  const storeId = await requireStore()
  const known = localMeta().storeId
  if (known && known !== storeId) {
    await supabase.auth.signOut({ scope: 'local' })
    throw new Error('That account belongs to a different store than this computer.')
  }
  setStatus({ needsLink: false, lastError: null })
  if (localMeta().provisioned) void syncNow(true)
  return storeId
}

/**
 * First-run setup: link the PC to the store with an admin's cloud account,
 * download everything, and remember that admin's password for offline sign-in.
 */
export async function provisionDevice(email: string, password: string, progress?: PullProgress): Promise<void> {
  const storeId = await linkDevice(email, password)
  const license = await fetchLicense()
  const data = await pullAll(progress)
  await replaceStores(data)
  await metaSet('invoiceHigh', maxInvoice(data.sales ?? []))

  // The admin who set the PC up can sign in offline straight away.
  const { data: auth } = await supabase.auth.getUser()
  const uname = (auth.user?.email ?? email).split('@')[0]
  const users = data.users as unknown as User[]
  const me = users.find((u) => u.id === auth.user?.id) ?? users.find((u) => u.username === uname)
  if (me) await setOfflinePassword(me, password)

  await setLocalMeta({
    provisioned: true,
    storeId,
    license,
    deviceAccount: auth.user?.email ?? null,
    lastPullAt: new Date().toISOString(),
  })
  startSync()
}

/**
 * Replace the local mirror with the cloud copy (e.g. after a disk problem).
 * Refused while local changes are still waiting to upload - they would be lost.
 */
export async function restoreFromCloud(progress?: PullProgress): Promise<void> {
  if ((await outboxCount()) > 0) {
    throw new Error('Some changes have not been uploaded yet. Sync (or export a backup) before restoring.')
  }
  if (!navigator.onLine) throw new Error('Restoring from the cloud needs an internet connection.')
  if (!(await hasCloudSession())) throw new Error('Cloud sign-in needed')
  const data = await pullAll(progress)
  // A concurrent sale could have been queued while downloading - re-check.
  if ((await outboxCount()) > 0) throw new Error('A change was made during the download. Try again.')
  await replaceStores(data)
  const high = (await metaGet<number>('invoiceHigh')) ?? 0
  await metaSet('invoiceHigh', Math.max(high, maxInvoice(data.sales ?? [])))
  await setLocalMeta({ lastPullAt: new Date().toISOString() })
  await queryClient.invalidateQueries()
}

/**
 * Bring staff records created in the cloud (new user via the create-user Edge
 * Function) down to the PC. Only ADDS rows the PC doesn't have yet, so local
 * edits are never overwritten.
 */
export async function pullNewStaff(): Promise<number> {
  const [users, roles] = await Promise.all([pullTable('users', false), pullTable('roles', false)])
  const { commit, getOne } = await import('./db')
  const newUsers: Row[] = []
  for (const u of users) if (!(await getOne('users', u.id as string))) newUsers.push(u)
  const newRoles: Row[] = []
  for (const r of roles) if (!(await getOne('roles', r.id as string))) newRoles.push(r)
  await commit([
    { table: 'roles', op: 'upsert', rows: newRoles, localOnly: true },
    { table: 'users', op: 'upsert', rows: newUsers, localOnly: true },
  ])
  return newUsers.length
}
