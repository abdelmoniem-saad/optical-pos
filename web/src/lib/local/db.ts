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

type CommitListener = (tables: Set<string>, outboxed: boolean) => void
const listeners = new Set<CommitListener>()

/** Called after every successful commit (cache invalidation, sync kick). */
export function onCommit(fn: CommitListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
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
  if (outboxed) stores.add(OUTBOX)
  const tx = db.transaction([...stores], 'readwrite')
  const now = new Date().toISOString()
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
  await done(tx)
  const tables = new Set(real.map((c) => c.table))
  for (const fn of listeners) {
    try {
      fn(tables, outboxed)
    } catch {
      // a listener must never break a committed write
    }
  }
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

export async function outboxPut(entry: OutboxEntry): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(OUTBOX, 'readwrite')
  tx.objectStore(OUTBOX).put(entry)
  await done(tx)
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

// ---------------------------------------------------------------------------
// bulk replace (initial download, restore-from-cloud, import backup)
// ---------------------------------------------------------------------------

/**
 * Replace the full contents of the given stores in one transaction. Stores not
 * named in `data` are left untouched.
 */
export async function replaceStores(data: Record<string, Row[]>): Promise<void> {
  const names = Object.keys(data)
  if (!names.length) return
  const db = await openDb()
  const tx = db.transaction(names, 'readwrite')
  for (const name of names) {
    const store = tx.objectStore(name)
    store.clear()
    const def = TABLES.find((t) => t.name === name)
    for (const row of data[name]) store.put(def ? cleanRow(row) : row)
  }
  await done(tx)
  for (const fn of listeners) {
    try {
      fn(new Set(names), false)
    } catch {
      // ignore
    }
  }
}

/** Every store name in the local database (backup / export). */
export function allStoreNames(): string[] {
  return [...TABLES.map((t) => t.name), OUTBOX, META, IMAGES, CREDENTIALS]
}
