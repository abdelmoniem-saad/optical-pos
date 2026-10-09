import { describe, expect, it, vi } from 'vitest'

/** The drift signal is only as good as its edge cases. A banner that nags a
 *  shop whose database is fine, or that stays quiet through a real drift,
 *  trains people to ignore it — which makes it worse than no banner at all.
 *  So the three states are pinned here rather than left to inspection. */
const rpc = vi.hoisted(() => vi.fn())

vi.mock('./supabase', () => ({ supabase: { rpc } }))

const { EXPECTED_SCHEMA_VERSION, toState } = await import('./schemaVersion')

/** Called with a stubbed RPC. `toState` is the unit under test — it is
 *  exported separately from the hook precisely so it can be exercised without
 *  a React context, which is where the interesting decisions live. */
async function fetchState() {
  const { data, error } = await rpc('schema_version')
  if (error) {
    const { isMissingRpc } = await import('../data/rpc')
    if (isMissingRpc('schema_version', error)) return toState(null)
    throw error
  }
  return toState(data)
}

describe('schema version', () => {
  it('reports ok when the database is at least as new as this build', async () => {
    rpc.mockResolvedValue({ data: EXPECTED_SCHEMA_VERSION, error: null })
    expect(await fetchState()).toEqual({ state: 'ok', version: EXPECTED_SCHEMA_VERSION })
  })

  it('reports ok when the database is NEWER than this build', async () => {
    // A shop that upgraded the SQL first, or a newer app on an older tab. A
    // banner here would be wrong and would accuse the user of a mistake.
    rpc.mockResolvedValue({ data: 99, error: null })
    expect(await fetchState()).toEqual({ state: 'ok', version: 99 })
  })

  it('reports behind — with the real number — when the database is older', async () => {
    rpc.mockResolvedValue({ data: 12, error: null })
    expect(await fetchState()).toEqual({ state: 'behind', version: 12 })
  })

  it('reports behind at version 0, i.e. 017 was never applied', async () => {
    // The empty-ledger case the gate's G-S4 protects. 0 must be "behind",
    // never "ok" and never "unknown": this shop has the least data of all.
    rpc.mockResolvedValue({ data: 0, error: null })
    expect(await fetchState()).toEqual({ state: 'behind', version: 0 })
  })

  it('is silent — not alarming — when the function does not exist yet', async () => {
    // Every shop that updates the app before the SQL hits this. It is the
    // normal, working state, and shouting about it would be a false alarm on
    // day one of every release.
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'function schema_version does not exist' },
    })
    expect(await fetchState()).toEqual({ state: 'unknown', version: null })
  })

  it('surfaces a real error rather than inventing a drift verdict', async () => {
    // Deliberately NOT swallowed into 'unknown'. A dropped connection is a
    // fact worth having in the console; the banner is still silent either way
    // (a failed query has no data, and it renders nothing), but the error is
    // no longer hidden behind a shrug. The important half is what it does NOT
    // do: return 'behind', which would send staff to re-run a migration they
    // have already applied.
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'connection failure' } })
    await expect(fetchState()).rejects.toThrow('connection failure')
  })

  it('accepts a numeric string, because PostgREST may hand back text', async () => {
    rpc.mockResolvedValue({ data: '12', error: null })
    expect(await fetchState()).toEqual({ state: 'behind', version: 12 })
  })

  it('treats a non-numeric answer as unknown, never as 0', async () => {
    // Number(null) is 0, and 0 reads as "behind" — a null response would
    // otherwise masquerade as the most alarming possible answer.
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await fetchState()).toEqual({ state: 'unknown', version: null })
  })

  it('keeps the app constant in step with the migration it names', () => {
    // The whole point of the check: if someone adds a migration and does NOT bump
    // this, the banner goes permanently quiet, and nothing else in the codebase
    // would notice. This failed once already - 018 and 019 shipped without
    // recording their versions, so the database kept answering 17 and this
    // constant still said 17, and the two agreed perfectly while the drift check
    // was blind. Migration 020 makes the omission a red build; this test makes the
    // bump one. Adding 021 (the first-platform-admin bootstrap) is the first
    // time this number moved for a reason that was not a money fix, and the 020
    // SQL gate's own "equals 20" assertion had to be relaxed at the same time -
    // a hardcoded version inside a migration gate goes stale on every migration,
    // which is why the half of this invariant that MOVES is asserted here.
    // 022 (sales.kind) is the second such bump, and the mechanism held: this
    // test is what noticed, not the banner.
    // 026 (the licence window) is the third: the migration recorded version 26
    // in the database, but this constant was left at 25 - so a shop that had not
    // applied 026 read 25 < 25 = 'ok' and was silently told it was current. The
    // database number and the app number move together, or the banner lies.
    // 027 (plan feature flags) is the fourth: license_feature() and the
    // platform report now read store_licenses.features, which 008 created and
    // nothing had ever read - a column that looked configurable and governed
    // nothing. The mechanism held again: this test is what noticed.
    // 028 (partial refund) is the fifth: refund_sale() returns PART of a live
    // sale on one tender, where void_sale (013/014) reverses the whole thing.
    expect(EXPECTED_SCHEMA_VERSION).toBe(28)
  })
})
