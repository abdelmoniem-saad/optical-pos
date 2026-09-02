import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  CustomerHasRelatedRecordsError,
  useCustomerSearchExtended,
  useDeleteCustomer,
  useInfiniteCustomers,
} from '../../data/customers'
import { useIsAdmin } from '../../data/staff'
import { usePermissions } from '../../data/permissions'
import { useI18n } from '../../i18n/LanguageContext'

/** Customers list + search. The DEFAULT list is paged server-side and grows
 *  via "Load more"; search runs entirely server-side with hard limits, so
 *  neither path slows down as the tables grow. Deletion is restricted to
 *  Admin/Owner roles (or a granted customers.delete permission). */
export function CustomersPage() {
  const { t, lang } = useI18n()
  const [params] = useSearchParams()
  const [term, setTerm] = useState(params.get('q') ?? '')
  const all = useInfiniteCustomers()
  const search = useCustomerSearchExtended(term)
  const del = useDeleteCustomer()
  // Admins always can; otherwise a granted customers.delete permission works.
  const perms = usePermissions()
  const isAdmin = useIsAdmin() || perms.can('customers.delete' as never)

  const searching = term.trim().length >= 2
  const rows = useMemo(() => {
    if (searching) {
      return (search.data ?? []).map((c) => ({
        ...c,
        matchedDoctors: c.matchedDoctors ?? [],
      }))
    }
    return (all.data?.pages.flatMap((p) => p.rows) ?? []).map((c) => ({
      ...c,
      matchedDoctors: [] as string[],
    }))
  }, [searching, search.data, all.data])
  const total = searching
    ? rows.length
    : (all.data?.pages[all.data.pages.length - 1]?.count ?? 0)
  const active = searching ? search : all

  async function onDelete(id: string, name: string) {
    if (!window.confirm(t('Delete customer') + ` "${name}"?`)) return
    try {
      await del.mutateAsync({ id })
    } catch (e) {
      if (e instanceof CustomerHasRelatedRecordsError) {
        // The customer has orders and/or prescriptions. Explain the impact
        // and let the user confirm a cascading delete — otherwise the row
        // can never be removed because of the sales FK.
        const parts: string[] = []
        if (e.orderCount > 0) {
          parts.push(`${e.orderCount} ${t('orders')}`)
        }
        if (e.prescriptionCount > 0) {
          parts.push(`${e.prescriptionCount} ${t('prescriptions')}`)
        }
        const summary = parts.join(' ' + t('and') + ' ')
        const message =
          t('This customer has') +
          ' ' +
          summary +
          '. ' +
          t(
            'Deleting the customer will also permanently delete their orders and prescriptions. Continue?',
          )
        if (!window.confirm(message)) return
        try {
          await del.mutateAsync({ id, cascade: true })
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err))
        }
        return
      }
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
        {all.data || search.data ? `${total} ${t('total')}` : t('Loading…')}
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

      {!searching && all.hasNextPage && (
        <div className="p-3 text-center">
          <button
            onClick={() => all.fetchNextPage()}
            disabled={all.isFetchingNextPage}
            className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:bg-surface disabled:opacity-50"
          >
            {all.isFetchingNextPage ? t('Loading…') : t('Load more')}
          </button>
        </div>
      )}
    </div>
  )
}
