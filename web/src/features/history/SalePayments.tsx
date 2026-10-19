import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { usePermissions } from '../../data/permissions'
import { useSalePayments, useAddSalePayments, useRefundSale } from '../../data/salesPayments'
import { useToast, useConfirm } from '../../components/Feedback'
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
  const refund = useRefundSale()
  const confirm = useConfirm()
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundMethod, setRefundMethod] = useState('cash')
  const [refundAmount, setRefundAmount] = useState('')
  const [reason, setReason] = useState('')

  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<PaymentLine[]>([])
  const [busy, setBusy] = useState(false)

  const rows = query.data ?? []
  const refundable = round2(rows.filter(r => r.method === refundMethod).reduce((sum,r) => sum + Number(r.amount), 0))
  const canRefund = !sale.voided_at && perms.can('history.refund') && !query.isError && !query.isPending
  async function recordRefund() {
    const amount = round2(Number(refundAmount))
    if (!canRefund || refund.isPending || !Number.isFinite(amount) || amount <= 0 || amount > refundable || !reason.trim()) return
    if (!await confirm(`${t('Refund')} ${money(amount)} · ${t(methodLabelKey(refundMethod))}?`)) return
    try {
      await refund.mutateAsync({ saleId: sale.id, amount, method: refundMethod, reason: reason.trim() })
      setRefundOpen(false); setRefundAmount(''); setReason(''); notify(t('Saved'), 'success')
    } catch (e) { notify(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)) }
  }
  // A voided invoice is closed: no more money may be taken against it, and
  // its ledger only grows if the void is itself reversed in the future.
  const canPay =
    !sale.voided_at && balance > 0 && (perms.isAdmin || perms.can('history.edit' as never))
  const entered = paymentsTotal(lines)
  const afterRecord = round2(Math.max(0, balance - entered))
  // Live cap: a line can't grow past what is still owed once the OTHER
  // lines are counted - typing a bigger number is clamped on the spot.
  const maxFor = (method: string) =>
    round2(Math.max(0, balance - paymentsTotal(lines.filter((l) => l.method !== method))))

  async function record() {
    if (!canPay || busy) return
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
      notify(t('Payment recorded.'), 'success')
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

      {canRefund && <button type="button" className="my-1 text-xs text-danger hover:underline" onClick={() => setRefundOpen(v => !v)}>{t('Refund')}</button>}
      {refundOpen && canRefund && <div className="my-2 space-y-2 rounded-lg border border-line p-3">
        <p className="text-xs text-muted">{t('Refunding money keeps this invoice open and increases its remaining balance. Use Void for a cancelled sale.')}</p>
        <div className="flex flex-wrap gap-2">
          <select aria-label={t('Payment method')} className="rounded border border-line p-2 text-xs" value={refundMethod} onChange={e => setRefundMethod(e.target.value)}>
            {PAYMENT_METHODS.map(m => <option key={m} value={m}>{t(methodLabelKey(m))}</option>)}
          </select>
          <input aria-label={t('Refund amount')} className="w-28 rounded border border-line p-2 text-xs" type="number" min="0.01" max={refundable} step="0.01" value={refundAmount} onChange={e => setRefundAmount(e.target.value)}/>
          <span className="text-xs">{t('Available to refund')}: {money(Math.max(0,refundable))}</span>
        </div>
        <input aria-label={t('Reason')} placeholder={t('Reason')} className="w-full rounded border border-line p-2 text-xs" value={reason} onChange={e => setReason(e.target.value)}/>
        <button type="button" className="rounded bg-danger px-3 py-2 text-xs text-white disabled:opacity-50" disabled={refund.isPending || !reason.trim() || !(Number(refundAmount)>0) || Number(refundAmount)>refundable} onClick={() => void recordRefund()}>{t(refund.isPending ? 'Saving…':'Refund')}</button>
      </div>}

      {query.isError ? (
        <div className="rounded bg-warning-bg px-2 py-1 text-xs text-warning">
          {t(query.error.message)}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-faint">{t('No payments yet.')}</div>
      ) : (
        <div className="space-y-0.5">
          {rows.map((r) => {
            // A refund is money going BACK (migration 013): negative amount,
            // kind='refund', written by void_sale() once per original tender.
            const isRefund = Number(r.amount) < 0 || (r.kind ?? 'payment') === 'refund'
            return (
              <div key={r.id} className="flex items-center justify-between text-xs">
                <span className="text-faint">
                  {(r.paid_at ?? '').slice(0, 16).replace('T', ' ')}
                </span>
                <span className={isRefund ? 'font-semibold text-danger' : 'font-semibold text-muted'}>
                  {isRefund ? t('Refund') : t(methodLabelKey(r.method))}
                </span>
                <span className={isRefund ? 'font-semibold text-danger' : 'font-semibold'}>
                  {money(Math.abs(Number(r.amount)))}
                </span>
              </div>
            )
          })}
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
                      setLines(
                        upsertLine(lines, l.method, Math.min(Number(e.target.value) || 0, maxFor(l.method))),
                      )
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
