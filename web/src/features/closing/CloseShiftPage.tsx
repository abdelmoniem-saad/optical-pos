import { useMemo, useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { usePermissions } from '../../data/permissions'
import { useConfirm, useToast } from '../../components/Feedback'
import {
  computeVariance,
  parseCountedCash,
  useCloseShift,
  useShiftCloses,
  isZReportReady,
  useZReport,
  varianceVerdict,
} from '../../data/zreport'
import { methodLabelKey } from '../../lib/payments'

/** Money at 2dp. ReportsPage keeps its own formatter; this one exists because a
 *  variance of 49.50 must not print as 50 and read as a tidy round number. */
const money = (n: number) => n.toFixed(2)

/** The browser's own idea of today. The server re-derives the real bounds from
 *  store_day_range regardless, so a tablet with the wrong clock cannot move the
 *  books - but picking a DIFFERENT day is exact, and that is what this is for. */
function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function varianceClass(v: number | null): string {
  const verdict = varianceVerdict(v)
  if (verdict === 'short') return 'text-danger'
  if (verdict === 'over') return 'text-success'
  if (verdict === 'unknown') return 'text-faint'
  return 'text-brand-dark'
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <li className="flex justify-between py-1">
      <span className="text-muted">{label}</span>
      <span className={'font-semibold ' + (tone ?? 'text-brand-dark')}>{value}</span>
    </li>
  )
}

export function CloseShiftPage() {
  const { t } = useI18n()
  const perms = usePermissions()
  const confirm = useConfirm()
  const notify = useToast()

  const [day, setDay] = useState(todayLocal())
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')
  const [closed, setClosed] = useState<{ variance: number; expected: number; counted: number } | null>(
    null,
  )

  const report = useZReport(day)
  const closes = useShiftCloses(10)
  const closeShift = useCloseShift()

  // Two different questions. `closing.view` may SEE the day's figures;
  // `closing.edit` may COMMIT a close. The database enforces the second; this
  // only stops the button being offered to someone who would be refused.
  const mayView = perms.can('closing.view' as never)
  const mayEdit = perms.can('closing.edit' as never)

  const live = isZReportReady(report.data) ? report.data : null
  const expectedCash = live ? live.report.expectedCash : 0

  const countedValue = useMemo(() => parseCountedCash(counted), [counted])
  const previewVariance = useMemo(
    () => computeVariance(countedValue, expectedCash),
    [countedValue, expectedCash],
  )

  async function submit() {
    if (!live) return
    if (countedValue === null) {
      notify(t('Enter the cash you counted before closing.'), 'error')
      return
    }
    const ok = await confirm(t('A close cannot be edited later. Record this close for the day?'), {
      confirmLabel: t('Close the shift'),
    })
    if (!ok) return
    try {
      const saved = await closeShift.mutateAsync({
        from: live.bounds.from,
        to: live.bounds.to,
        countedCash: countedValue,
        note: note.trim() || null,
      })
      setClosed({
        variance: saved.variance,
        expected: saved.expectedCash,
        counted: saved.countedCash,
      })
      setCounted('')
      setNote('')
      notify(t('Shift closed.'), 'success')
    } catch (err) {
      notify((err as Error)?.message ?? t('Could not close the shift.'), 'error')
    }
  }

  /**
   * THE FOUR STATES, KEPT APART ON PURPOSE.
   * `missing` (023 not applied) must never look like a day with no money. That
   * conflation is not hypothetical: a tenant-scoped report run without a JWT
   * reports every row as zero, and a confident row of zeros reads as a fact
   * about the business rather than about the software.
   */
  function body() {
    if (report.isPending) return <p className="text-sm text-faint">{t('Loading…')}</p>
    const result = report.data
    if (!result) return null

    if (result.status === 'missing') {
      return (
        <div className="rounded-xl border border-warning-bg bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="font-semibold">{t('The day-close feature is not installed yet.')}</p>
          <p className="mt-1">
            {t('Run 023_z_report.sql and 024_closing_permission.sql in the SQL Editor, then reload.')}
          </p>
        </div>
      )
    }
    if (result.status === 'no-bounds') {
      return <p className="text-sm text-faint">{t('Loading…')}</p>
    }
    if (result.status === 'error') {
      return (
        <div className="rounded-xl border border-warning-bg bg-warning-bg px-4 py-3 text-sm text-warning">
          {result.message}
        </div>
      )
    }

    const r = result.report
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="mb-2 font-semibold text-brand-dark">{t('Expected in the drawer')}</h2>
          <div className="mb-3 text-3xl font-bold text-brand-dark">{money(expectedCash)}</div>

          {Object.keys(r.expectedByTender).length > 0 && (
            <ul className="mb-3 divide-y divide-line border-t border-line text-sm">
              {Object.entries(r.expectedByTender)
                .sort((a, b) => b[1] - a[1])
                .map(([method, total]) => (
                  <Row
                    key={method}
                    label={t(methodLabelKey(method))}
                    value={money(total)}
                    tone={method === 'cash' ? 'text-brand-dark' : 'text-muted'}
                  />
                ))}
            </ul>
          )}

          <ul className="divide-y divide-line border-t border-line text-sm">
            <Row label={t('Orders')} value={String(r.orderCount)} />
            <Row label={t('Prescriptions')} value={String(r.prescriptionCount)} />
            <Row label={t('Voids')} value={String(r.voidCount)} />
            <Row label={t('Refunds')} value={money(r.refundTotal)} />
            <Row label={t('Lab jobs delivered')} value={String(r.labDelivered)} />
          </ul>

          <p className="mt-3 text-xs text-faint">
            {t(
              'Money is counted net of refunds, so a void leaves the drawer as empty as the sale left it full.',
            )}
          </p>
        </section>

        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="mb-2 font-semibold text-brand-dark">{t('Count the drawer')}</h2>

          <label className="mb-1 block text-sm text-muted" htmlFor="counted-cash">
            {t('Counted cash')}
          </label>
          <input
            id="counted-cash"
            type="text"
            inputMode="decimal"
            value={counted}
            onChange={(e) => {
              setCounted(e.target.value)
              setClosed(null)
            }}
            placeholder="0.00"
            className="w-full rounded-lg border border-line px-3 py-2 text-2xl outline-none focus:border-brand"
          />

          {closed ? (
            <div className="mt-4 rounded-lg border border-line bg-brand-faint p-3">
              <p className="text-sm font-semibold text-brand-dark">{t('Closed')}</p>
              <p className="mt-1 text-sm text-muted">
                {t('Counted')} {money(closed.counted)} - {t('Expected amount')} {money(closed.expected)}
              </p>
              <p className={'mt-1 text-2xl font-bold ' + varianceClass(closed.variance)}>
                {money(closed.variance)}
              </p>
              <p className="mt-2 text-xs text-muted">{t('A close cannot be edited later.')}</p>
            </div>
          ) : (
            <div className="mt-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted">{t('Variance')}</span>
                <span className={'text-2xl font-bold ' + varianceClass(previewVariance)}>
                  {previewVariance === null ? '--' : money(previewVariance)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {varianceVerdict(previewVariance) === 'short'
                  ? t('Short of the expected amount.')
                  : varianceVerdict(previewVariance) === 'over'
                    ? t('More than the expected amount.')
                    : varianceVerdict(previewVariance) === 'balanced'
                      ? t('Matches the ledger.')
                      : t('Enter the counted cash to see the difference.')}
              </p>
            </div>
          )}

          <label className="mb-1 mt-4 block text-sm text-muted" htmlFor="close-note">
            {t('Note (optional)')}
          </label>
          <input
            id="close-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />

          {mayEdit ? (
            <button
              type="button"
              onClick={submit}
              disabled={closeShift.isPending || closed !== null}
              className="mt-4 w-full rounded-lg bg-brand px-4 py-3 font-semibold text-white disabled:opacity-50"
            >
              {closeShift.isPending ? t('Closing...') : t('Close the shift')}
            </button>
          ) : (
            <p className="mt-4 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
              {t('You can see these figures but not record a close. Ask a manager for permission.')}
            </p>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Close the shift')}</h1>
        <input
          type="date"
          value={day}
          onChange={(e) => {
            setDay(e.target.value)
            setClosed(null)
            setCounted('')
          }}
          className="rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand"
        />
      </div>

      {!mayView ? (
        <div className="rounded-xl border border-warning-bg bg-warning-bg px-4 py-3 text-sm text-warning">
          {t('You do not have access to this page.')}
        </div>
      ) : (
        <>
          {body()}

          <section className="mt-6">
            <h2 className="mb-2 font-semibold text-brand-dark">{t('Previous closes')}</h2>
            {closes.isError ? (
              <p className="rounded bg-warning-bg px-3 py-2 text-sm text-warning">
                {(closes.error as Error)?.message}
              </p>
            ) : closes.data && closes.data.length > 0 ? (
              <ul className="divide-y divide-line rounded-xl border border-line bg-white text-sm">
                {closes.data.map((c) => (
                  <li key={c.id} className="flex items-center justify-between px-4 py-2">
                    <span className="text-muted">
                      {c.closedAt ? new Date(c.closedAt).toLocaleString() : c.fromAt}
                    </span>
                    <span className="flex items-center gap-4">
                      <span>{money(c.countedCash)}</span>
                      <span className={'w-24 text-right font-semibold ' + varianceClass(c.variance)}>
                        {money(c.variance)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-faint">{t('No shifts have been closed yet.')}</p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
