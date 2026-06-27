import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n/LanguageContext'

/** Dashboard overview + a live backend probe (counts a few tables as the
 *  signed-in user, confirming auth + RLS are wired). */
function useBackendProbe() {
  return useQuery({
    queryKey: ['backend-probe'],
    queryFn: async () => {
      const tables = ['customers', 'inventory', 'sales'] as const
      const results: Record<string, number | string> = {}
      for (const tbl of tables) {
        const { count, error } = await supabase
          .from(tbl)
          .select('*', { count: 'exact', head: true })
        results[tbl] = error ? `err` : (count ?? 0)
      }
      return results
    },
  })
}

const cards = [
  { to: '/pos', label: 'New Sale', hint: 'POS wizard', accent: 'bg-brand' },
  { to: '/customers', label: 'Customers', hint: 'Manage', accent: 'bg-success' },
  { to: '/inventory', label: 'Inventory', hint: 'Stock', accent: 'bg-warning' },
  { to: '/reports', label: 'Reports', hint: 'Insights', accent: 'bg-brand-dark' },
]

export function DashboardPage() {
  const { t } = useI18n()
  const probe = useBackendProbe()

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">{t('Dashboard')}</h1>
      <p className="mb-6 text-sm text-muted">{t('Quick actions')}</p>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {cards.map((c) => (
          <Link
            key={c.label}
            to={c.to}
            className="block rounded-xl bg-white p-5 shadow-sm transition hover:shadow-md"
          >
            <div className={`mb-3 h-10 w-10 rounded-lg ${c.accent}`} />
            <div className="font-semibold">{t(c.label)}</div>
            <div className="text-sm text-faint">{t(c.hint)}</div>
          </Link>
        ))}
      </div>

      <div className="rounded-xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">{t('Overview')}</h2>
        {probe.isLoading && <p className="text-sm text-muted">{t('Loading…')}</p>}
        {probe.data && (
          <ul className="space-y-1 text-sm">
            {Object.entries(probe.data).map(([table, val]) => (
              <li key={table} className="flex justify-between border-b border-line/40 py-1">
                <span className="text-muted">{t(table.charAt(0).toUpperCase() + table.slice(1))}</span>
                <span className="font-mono">{String(val)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
