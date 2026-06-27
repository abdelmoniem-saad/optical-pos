import { useState } from 'react'
import { usePOS } from '../POSContext'
import { useI18n } from '../../../i18n/LanguageContext'
import { useCustomerSearch } from '../../../data/customers'
import type { Customer } from '../../../lib/database.types'

type Form = {
  name: string
  phone: string
  city: string
  email: string
  address: string
}

const empty: Form = { name: '', phone: '', city: '', email: '', address: '' }

export function CustomerStep() {
  const { t } = useI18n()
  const { back, chooseWalkIn, continueWithCustomer, state } = usePOS()
  const [form, setForm] = useState<Form>(empty)
  const [selected, setSelected] = useState<Customer | null>(null)

  const results = useCustomerSearch(form.name)

  function set<K extends keyof Form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
    if (key === 'name') setSelected(null)
  }

  function pick(c: Customer) {
    setSelected(c)
    setForm({
      name: c.name ?? '',
      phone: c.phone ?? '',
      city: c.city ?? '',
      email: c.email ?? '',
      address: c.address ?? '',
    })
  }

  const field =
    'rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand'

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h2 className="text-xl font-bold text-brand-dark">{t('Step 1: Customer Selection')}</h2>
      <p className="mb-4 text-sm text-muted">
        {t('Enter customer info or pick a match below. Leave as-is for a walk-in.')}
      </p>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input className={field} placeholder={t('Name *')} value={form.name} autoFocus onChange={(e) => set('name', e.target.value)} />
        <input className={field} placeholder={t('Mobile Phone')} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
        <input className={field} placeholder={t('City')} value={form.city} onChange={(e) => set('city', e.target.value)} />
        <input className={field} placeholder={t('Email')} value={form.email} onChange={(e) => set('email', e.target.value)} />
      </div>

      <div className="mb-2 text-sm font-semibold text-muted">{t('Matching customers')}</div>
      <div className="mb-4 max-h-56 overflow-auto rounded-xl border border-line bg-white">
        {form.name.trim().length < 2 && (
          <p className="p-4 text-sm text-faint">{t('Start typing a name to search…')}</p>
        )}
        {results.isFetching && <p className="p-4 text-sm text-muted">{t('Searching…')}</p>}
        {form.name.trim().length >= 2 && !results.isFetching && (results.data?.length ?? 0) === 0 && (
          <p className="p-4 text-sm text-faint">
            {t('No match — a new customer will be created when you continue.')}
          </p>
        )}
        <ul className="divide-y divide-line/40">
          {(results.data ?? []).map((c) => (
            <li key={c.id}>
              <button
                onClick={() => pick(c)}
                className={`flex w-full items-center justify-between px-4 py-2.5 text-start hover:bg-brand-bg ${
                  selected?.id === c.id ? 'bg-brand-bg' : ''
                }`}
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-sm text-muted">
                  {c.phone || '—'} · {c.city || '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {state.error && (
        <div className="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t(state.error)}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={back} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
          {t('← Back')}
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => chooseWalkIn()}
            disabled={state.busy}
            className="rounded-lg bg-warning px-4 py-2.5 font-semibold text-white disabled:opacity-60"
          >
            {t('Walk-in →')}
          </button>
          <button
            onClick={() => continueWithCustomer(form, selected)}
            disabled={state.busy}
            className="rounded-lg bg-success px-4 py-2.5 font-semibold text-white disabled:opacity-60"
          >
            {state.busy ? t('Saving…') : t('Continue with Customer →')}
          </button>
        </div>
      </div>
    </div>
  )
}
