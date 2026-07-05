import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  useAddCustomer,
  useCustomers,
  useCustomerSearch,
  useDeleteCustomer,
} from '../../data/customers'
import { useI18n } from '../../i18n/LanguageContext'

/** Customers list + search, with inline create and delete. */
export function CustomersPage() {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const [term, setTerm] = useState(params.get('q') ?? '')
  const [showAdd, setShowAdd] = useState(false)
  const all = useCustomers()
  const search = useCustomerSearch(term)
  const del = useDeleteCustomer()

  const searching = term.trim().length >= 2
  const active = searching ? search : all
  const customers = active.data ?? []

  async function onDelete(id: string, name: string) {
    if (!window.confirm(t('Delete customer') + ` "${name}"?`)) return
    try {
      await del.mutateAsync(id)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Customers')}</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white"
        >
          + {t('Add Customer')}
        </button>
      </div>
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
          <li key={c.id} className="flex items-center hover:bg-surface">
            <Link
              to={`/customers/${c.id}`}
              className="flex flex-1 items-center justify-between px-4 py-3"
            >
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-faint">{c.city || '—'}</div>
              </div>
              <div className="text-sm text-muted">{c.phone || ''}</div>
            </Link>
            <button
              onClick={() => onDelete(c.id, c.name)}
              disabled={del.isPending}
              title={t('Delete')}
              className="mx-2 rounded-md px-2 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-40"
            >
              🗑
            </button>
          </li>
        ))}
      </ul>

      {showAdd && <AddCustomerDialog onClose={() => setShowAdd(false)} />}
    </div>
  )
}

function AddCustomerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const add = useAddCustomer()
  const [form, setForm] = useState({
    name: '',
    phone: '',
    city: '',
    email: '',
    address: '',
  })
  const [error, setError] = useState<string | null>(null)

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value })

  async function submit() {
    const name = form.name.trim()
    if (!name) {
      setError(t('Please enter customer name.'))
      return
    }
    setError(null)
    try {
      await add.mutateAsync({
        name,
        phone: form.phone,
        city: form.city,
        email: form.email,
        address: form.address,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const field =
    'w-full rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-lg">
        <h2 className="mb-3 text-lg font-semibold text-brand-dark">{t('Add Customer')}</h2>
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs text-faint">{t('Name')}</span>
            <input className={field} value={form.name} onChange={set('name')} autoFocus />
          </label>
          <label className="block">
            <span className="text-xs text-faint">{t('Phone')}</span>
            <input className={field} value={form.phone} onChange={set('phone')} />
          </label>
          <label className="block">
            <span className="text-xs text-faint">{t('City')}</span>
            <input className={field} value={form.city} onChange={set('city')} />
          </label>
          <label className="block">
            <span className="text-xs text-faint">{t('Email')}</span>
            <input className={field} value={form.email} onChange={set('email')} />
          </label>
          <label className="block">
            <span className="text-xs text-faint">{t('Address')}</span>
            <input className={field} value={form.address} onChange={set('address')} />
          </label>
        </div>
        {error && (
          <div className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{error}</div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-2 text-muted hover:bg-surface"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={submit}
            disabled={add.isPending}
            className="rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-60"
          >
            {add.isPending ? t('Saving…') : t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
