/** A small, durable record of checkouts that went into the offline queue.
 *
 * The queue itself lives in the persisted query cache ('lensy-query-cache'),
 * which only keeps PAUSED mutations: once a queued checkout is replayed and the
 * server REFUSES it (price changed, out of stock, licence...), it leaves the
 * queue, and if the wizard that rang it up has moved on - or the page was
 * reloaded and no wizard is attached at all - nothing ever said so. The same
 * goes for a queue thrown away by signing out or by the 24 h cache limit. The
 * cashier was told "Saved on this device", so a silent loss is the worst
 * outcome. This journal is kept under its OWN key (sign-out clears the cache
 * key, not this one) and the banner shows every entry that did not make it,
 * until someone dismisses it.
 *
 * Only checkouts that were actually queued are recorded; an online checkout
 * that fails is reported by the wizard on the spot. */

export const CHECKOUT_JOURNAL_KEY = 'lensy-checkout-journal'
const MAX_ENTRIES = 50

export type JournalEntry = {
  /** The checkout's idempotency key. */
  key: string
  invoiceNo: string | null
  net: number | null
  /** When it was first seen in the queue (ISO). */
  at: string
  status: 'queued' | 'failed' | 'lost'
  /** Server message for 'failed'. */
  message?: string
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

const listeners = new Set<() => void>()
let cache: { raw: string | null; entries: JournalEntry[] } = { raw: null, entries: [] }

function storage(): Store | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function readJournal(s: Store | null = storage()): JournalEntry[] {
  let raw: string | null = null
  try {
    raw = s?.getItem(CHECKOUT_JOURNAL_KEY) ?? null
  } catch {
    return cache.entries
  }
  if (raw === cache.raw) return cache.entries
  let entries: JournalEntry[] = []
  try {
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) entries = parsed.filter((e) => e && typeof e.key === 'string')
  } catch {
    entries = []
  }
  cache = { raw, entries }
  return entries
}

function write(entries: JournalEntry[], s: Store | null = storage()): void {
  const kept = entries.slice(-MAX_ENTRIES)
  try {
    s?.setItem(CHECKOUT_JOURNAL_KEY, JSON.stringify(kept))
  } catch {
    // Storage full or blocked: the journal is a safety net, never a reason to fail.
  }
  listeners.forEach((l) => l())
}

/** Replace this key's entry with f(prev): an entry, null to delete it, or prev
 *  itself (including undefined) to change nothing. */
function update(
  key: string,
  f: (e: JournalEntry | undefined) => JournalEntry | null | undefined,
  s?: Store | null,
): void {
  const all = readJournal(s ?? storage())
  const prev = all.find((e) => e.key === key)
  const next = f(prev)
  if (next === prev) return
  const rest = all.filter((e) => e.key !== key)
  write(next ? [...rest, next] : rest, s ?? storage())
}

/** A checkout is held in the queue. Idempotent; a failed attempt retried with
 *  the same key (the wizard keeps its key until the sale is saved) is queued
 *  again. */
export function markQueued(
  e: { key: string; invoiceNo?: string | null; net?: number | null; at?: string },
  s?: Store | null,
): void {
  update(e.key, (prev) =>
    prev?.status === 'queued'
      ? prev
      : {
          key: e.key,
          invoiceNo: e.invoiceNo ?? prev?.invoiceNo ?? null,
          net: e.net ?? prev?.net ?? null,
          at: prev?.at ?? e.at ?? new Date().toISOString(),
          status: 'queued',
        }, s)
}

/** The server has the sale: forget it. */
export function markSaved(key: string, s?: Store | null): void {
  update(key, () => null, s)
}

/** A queued checkout was refused when it was replayed. */
export function markFailed(key: string, message: string, s?: Store | null): void {
  update(key, (prev) => (prev ? { ...prev, status: 'failed', message } : prev), s)
}

/** A queued checkout left the queue without reaching the server. */
export function markLost(key: string, s?: Store | null): void {
  update(key, (prev) => (prev && prev.status === 'queued' ? { ...prev, status: 'lost' } : prev), s)
}

export function dismissJournalEntry(key: string, s?: Store | null): void {
  markSaved(key, s)
}

/** True if this attempt was ever held in the queue (and is not yet saved). */
export function wasQueued(key: string, s?: Store | null): boolean {
  return readJournal(s ?? storage()).some((e) => e.key === key)
}

/** After the cache is restored on boot: an entry still 'queued' whose checkout
 *  is no longer held (`stillQueued` false) was thrown away with the cache. */
export function reconcileJournal(stillQueued: (key: string) => boolean, s?: Store | null): void {
  for (const e of readJournal(s ?? storage())) {
    if (e.status === 'queued' && !stillQueued(e.key)) markLost(e.key, s)
  }
}

export function subscribeJournal(l: () => void): () => void {
  listeners.add(l)
  const onStorage = (ev: StorageEvent) => {
    if (ev.key === CHECKOUT_JOURNAL_KEY) l()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(l)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}
