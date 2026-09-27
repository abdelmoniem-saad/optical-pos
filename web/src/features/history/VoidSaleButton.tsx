import { useState } from 'react'
import type { Sale } from '../../lib/database.types'
import { useVoidSale } from '../../data/sales'
import { useConfirm, useToast } from '../../components/Feedback'
import { useI18n } from '../../i18n/LanguageContext'
import { usePermissions } from '../../data/permissions'

/**
 * Void an invoice (migration 013).
 *
 * Deliberately NOT a delete: the database keeps the header, the lines, the
 * exams and every original payment row, and records voided_at / voided_by /
 * void_reason instead. The stock comes back (unless the cashier says the
 * goods were kept) and every tender is mirrored as a refund, so the day's
 * cash-up by payment method still adds up.
 *
 * Three taps from the invoice: Void -> confirm -> done.
 */
export function VoidSaleButton({ sale }: { sale: Sale }) {
  const { t } = useI18n()
  const perms = usePermissions()
  const confirm = useConfirm()
  const notify = useToast()
  const voidSale = useVoidSale()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [restock, setRestock] = useState(true)
  const [busy, setBusy] = useState(false)

  const canVoid = perms.isAdmin || perms.can('history.void' as never)
  if (sale.voided_at || !canVoid) return null

  async function run() {
    const ok = await confirm(
      t('Void this invoice? The stock goes back and the money is refunded. Nothing is deleted.'),
      { danger: true, confirmLabel: t('Void invoice') },
    )
    if (!ok) return
    setBusy(true)
    try {
      await voidSale.mutateAsync({ id: sale.id, reason: reason.trim(), restock })
      setOpen(false)
      setReason('')
      notify(`✓ ${t('Invoice voided.')}`, 'success')
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger-bg"
      >
        ⊘ {t('Void')}
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-danger/30 bg-danger-bg/40 p-3">
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-xs font-semibold text-muted">
                {t('Why is this invoice being voided?')}
              </div>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('wrong customer, cancelled order…')}
                className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={restock}
                onChange={(e) => setRestock(e.target.checked)}
              />
              {t('Put the items back into stock')}
            </label>
            {!restock && (
              <p className="text-xs text-warning">{t('The goods left the shop, so stock stays down.')}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={run}
                disabled={busy}
                className="rounded-lg bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {busy ? t('Working…') : t('Void invoice')}
              </button>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted"
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
