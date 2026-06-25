import { useState } from 'react'
import { useCustomers, useCustomerSearch } from '../../data/customers'

/**
 * First real data-driven screen — proves the Phase 3 data layer works
 * (typed Query hooks → Supabase). Read-only for now; add/edit lands in Phase 5.
 * Returns data only once RLS + a signed-in session are set up (Phase 2 runbook).
 */
export function CustomersPage() {
  const [term, setTerm] = useState('')
  const all = useCustomers()
  const search = useCustomerSearch(term)

  const searching = term.trim().length >= 2
  const active = searching ? search : all
  const customers = active.data ?? []

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">Customers</h1>
      <p className="mb-5 text-sm text-muted">
        {all.data ? `${all.data.length} total` : 'Loading…'}
      </p>

      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search by name…"
        className="mb-4 w-full rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
      />

      {active.isLoading && <p className="text-sm text-muted">Loading customers…</p>}

      {active.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          Couldn't load customers: {String(active.error)}
          <div className="mt-1 text-xs text-muted">
            Expected until you finish the Phase 2 Supabase setup (RLS + login).
          </div>
        </div>
      )}

      {!active.isLoading && !active.isError && customers.length === 0 && (
        <p className="text-sm text-faint">
          {searching ? 'No matches.' : 'No customers yet.'}
        </p>
      )}

      <ul className="divide-y divide-line/40 overflow-hidden rounded-xl bg-white shadow-sm">
        {customers.map((c) => (
          <li key={c.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="font-medium">{c.name}</div>
              <div className="text-sm text-faint">{c.city || '—'}</div>
            </div>
            <div className="text-sm text-muted">{c.phone || ''}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
