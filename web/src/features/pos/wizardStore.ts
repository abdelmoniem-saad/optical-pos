// Persistence of the New Sale wizard: it survives tab switches (module memory)
// AND reloads/power cuts (localStorage). The snapshot is tagged with the
// signed-in staff member, so it is never shown to someone else, and it is
// cleared on sign-out. Dependency-free so auth.tsx can clear it.
const WIZARD_KEY = 'lensy-pos-wizard'

type Snapshot = { owner: string | null; state: unknown }

let memory: Snapshot | null = null

export function loadWizard<T>(owner: string | null): T | null {
  if (memory) return memory.owner === owner ? (memory.state as T) : null
  try {
    const raw = localStorage.getItem(WIZARD_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Partial<Snapshot>
    if (!saved || !('owner' in saved) || saved.owner !== owner || !saved.state) return null
    return saved.state as T
  } catch {
    return null
  }
}

/** `empty` = nothing worth keeping (fresh wizard): drop the stored copy. */
export function saveWizard(owner: string | null, state: unknown, stored: unknown, empty: boolean): void {
  memory = { owner, state }
  try {
    if (empty) localStorage.removeItem(WIZARD_KEY)
    else localStorage.setItem(WIZARD_KEY, JSON.stringify({ owner, state: stored }))
  } catch {
    // storage full/blocked - the in-memory snapshot still covers tab switches
  }
}

/** Forget any open order (sign-out). */
export function clearPersistedWizard(): void {
  memory = null
  try {
    localStorage.removeItem(WIZARD_KEY)
  } catch {
    // ignore
  }
}
