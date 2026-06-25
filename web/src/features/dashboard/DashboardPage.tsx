import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

/**
 * Dashboard placeholder + live backend probe. Runs as the signed-in
 * (authenticated) user, so with the Phase 2 RLS policies applied it should
 * return real table counts — confirming auth + RLS are wired correctly.
 * If you somehow reach here without a session, RLS returns errors/0.
 */
function useBackendProbe() {
  return useQuery({
    queryKey: ['backend-probe'],
    queryFn: async () => {
      const tables = ['customers', 'inventory', 'sales'] as const
      const results: Record<string, number | string> = {}
      for (const t of tables) {
        const { count, error } = await supabase
          .from(t)
          .select('*', { count: 'exact', head: true })
        results[t] = error ? `err: ${error.message}` : (count ?? 0)
      }
      return results
    },
  })
}

const cards = [
  { label: 'New Sale', hint: 'POS wizard', accent: 'bg-brand' },
  { label: 'Customers', hint: 'Manage', accent: 'bg-success' },
  { label: 'Inventory', hint: 'Stock', accent: 'bg-warning' },
  { label: 'Reports', hint: 'Insights', accent: 'bg-brand-dark' },
]

export function DashboardPage() {
  const probe = useBackendProbe()

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">Dashboard</h1>
      <p className="mb-6 text-sm text-muted">Phase 1 shell — screens land in later phases.</p>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="cursor-pointer rounded-xl bg-white p-5 shadow-sm transition hover:shadow-md"
          >
            <div className={`mb-3 h-10 w-10 rounded-lg ${c.accent}`} />
            <div className="font-semibold">{c.label}</div>
            <div className="text-sm text-faint">{c.hint}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">Backend connectivity (live Supabase)</h2>
        {probe.isLoading && <p className="text-sm text-muted">Probing…</p>}
        {probe.isError && (
          <p className="text-sm text-danger">Probe failed: {String(probe.error)}</p>
        )}
        {probe.data && (
          <ul className="space-y-1 text-sm">
            {Object.entries(probe.data).map(([table, val]) => (
              <li key={table} className="flex justify-between border-b border-line/40 py-1">
                <span className="text-muted">{table}</span>
                <span className="font-mono">{String(val)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
