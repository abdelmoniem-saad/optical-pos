// Minimal, dependency-free IndexedDB layer for the offline shop PC.
//
// The one write primitive is `commit(changes)`: it applies a set of row
// upserts/deletes to the local mirror AND appends the matching outbox entries
// in ONE IndexedDB transaction. Either both land or neither does, so the
// outbox can never disagree with local data.
import { NON_COLUMN_PROPS, TABLES, tableDef } from './schema'
import { uuid } from './uuid'

const DB_NAME = 'lensypos-local'
const DB_VERSION = 1

export const OUTBOX = 'outbox'
export const META = 'meta'
export const IMAGES = 'images'
export const CREDENTIALS = 'credentials'

export type Row = Record<string, unknown>

export type Change = {
  table: string
  op: 'upsert' | 'delete'
  rows: Row[]
  /** Apply locally only - never replicate (e.g. local bookkeeping). */
  localOnly?: boolean
}

export type OutboxEntry = {
  seq?: number
  /** Unique id of this intent (logging / audit; rows are keyed by PK). */
  uid: string
  table: string
  op: 'upsert' | 'delete'
  /** Conflict / match columns in Supabase. */
  key: string[]
  /** Full rows for upsert; key-only rows for delete. */
  rows: Row[]
  createdAt: string
  attempts: number
  lastError?: string | null
  nextAttemptAt?: number
}

export type StoredImage = {
  path: string
  blob: Blob
  contentType: string
  createdAt: string
  /** 0 = waiting for upload, 1 = in the cloud (blob kept for offline viewing). */
  uploaded: 0 | 1
  /** Upload attempts the cloud rejected (not network failures). */
  attempts?: number
  lastError?: string | null
  nextAttemptAt?: number
  /** An admin gave up on uploading it: kept for this PC only. */
  skipped?: boolean
}

export type Credential = {
  user_id: string
  username: string
  salt: string
  hash: string
  iterations: number
  updated_at: string
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const t of TABLES) {
        if (db.objectStoreNames.contains(t.name)) continue
        const store = db.createObjectStore(t.name, { keyPath: t.key.length === 1 ? t.key[0] : t.key })
        for (const idx of t.indexes ?? []) store.createIndex(idx, idx, { unique: false })
      }
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true })
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(IMAGES)) {
        const s = db.createObjectStore(IMAGES, { keyPath: 'path' })
        s.createIndex('uploaded', 'uploaded', { unique: false })
      }
      if (!db.objectStoreNames.contains(CREDENTIALS)) db.createObjectStore(CREDENTIALS, { keyPath: 'user_id' })
    }
    req.onsuccess = () => {
      const db = req.result
      // Another tab upgraded the schema: let it proceed, reopen lazily.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('Local database is open in another window with an older version.'))
  })
  return dbPromise
}

function wrap<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Local transaction aborted'))
    tx.onerror = () => reject(tx.error ?? new Error('Local transaction failed'))
  })
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function getAll<T = Row>(store: string): Promise<T[]> {
  const db = await openDb()
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>
}

export async function getOne<T = Row>(store: string, key: IDBValidKey): Promise<T | null> {
  const db = await openDb()
  const v = await wrap(db.transaction(store, 'readonly').objectStore(store).get(key))
  return (v as T | undefined) ?? null
}

export async function getByIndex<T = Row>(store: string, index: string, value: IDBValidKey): Promise<T[]> {
  const db = await openDb()
  return wrap(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(value)) as Promise<T[]>
}

export async function count(store: string): Promise<number> {
  const db = await openDb()
  return wrap(db.transaction(store, 'readonly').objectStore(store).count())
}

// ---------------------------------------------------------------------------
// the write primitive
// ---------------------------------------------------------------------------

/**
 * `remote` = the change was committed by ANOTHER window of the app on this PC
 * (told via BroadcastChannel): caches must refresh, but that window owns the
 * sync kick.
 */
type CommitListener = (tables: Set<string>, outboxed: boolean, remote?: boolean) => void
const listeners = new Set<CommitListener>()

/** Called after every successful commit (cache invalidation, sync kick). */
export function onCommit(fn: CommitListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(tables: Set<string>, outboxed: boolean, remote: boolean) {
  for (const fn of listeners) {
    try {
      fn(tables, outboxed, remote)
    } catch {
      // a listener must never break a committed write
    }
  }
}

// Several windows of the app (installed PWA + a browser tab) share one
// database; tell the others when this one changes it.
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lensypos-local') : null
channel?.addEventListener('message', (e: MessageEvent<{ tables?: string[] }>) => {
  if (Array.isArray(e.data?.tables)) notify(new Set(e.data.tables), false, true)
})

function broadcast(tables: Set<string>) {
  try {
    channel?.postMessage({ tables: [...tables] })
  } catch {
    // closed channel - other windows refresh on their next read
  }
}

/**
 * Run `fn` while holding a lock shared by every window of the app on this PC
 * (Web Locks API). Falls back to running unlocked where the API is missing.
 * `ifAvailable` = skip (return null) instead of waiting when another window
 * holds it.
 */
export async function withLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { ifAvailable?: boolean } = {},
): Promise<T | null> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return fn()
  if (opts.ifAvailable) {
    return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? fn() : null))
  }
  return locks.request(name, fn)
}

/** Monotonic counter bumped by every replicated commit (restore race guard). */
export async function commitSeq(): Promise<number> {
  return (await metaGet<number>('commitSeq')) ?? 0
}

/** Drop joined/computed props so only real columns are stored and replicated. */
export function cleanRow(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if ((NON_COLUMN_PROPS as readonly string[]).includes(k)) continue
    if (v === undefined) continue
    out[k] = v
  }
  return out
}

function keyOf(row: Row, key: string[]): IDBValidKey {
  if (key.length === 1) return row[key[0]] as IDBValidKey
  return key.map((k) => row[k] as IDBValidKey)
}

function pick(row: Row, cols: string[]): Row {
  const out: Row = {}
  for (const c of cols) out[c] = row[c]
  return out
}

/**
 * Apply row changes to the local mirror and enqueue them for replication, all
 * in one transaction. Changes are applied (and later replayed) in array order,
 * so put child deletes before parent deletes and parents before children on
 * insert.
 */
export async function commit(changes: Change[]): Promise<void> {
  const real = changes.filter((c) => c.rows.length > 0)
  if (!real.length) return
  const db = await openDb()
  const stores = new Set(real.map((c) => c.table))
  const outboxed = real.some((c) => !c.localOnly)
  if (outboxed) {
    stores.add(OUTBOX)
    stores.add(META)
  }
  const tx = db.transaction([...stores], 'readwrite')
  const finished = done(tx)
  const now = new Date().toISOString()
  try {
    for (const c of real) {
      const def = c.table === META ? null : tableDef(c.table)
      const store = tx.objectStore(c.table)
      const rows = def ? c.rows.map(cleanRow) : c.rows
      for (const row of rows) {
        if (c.op === 'upsert') store.put(row)
        else store.delete(def ? keyOf(row, def.key) : (row.key as IDBValidKey))
      }
      if (!c.localOnly && def) {
        const entry: OutboxEntry = {
          uid: uuid(),
          table: c.table,
          op: c.op,
          key: def.key,
          rows: c.op === 'upsert' ? rows : rows.map((r) => pick(r, def.key)),
          createdAt: now,
          attempts: 0,
        }
        tx.objectStore(OUTBOX).add(entry)
      }
    }
    if (outboxed) {
      // Bump the commit counter in the SAME transaction (restore-from-cloud
      // uses it to detect a change made while it was downloading).
      const meta = tx.objectStore(META)
      const req = meta.get('commitSeq')
      req.onsuccess = () => {
        const cur = (req.result as { value?: number } | undefined)?.value ?? 0
        meta.put({ key: 'commitSeq', value: cur + 1 })
      }
    }
  } catch (e) {
    // put()/delete() can throw synchronously (e.g. a row without its key):
    // abort so a half-applied change can never auto-commit.
    try {
      tx.abort()
    } catch {
      // already finished
    }
    await finished.catch(() => undefined)
    throw e
  }
  await finished
  const tables = new Set(real.map((c) => c.table))
  notify(tables, outboxed, false)
  broadcast(tables)
}

// ---------------------------------------------------------------------------
// meta (key/value bookkeeping, never replicated)
// ---------------------------------------------------------------------------

export async function metaGet<T>(key: string): Promise<T | null> {
  const row = await getOne<{ key: string; value: T }>(META, key)
  return row ? row.value : null
}

export async function metaSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(META, 'readwrite')
  tx.objectStore(META).put({ key, value })
  await done(tx)
}

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

export async function outboxPeek(limit: number): Promise<OutboxEntry[]> {
  const db = await openDb()
  const store = db.transaction(OUTBOX, 'readonly').objectStore(OUTBOX)
  return wrap(store.getAll(null, limit)) as Promise<OutboxEntry[]>
}

export async function outboxCount(): Promise<number> {
  return count(OUTBOX)
}

export async function outboxDelete(seqs: number[]): Promise<void> {
  if (!seqs.length) return
  const db = await openDb()
  const tx = db.transaction(OUTBOX, 'readwrite')
  const s = tx.objectStore(OUTBOX)
  for (const seq of seqs) s.delete(seq)
  await done(tx)
}

/**
 * Merge `patch` into an outbox entry ONLY if it is still queued - a failed
 * push must never bring back an entry another window already sent or an
 * admin skipped meanwhile.
 */
export async function outboxUpdateIfPresent(seq: number, patch: Partial<OutboxEntry>): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(OUTBOX, 'readwrite')
  const store = tx.objectStore(OUTBOX)
  const req = store.get(seq)
  req.onsuccess = () => {
    if (req.result) store.put({ ...(req.result as OutboxEntry), ...patch, seq })
  }
  await done(tx)
}

/**
 * Skip the entry at the head of the outbox, but only if it is still the one
 * with `seq` (the one whose error the admin read). The skipped entry is kept
 * in meta 'skippedEntries'. Atomic; returns false if the head changed.
 */
export async function outboxSkipHead(seq: number): Promise<boolean> {
  const db = await openDb()
  const tx = db.transaction([OUTBOX, META], 'readwrite')
  const finished = done(tx)
  let skipped = false
  const outbox = tx.objectStore(OUTBOX)
  const head = outbox.getAll(null, 1)
  head.onsuccess = () => {
    const entry = (head.result as OutboxEntry[])[0]
    if (!entry || entry.seq !== seq) return
    const meta = tx.objectStore(META)
    const prev = meta.get('skippedEntries')
    prev.onsuccess = () => {
      const list = ((prev.result as { value?: OutboxEntry[] } | undefined)?.value ?? []).slice(-200)
      meta.put({ key: 'skippedEntries', value: [...list, { ...entry, skippedAt: new Date().toISOString() }] })
      outbox.delete(seq)
      skipped = true
    }
  }
  await finished
  return skipped
}

// ---------------------------------------------------------------------------
// images (offline uploads + local copies for offline viewing)
// ---------------------------------------------------------------------------

export async function putImage(img: StoredImage): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(IMAGES, 'readwrite')
  tx.objectStore(IMAGES).put(img)
  await done(tx)
}

export async function pendingImages(): Promise<StoredImage[]> {
  return getByIndex<StoredImage>(IMAGES, 'uploaded', 0)
}

// ---------------------------------------------------------------------------
// credentials (offline password verifiers, never replicated)
// ---------------------------------------------------------------------------

export async function putCredential(c: Credential): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(CREDENTIALS, 'readwrite')
  tx.objectStore(CREDENTIALS).put(c)
  await done(tx)
}

export async function deleteCredential(userId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(CREDENTIALS, 'readwrite')
  tx.objectStore(CREDENTIALS).delete(userId)
  await done(tx)
}

// ---------------------------------------------------------------------------
// bulk replace (initial download, restore-from-cloud, import backup)
// ---------------------------------------------------------------------------

/**
 * Replace the full contents of the given stores in one transaction. Stores not
 * named in `data` are left untouched.
 *
 * `expectCommitSeq`: refuse (nothing is replaced) if any replicated change was
 * committed since that counter value was read, or if the outbox is not empty -
 * checked inside the same transaction, so no sale can slip in between.
 */
export async function replaceStores(
  data: Record<string, Row[]>,
  opts: { expectCommitSeq?: number } = {},
): Promise<void> {
  const names = Object.keys(data)
  if (!names.length) return
  const guarded = opts.expectCommitSeq !== undefined
  const db = await openDb()
  const all = new Set(names)
  if (guarded) {
    all.add(META)
    all.add(OUTBOX)
  }
  const tx = db.transaction([...all], 'readwrite')
  const finished = done(tx)
  let refused: string | null = null

  const apply = () => {
    try {
      for (const name of names) {
        const store = tx.objectStore(name)
        store.clear()
        const def = TABLES.find((t) => t.name === name)
        for (const row of data[name]) store.put(def ? cleanRow(row) : row)
      }
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e)
      tx.abort()
    }
  }

  if (guarded) {
    const seqReq = tx.objectStore(META).get('commitSeq')
    seqReq.onsuccess = () => {
      const seq = (seqReq.result as { value?: number } | undefined)?.value ?? 0
      const countReq = tx.objectStore(OUTBOX).count()
      countReq.onsuccess = () => {
        if (seq !== opts.expectCommitSeq || countReq.result > 0) {
          refused = 'A change was made on this computer during the download. Try again.'
          tx.abort()
          return
        }
        apply()
      }
    }
  } else {
    apply()
  }

  try {
    await finished
  } catch (e) {
    throw new Error(refused ?? (e instanceof Error ? e.message : String(e)))
  }
  const tables = new Set(names)
  notify(tables, false, false)
  broadcast(tables)
}

/** Read several stores in ONE transaction (a consistent snapshot). */
export async function snapshot(names: string[]): Promise<Record<string, Row[]>> {
  const db = await openDb()
  const tx = db.transaction(names, 'readonly')
  const out: Record<string, Row[]> = {}
  await Promise.all(
    names.map(async (n) => {
      out[n] = (await wrap(tx.objectStore(n).getAll())) as Row[]
    }),
  )
  return out
}

/** Every store name in the local database (backup / export). */
export function allStoreNames(): string[] {
  return [...TABLES.map((t) => t.name), OUTBOX, META, IMAGES, CREDENTIALS]
}
