import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { useUpdateSale } from '../../data/sales'
import {
  useOrderExaminations,
  useReplaceOrderExaminations,
} from '../../data/examinations'
import { LAB_STATUSES } from '../../data/sales'
import { useLensTypes, useFrameColors, useAddMetadata } from '../../data/metadata'
import { useInventory, ensureFrameProduct } from '../../data/inventory'
import { enterMovesNext } from '../pos/enterNav'
import { emptyExam, type Exam } from '../pos/types'
import type { Sale } from '../../lib/database.types'

const small =
  'rounded-md border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-brand'

/**
 * Inline full-order editor for the History tab: the usual header fields PLUS
 * the order's prescriptions. Prescription edits are written back to
 * order_examinations, so the customer profile reflects them automatically.
 * Lens / Frame / Color fields behave exactly like the making-order step:
 * press to see options, live narrowing while typing, and unknown names are
 * committed to their list on blur (lens types / inventory frames / colors).
 */
export function EditOrderForm({ sale, onDone }: { sale: Sale; onDone: () => void }) {
  const { t } = useI18n()
  const update = useUpdateSale()
  const replaceExams = useReplaceOrderExaminations(sale.id)
  const examsQ = useOrderExaminations(sale.id)

  const lensTypes = useLensTypes()
  const frameColors = useFrameColors()
  const framesInv = useInventory('Frame')
  const addLensType = useAddMetadata('lens_types')
  const addFrameColor = useAddMetadata('frame_colors')

  const [form, setForm] = useState({
    doctor_name: sale.doctor_name ?? '',
    discount: Number(sale.discount ?? 0),
    amount_paid: Number(sale.amount_paid ?? 0),
    lab_status: sale.lab_status ?? '',
    delivery_date: (sale.delivery_date ?? '').slice(0, 10),
  })
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<Exam[] | null>(null)

  // Seed the editable copy once the server rows arrive.
  useEffect(() => {
    if (examsQ.data && rows === null) {
      setRows(examsQ.data.map(({ id: _id, sale_id: _sid, ...e }) => ({ ...e })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examsQ.data])

  const gross = Number(sale.total_amount ?? 0)
  const net = Math.max(0, gross - (form.discount || 0))

  const field =
    'w-full rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'

  /** Persist a free-typed value into its metadata table when it's new. */
  function maybeAddOption(
    value: string | undefined,
    known: readonly { name: string }[] | undefined,
    add: (name: string) => void,
  ) {
    const v = (value ?? '').trim()
    if (!v) return
    const exists = (known ?? []).some((o) => o.name.trim().toLowerCase() === v.toLowerCase())
    if (!exists) add(v)
  }

  function upd(index: number, patch: Partial<Exam>) {
    setRows((r) => (r ?? []).map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function removeRow(index: number) {
    setRows((r) => (r ?? []).filter((_, i) => i !== index))
  }

  async function submit() {
    setError(null)
    try {
      await update.mutateAsync({
        id: sale.id,
        patch: {
          doctor_name: form.doctor_name,
          discount: form.discount,
          amount_paid: form.amount_paid,
          net_amount: net,
          lab_status: form.lab_status || null,
          delivery_date: form.delivery_date || null,
        },
      })
      // Only rewrite prescriptions when they were actually loaded — never
      // clobber them because of a fetch hiccup.
      if (rows !== null && !examsQ.isError) {
        await replaceExams.mutateAsync(rows)
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const busy = update.isPending || replaceExams.isPending

  return (
    <div className="mt-3 rounded-lg border border-brand-faint bg-white p-3" onKeyDown={enterMovesNext}>
      {/* ---- header fields ---- */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col">
          <span className="mb-0.5 text-xs text-faint">{t('Doctor Name')}</span>
          <input
            className={field}
            value={form.doctor_name}
            onChange={(e) => setForm({ ...form, doctor_name: e.target.value })}
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-0.5 text-xs text-faint">{t('Delivery Date')}</span>
          <input
            type="date"
            className={field}
            value={form.delivery_date}
            onChange={(e) => setForm({ ...form, delivery_date: e.target.value })}
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-0.5 text-xs text-faint">{t('Discount')}</span>
          <input
            type="number"
            className={field}
            value={form.discount}
            onChange={(e) => setForm({ ...form, discount: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-0.5 text-xs text-faint">{t('Amount Paid')}</span>
          <input
            type="number"
            className={field}
            value={form.amount_paid}
            onChange={(e) => setForm({ ...form, amount_paid: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-0.5 text-xs text-faint">{t('Lab Status')}</span>
          <select
            className={field}
            value={form.lab_status ?? ''}
            onChange={(e) => setForm({ ...form, lab_status: e.target.value })}
          >
            <option value="">—</option>
            {/* Same vocabulary as the Lab tab — nothing else, so statuses and
                their colors stay aligned across screens. */}
            {LAB_STATUSES.map((st) => (
              <option key={st} value={st}>
                {t(st)}
              </option>
            ))}
            {/* Legacy value from an older build? Keep it visible but unchanged. */}
            {form.lab_status &&
              !LAB_STATUSES.includes(form.lab_status as (typeof LAB_STATUSES)[number]) && (
                <option value={form.lab_status}>{t(form.lab_status)}</option>
              )}
          </select>
        </label>
        <div className="flex flex-col justify-end text-xs text-muted">
          {t('Net Amount')}: <span className="text-base font-semibold text-brand-dark">{net.toFixed(2)}</span>
        </div>
      </div>

      {/* ---- prescriptions ---- */}
      <div className="mt-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-brand-dark">{t('Edit Prescriptions')}</h4>
        <button
          onClick={() => setRows((r) => [...(r ?? []), emptyExam()])}
          className="rounded-lg bg-brand-bg px-3 py-1.5 text-xs font-semibold text-brand-dark"
        >
          {t('+ Add Another Exam')}
        </button>
      </div>

      {examsQ.isLoading && !rows && <p className="py-2 text-xs text-muted">{t('Loading…')}</p>}
      {rows?.length === 0 && <p className="py-2 text-xs text-faint">{t('No prescriptions.')}</p>}

      <div className="space-y-2">
        {(rows ?? []).map((row, i) => (
          <div
            key={i}
            dir="ltr"
            className="rounded-xl border border-brand-faint bg-surface/50 p-2.5"
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col">
                <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Exam Type')}</span>
                <select
                  className={`${small} w-32`}
                  value={String(row.exam_type ?? 'Distance')}
                  onChange={(e) => upd(i, { exam_type: e.target.value })}
                >
                  <option value="Distance">{t('Distance')}</option>
                  <option value="Reading">{t('Reading')}</option>
                  <option value="Contact Lenses">{t('Contact Lenses')}</option>
                </select>
              </label>

              <div className="flex items-end gap-1 rounded-md bg-white p-1">
                {(
                  [
                    ['R.SPH', 'sphere_od'],
                    ['R.CYL', 'cylinder_od'],
                    ['R.AX', 'axis_od', 'w-14'],
                  ] as const
                ).map(([label, key, w]) => (
                  <label className="flex flex-col" key={label}>
                    <span className="mb-0.5 text-[10px] font-semibold text-faint">{label}</span>
                    <input
                      className={`${small} ${w ?? 'w-16'}`}
                      value={String(row[key] ?? '')}
                      onChange={(e) => upd(i, { [key]: e.target.value } as Partial<Exam>)}
                    />
                  </label>
                ))}
              </div>
              <div className="flex items-end gap-1 rounded-md bg-white p-1">
                {(
                  [
                    ['L.SPH', 'sphere_os'],
                    ['L.CYL', 'cylinder_os'],
                    ['L.AX', 'axis_os', 'w-14'],
                  ] as const
                ).map(([label, key, w]) => (
                  <label className="flex flex-col" key={label}>
                    <span className="mb-0.5 text-[10px] font-semibold text-faint">{label}</span>
                    <input
                      className={`${small} ${w ?? 'w-16'}`}
                      value={String(row[key] ?? '')}
                      onChange={(e) => upd(i, { [key]: e.target.value } as Partial<Exam>)}
                    />
                  </label>
                ))}
              </div>
              <label className="flex flex-col">
                <span className="mb-0.5 text-[10px] font-semibold text-faint">IPD</span>
                <input
                  className={`${small} w-14`}
                  value={String(row.ipd ?? '')}
                  onChange={(e) => upd(i, { ipd: e.target.value })}
                />
              </label>

              {/* Lens Type — narrows over saved lens types; new names are added. */}
              <label className="flex flex-col">
                <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Lens Type')}</span>
                <input
                  className={`${small} w-40`}
                  list={`edit-lens-types-${i}`}
                  value={String(row.lens_info ?? '')}
                  onChange={(e) => upd(i, { lens_info: e.target.value })}
                  onBlur={(e) =>
                    maybeAddOption(e.target.value, lensTypes.data, (n) => addLensType.mutate(n))
                  }
                />
                <datalist id={`edit-lens-types-${i}`}>
                  {(lensTypes.data ?? []).map((o) => (
                    <option key={o.id} value={o.name} />
                  ))}
                </datalist>
              </label>

              {/* Frame — narrows over inventory Frames; unknown names become products. */}
              <label className="flex flex-col">
                <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Frame')}</span>
                <input
                  className={`${small} w-40`}
                  list={`edit-frame-products-${i}`}
                  value={String(row.frame_info ?? '')}
                  onChange={(e) => upd(i, { frame_info: e.target.value })}
                  onBlur={(e) => void ensureFrameProduct(e.target.value).catch(() => undefined)}
                />
                <datalist id={`edit-frame-products-${i}`}>
                  {(framesInv.data ?? []).map((f) => (
                    <option key={f.id} value={f.name} />
                  ))}
                </datalist>
              </label>

              {/* Color — narrows over saved colors; new names are added. */}
              <label className="flex flex-col">
                <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Color')}</span>
                <input
                  className={`${small} w-28`}
                  list={`edit-frame-colors-${i}`}
                  value={String(row.frame_color ?? '')}
                  onChange={(e) => upd(i, { frame_color: e.target.value })}
                  onBlur={(e) =>
                    maybeAddOption(e.target.value, frameColors.data, (n) => addFrameColor.mutate(n))
                  }
                />
                <datalist id={`edit-frame-colors-${i}`}>
                  {(frameColors.data ?? []).map((o) => (
                    <option key={o.id} value={o.name} />
                  ))}
                </datalist>
              </label>

              <label className="flex flex-col">
                <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Status')}</span>
                <select
                  className={`${small} w-20`}
                  value={String(row.frame_status ?? 'New')}
                  onChange={(e) => upd(i, { frame_status: e.target.value })}
                >
                  <option value="New">{t('New')}</option>
                  <option value="Old">{t('Old')}</option>
                </select>
              </label>

              <button
                onClick={() => removeRow(i)}
                disabled={rows!.length <= 1}
                title={t('Remove')}
                className="ms-auto rounded-md px-2 py-1.5 text-sm text-danger hover:bg-danger/10 disabled:opacity-30"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{t(error)}</div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onDone}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface"
        >
          {t('Cancel')}
        </button>
        <button
          onClick={submit}
          disabled={busy}
          className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? t('Saving…') : t('Save')}
        </button>
      </div>
    </div>
  )
}
