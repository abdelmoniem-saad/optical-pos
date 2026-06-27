import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGlobalSearch, type SearchResults } from '../data/search'
import { useI18n } from '../i18n/LanguageContext'

/** Global quick-search box. As you type it shows a live dropdown; pressing
 *  Enter opens the same results in a larger popup. Selecting a result jumps to
 *  the relevant screen (pre-filtered). */
export function GlobalSearch() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState(false) // live dropdown
  const [modalOpen, setModalOpen] = useState(false) // popup on Enter
  const results = useGlobalSearch(term)

  const ready = term.trim().length >= 2

  function go(path: string) {
    setOpen(false)
    setModalOpen(false)
    setTerm('')
    navigate(path)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && ready) {
      setOpen(false)
      setModalOpen(true)
    } else if (e.key === 'Escape') {
      setOpen(false)
      setModalOpen(false)
    }
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
        onKeyDown={onKeyDown}
        placeholder={t('Quick search (customers, products, invoices)…')}
        className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
      />

      {open && ready && (
        <div className="absolute z-50 mt-1 max-h-96 w-full overflow-auto rounded-xl border border-line bg-white shadow-lg">
          <ResultList data={results.data} loading={results.isFetching} go={go} />
        </div>
      )}

      {modalOpen && ready && (
        <div
          className="fixed inset-0 z-[65] flex items-start justify-center bg-black/40 p-4 pt-20"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line/40 px-4 py-3">
              <span className="font-semibold text-brand-dark">
                {t('Search Results')} — “{term.trim()}”
              </span>
              <button onClick={() => setModalOpen(false)} className="text-faint hover:text-muted">
                ✕
              </button>
            </div>
            <div className="max-h-[60vh] overflow-auto">
              <ResultList data={results.data} loading={results.isFetching} go={go} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ResultList({
  data,
  loading,
  go,
}: {
  data: SearchResults | undefined
  loading: boolean
  go: (path: string) => void
}) {
  const { t } = useI18n()
  const empty =
    data && data.customers.length === 0 && data.products.length === 0 && data.sales.length === 0

  return (
    <>
      {loading && <div className="px-3 py-2 text-sm text-muted">{t('Searching…')}</div>}
      {empty && !loading && <div className="px-3 py-2 text-sm text-faint">{t('No results.')}</div>}

      {!!data?.customers.length && (
        <Group title={t('Customers')}>
          {data.customers.map((c) => (
            <button key={c.id} onMouseDown={() => go(`/customers?q=${encodeURIComponent(c.name)}`)} className="block w-full px-3 py-2 text-start text-sm hover:bg-surface">
              <span className="font-medium">{c.name}</span> <span className="text-faint">{c.phone || ''}</span>
            </button>
          ))}
        </Group>
      )}

      {!!data?.products.length && (
        <Group title={t('Products')}>
          {data.products.map((p) => (
            <button key={p.id} onMouseDown={() => go(`/inventory?q=${encodeURIComponent(p.name)}`)} className="block w-full px-3 py-2 text-start text-sm hover:bg-surface">
              <span className="font-medium">{p.name}</span> <span className="text-faint">{p.sku || ''} · {Number(p.sale_price ?? 0).toFixed(2)}</span>
            </button>
          ))}
        </Group>
      )}

      {!!data?.sales.length && (
        <Group title={t('Invoices')}>
          {data.sales.map((s) => (
            <button key={s.id} onMouseDown={() => go(`/history?q=${encodeURIComponent(s.invoice_no)}`)} className="block w-full px-3 py-2 text-start text-sm hover:bg-surface">
              <span className="font-medium">#{s.invoice_no}</span> <span className="text-faint">{Number(s.net_amount ?? 0).toFixed(2)}</span>
            </button>
          ))}
        </Group>
      )}
    </>
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
