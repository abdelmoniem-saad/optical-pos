import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGlobalSearch } from '../data/search'
import { useI18n } from '../i18n/LanguageContext'

/** Global quick-search box with a results dropdown across customers, products
 *  and invoices. Selecting a result jumps to the relevant screen (pre-filtered). */
export function GlobalSearch() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState(false)
  const results = useGlobalSearch(term)

  const data = results.data
  const empty =
    data && data.customers.length === 0 && data.products.length === 0 && data.sales.length === 0

  function go(path: string) {
    setOpen(false)
    setTerm('')
    navigate(path)
  }

  return (
    <div className="relative w-full max-w-md">
      <input
        value={term}
        onChange={(e) => {
          setTerm(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={t('Quick search (customers, products, invoices)…')}
        className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
      />

      {open && term.trim().length >= 2 && (
        <div className="absolute z-50 mt-1 max-h-96 w-full overflow-auto rounded-xl border border-line bg-white shadow-lg">
          {results.isFetching && <div className="px-3 py-2 text-sm text-muted">{t('Searching…')}</div>}
          {empty && !results.isFetching && (
            <div className="px-3 py-2 text-sm text-faint">{t('No results.')}</div>
          )}

          {!!data?.customers.length && (
            <Group title={t('Customers')}>
              {data.customers.map((c) => (
                <button key={c.id} onMouseDown={() => go(`/customers?q=${encodeURIComponent(c.name)}`)} className="block w-full px-3 py-2 text-start text-sm hover:bg-surface">
                  <span className="font-medium">{c.name}</span>{' '}
                  <span className="text-faint">{c.phone || ''}</span>
                </button>
              ))}
            </Group>
          )}

          {!!data?.products.length && (
            <Group title={t('Products')}>
              {data.products.map((p) => (
                <button key={p.id} onMouseDown={() => go(`/inventory?q=${encodeURIComponent(p.name)}`)} className="block w-full px-3 py-2 text-start text-sm hover:bg-surface">
                  <span className="font-medium">{p.name}</span>{' '}
                  <span className="text-faint">{p.sku || ''} · {Number(p.sale_price ?? 0).toFixed(2)}</span>
                </button>
              ))}
            </Group>
          )}

          {!!data?.sales.length && (
            <Group title={t('Invoices')}>
              {data.sales.map((s) => (
                <button key={s.id} onMouseDown={() => go(`/history?q=${encodeURIComponent(s.invoice_no)}`)} className="block w-full px-3 py-2 text-start text-sm hover:bg-surface">
                  <span className="font-medium">#{s.invoice_no}</span>{' '}
                  <span className="text-faint">{Number(s.net_amount ?? 0).toFixed(2)}</span>
                </button>
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line/40 last:border-0">
      <div className="bg-surface/60 px-3 py-1 text-xs font-semibold text-faint">{title}</div>
      {children}
    </div>
  )
}
