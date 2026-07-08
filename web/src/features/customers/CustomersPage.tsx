import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  useCustomers,
  useCustomerSearchExtended,
  useDeleteCustomer,
} from '../../data/customers'
import { useIsAdmin } from '../../data/staff'
import { useI18n } from '../../i18n/LanguageContext'

/** Customers list + search. Customers are created only by making an order
 *  (POS wizard), so there is no "Add Customer" action here. Deletion is
 *  restricted to Admin/Owner roles and gracefully surfaces the FK error
 *  when a customer has existing orders or prescriptions. */
export function CustomersPage() {
  const { t, lang } = useI18n()
  const [params] = useSearchParams()
  const [term, setTerm] = useState(params.get('q') ?? '')
  const all = useCustomers()
  const search = useCustomerSearchExtended(term)
  const del = useDeleteCustomer()
  const isAdmin = useIsAdmin()

  const searching = term.trim().length >= 2
  const active = searching ? search : all
  const rows = (active.data ?? []).map((c) => ({
    ...c,
    matchedDoctors:
      (c as { matchedDoctors?: string[] }).matchedDoctors ?? [],
  }))

  async function onDelete(id: string, name: string) {
    if (!window.confirm(t('Delete customer') + ` "${name}"?`)) return
    try {
      await del.mutateAsync(id)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  const drPrefix = lang === 'ar' ? 'د.' : 'Dr.'

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Customers')}</h1>
      </div>
      <p className="mb-5 text-sm text-muted">
        {all.data ? `${all.data.length} ${t('total')}` : t('Loading…')}
      </p>

      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder={t('Search by name, city, phone or doctor…')}
        className="mb-4 w-full rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
      />

      {active.isLoading && <p className="text-sm text-muted">{t('Loading…')}</p>}

      {active.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t("Couldn't load customers:")} {String(active.error)}
        </div>
      )}

      {!active.isLoading && !active.isError && rows.length === 0 && (
        <p className="text-sm text-faint">
          {searching ? t('No matches.') : t('No customers yet.')}
        </p>
      )}

      <ul className="divide-y divide-line/40 overflow-hidden rounded-xl bg-white shadow-sm">
        {rows.map((c) => (
          <li key={c.id} className="flex items-center hover:bg-surface">
            <Link
              to={`/customers/${c.id}`}
              className="flex flex-1 items-start justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-faint">{c.city || '—'}</div>
              </div>
              <div className="text-end text-sm">
                <div className="text-muted">{c.phone || ''}</div>
                {c.matchedDoctors.length > 0 && (
                  <div className="mt-0.5 text-xs text-faint">
                    {c.matchedDoctors.map((d, i) => (
                      <div key={`${d}-${i}`}>
                        {drPrefix} {d}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Link>
            {isAdmin && (
              <button
                onClick={() => onDelete(c.id, c.name)}
                disabled={del.isPending}
                title={t('Delete')}
                className="mx-2 rounded-md px-2 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-40"
              >
                🗑
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
