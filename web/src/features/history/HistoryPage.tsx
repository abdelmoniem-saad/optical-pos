import { useMemo, useState } from 'react'
import { useSales } from '../../data/sales'
import { useCustomers } from '../../data/customers'

function fmt(n: number | null | undefined) {
  return Number(n ?? 0).toFixed(2)
}

const labColor: Record<string, string> = {
  'Not Started': 'bg-surface text-muted',
  'In Progress': 'bg-warning-bg text-warning',
  Ready: 'bg-success-bg text-success',
  Delivered: 'bg-brand-bg text-brand-dark',
}

export function HistoryPage() {
  const sales = useSales()
  const customers = useCustomers()
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of customers.data ?? []) m.set(c.id, c.name)
    return m
  }, [customers.data])

  const rows = useMemo(() => {
    const t = term.trim().toLowerCase()
    const list = sales.data ?? []
    if (!t) return list
    return list.filter((s) => {
      const cust = s.customer_id ? (nameById.get(s.customer_id) ?? '') : ''
      return (
        (s.invoice_no ?? '').toLowerCase().includes(t) ||
        cust.toLowerCase().includes(t)
      )
    })
  }, [sales.data, term, nameById])

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">Sales History</h1>
      <p className="mb-4 text-sm text-muted">{sales.data ? `${sales.data.length} orders` : 'Loading…'}</p>

      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search invoice # or customer…"
        className="mb-4 w-full rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-brand"
      />

      {sales.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          Couldn't load sales: {String(sales.error)}
        </div>
      )}

      <div className="space-y-2">
        {rows.map((s) => {
          const net = Number(s.net_amount ?? 0)
          const paid = Number(s.amount_paid ?? 0)
          const balance = net - paid
          const expanded = open === s.id
          return (
            <div key={s.id} className="overflow-hidden rounded-xl border border-line bg-white">
              <button
                onClick={() => setOpen(expanded ? null : s.id)}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface"
              >
                <div>
                  <div className="font-semibold">
                    #{s.invoice_no}{' '}
                    <span className="font-normal text-muted">
                      {s.customer_id ? nameById.get(s.customer_id) ?? 'Customer' : 'Walk-in'}
                    </span>
                  </div>
                  <div className="text-xs text-faint">{(s.order_date ?? '').slice(0, 16).replace('T', ' ')}</div>
                </div>
                <div className="flex items-center gap-3">
                  {s.lab_status && (
                    <span className={`rounded-full px-2 py-0.5 text-xs ${labColor[s.lab_status] ?? 'bg-surface text-muted'}`}>
                      {s.lab_status}
                    </span>
                  )}
                  <div className="text-right">
                    <div className="font-semibold">{fmt(net)}</div>
                    {balance > 0 && <div className="text-xs text-danger">due {fmt(balance)}</div>}
                  </div>
                </div>
              </button>
              {expanded && (
                <div className="border-t border-line/40 bg-surface/40 px-4 py-3 text-sm">
                  {(s.sale_items?.length ?? 0) === 0 ? (
                    <div className="text-faint">No line items.</div>
                  ) : (
                    <table className="w-full">
                      <tbody>
                        {s.sale_items!.map((it) => (
                          <tr key={it.id}>
                            <td className="py-1">{it.name}</td>
                            <td className="py-1 text-center text-muted">×{it.qty}</td>
                            <td className="py-1 text-right">{fmt(it.total_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="mt-2 flex justify-between text-muted">
                    <span>Paid {fmt(paid)}</span>
                    <span>Balance {fmt(balance)}</span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
