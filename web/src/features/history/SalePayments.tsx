import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { usePermissions } from '../../data/permissions'
import { useSalePayments, useAddSalePayments } from '../../data/salesPayments'
import { useToast } from '../../components/Feedback'
import {
  PAYMENT_METHODS,
  clampPaymentLines,
  methodLabelKey,
  normalizeLines,
  paymentsTotal,
  removeLine as removePayLine,
  round2,
  upsertLine,
  type PaymentLine,
} from '../../lib/payments'
import type { Sale } from '../../lib/database.types'

function money(n: number) {
  return n.toFixed(2)
}

/**
 * The payment ledger of ONE invoice + "Add Payment" for the remaining balance.
 *
 * Every row here is money that actually arrived (cash / wallet / InstaPay);
 * the DB trigger keeps sales.amount_paid == SUM(rows), so what we show IS the
 * truth. The same tender editor idea as the POS cart - tap a chip to add a
 * line (prefilled with what is still due), then record.
 *
 * Requires migration 011; until it runs, the query error (translated "run 011"
 * message) is shown instead of a silently wrong empty list.
 */
export function SalePayments({ sale, balance }: { sale: Sale; balance: number }) {
  const { t } = useI18n()
  const perms = usePermissions()
  const notify = useToast()
  const query = useSalePayments(sale.id)
  const addPayments = useAddSalePayments()

  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<PaymentLine[]>([])
  const [busy, setBusy] = useState(false)

  const rows = query.data ?? []
  const canPay = balance > 0 && (perms.isAdmin || perms.can('history.edit' as never))
  const entered = paymentsTotal(lines)
  const afterRecord = round2(Math.max(0, balance - entered))

  async function record() {
    // Clamp to what is still owed: you can never overpay an invoice.
    const clean = clampPaymentLines(normalizeLines(lines), balance)
    if (!clean.length) return
    setBusy(true)
    try {
      await addPayments.mutateAsync(
        clean.map((p) => ({ sale_id: sale.id, amount: p.amount, method: p.method })),
      )
      setLines([])
      setOpen(false)
      notify(`✓ ${t('Payment recorded.')}`)
    } catch (e) {
      // Includes the translated "ledger missing - run 011" message.
      notify(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-line/50 bg-white p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">{t('Payments')}</span>
        {canPay && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:bg-surface"
          >
            + {t('Add Payment')}
          </button>
        )}
      </div>

      {query.isError ? (
        <div className="rounded bg-warning-bg px-2 py-1 text-xs text-warning">
          {t(query.error.message)}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-faint">{t('No payments yet.')}</div>
      ) : (
        <div className="space-y-0.5">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-xs">
              <span className="text-faint">{r.paid_at}</span>
              <span className="font-semibold text-muted">{t(methodLabelKey(r.method))}</span>
              <span className="font-semibold">{money(Number(r.amount))}</span>
            </div>
          ))}
        </div>
      )}

      {open && canPay && (
        <div className="mt-2 border-t border-line/40 pt-2">
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {PAYMENT_METHODS.map((m) => {
              const line = lines.find((l) => l.method === m)
              const others = paymentsTotal(lines.filter((l) => l.method !== m))
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() =>
                    line
                      ? setLines(removePayLine(lines, m))
                      : setLines(upsertLine(lines, m, round2(Math.max(0, balance - others))))
                  }
                  className={[
                    'rounded-full border px-2.5 py-1 text-xs font-semibold transition',
                    line
                      ? 'border-brand bg-brand text-white'
                      : 'border-line bg-white text-muted hover:bg-surface',
                  ].join(' ')}
                >
                  {t(methodLabelKey(m))}
                  {line && line.amount > 0 ? ` · ${money(line.amount)}` : ''}
                </button>
              )
            })}
          </div>

          {lines.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {lines.map((l) => (
                <div key={l.method} className="flex items-center gap-2">
                  <span className="w-24 text-xs text-faint">{t(methodLabelKey(l.method))}</span>
                  <input
                    type="number"
                    min={0}
                    className="w-28 rounded-lg border border-line bg-white px-2 py-1 text-sm outline-none focus:border-brand"
                    value={l.amount}
                    onChange={(e) =>
                      setLines(upsertLine(lines, l.method, Number(e.target.value)))
                    }
                  />
                  <button
                    type="button"
                    title={t('Remove')}
                    onClick={() => setLines(removePayLine(lines, l.method))}
                    className="px-1 text-sm text-danger hover:opacity-70"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted">
              {t('Remaining')}: <b className={afterRecord > 0 ? 'text-danger' : 'text-success'}>{money(afterRecord)}</b>
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={record}
                disabled={busy || entered <= 0}
                className="rounded-lg bg-success px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              >
                {busy ? t('Saving…') : t('Add Payment')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setLines([])
                  setOpen(false)
                }}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface"
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
