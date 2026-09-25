/**
 * In-progress sale draft.
 *
 * The New Sale wizard is the ONE piece of state a cashier cannot recreate, so
 * it is mirrored into sessionStorage in addition to the module-level memory
 * snapshot in POSContext:
 *   • memoryState       survives tab switches (same page, no reload)
 *   • sessionStorage    survives a reload / crash-restore of the same tab
 *
 * The draft is namespaced by BOTH the signed-in user and the store, so two
 * shops or two accounts sharing one tablet can never inherit each other's
 * half-built order.
 */
export const POS_DRAFT_KEY = 'lensy-pos-draft-v1'

type StoredDraft<T> = {
  userId: string | null
  storeId: string | null
  state: T
}

/** The draft for this user + store, or null (missing / foreign / corrupt). */
export function readPosDraft<T>(userId: string | null, storeId: string | null): T | null {
  try {
    const raw = sessionStorage.getItem(POS_DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredDraft<T>>
    if ((parsed.userId ?? null) !== (userId ?? null)) return null
    if ((parsed.storeId ?? null) !== (storeId ?? null)) return null
    return parsed.state ?? null
  } catch {
    // Corrupt payload (or storage blocked) - never break the wizard over it.
    return null
  }
}

export function writePosDraft<T>(userId: string | null, storeId: string | null, state: T): void {
  try {
    sessionStorage.setItem(POS_DRAFT_KEY, JSON.stringify({ userId, storeId, state }))
  } catch {
    // Quota / private-mode failures must not interrupt a sale.
  }
}

export function clearPosDraft(): void {
  try {
    sessionStorage.removeItem(POS_DRAFT_KEY)
  } catch {
    // ignore
  }
}
