import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCustomers, useCustomerSearch } from '../../data/customers'
import { useI18n } from '../../i18n/LanguageContext'

/** Customers list + search (read-only for now). */
export function CustomersPage() {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const [term, setTerm] = useState(params.get('q') ?? '')
  const all = useCustomers()
  const search = useCustomerSearch(term)

  const searching = term.trim().length >= 2
  const active = searching ? search : all
  const customers = active.data ?? []

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">{t('Customers')}</h1>
      <p className="mb-5 text-sm text-muted">
        {all.data ? `${all.data.length} ${t('total')}` : t('Loading…')}
      </p>

      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder={t('Search by name…')}
        className="mb-4 w-full rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
      />

      {active.isLoading && <p className="text-sm text-muted">{t('Loading…')}</p>}

      {active.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t("Couldn't load customers:")} {String(active.error)}
          <div className="mt-1 text-xs text-muted">
            {t('Expected until you finish the Phase 2 Supabase setup (RLS + login).')}
          </div>
        </div>
      )}

      {!active.isLoading && !active.isError && customers.length === 0 && (
        <p className="text-sm text-faint">
          {searching ? t('No matches.') : t('No customers yet.')}
        </p>
      )}

      <ul className="divide-y divide-line/40 overflow-hidden rounded-xl bg-white shadow-sm">
        {customers.map((c) => (
          <li key={c.id}>
            <Link
              to={`/customers/${c.id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-surface"
            >
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-faint">{c.city || '—'}</div>
              </div>
              <div className="text-sm text-muted">{c.phone || ''}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
