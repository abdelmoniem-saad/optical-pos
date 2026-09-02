import { useEffect, useRef, useState } from 'react'
import { usePOS, localDateISO } from '../POSContext'
import { useI18n } from '../../../i18n/LanguageContext'
import { useLensTypes, useFrameColors } from '../../../data/metadata'
import { useInventory } from '../../../data/inventory'
import { usePastExaminations, type PastExam } from '../../../data/examinations'
import { uploadPrescriptionImage } from '../../../lib/storage'
import { rxArrowNav } from '../enterNav'
import { emptyExam, type Exam } from '../types'

const small =
  'rounded-md border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-brand'

const field =
  'rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'

// Rx number boxes are narrower than generic fields: digits are centred and
// need less padding. Together with the slimmer exam-type/color fields this
// keeps Type + numbers + lens/frame/color/status + 📎 + ✕ on ONE line even
// at the tab's enlarged 1.25× scale.
const numField =
  'rounded-md border border-line bg-white px-1 py-1.5 text-center text-sm outline-none focus:border-brand'

function ExamRow({ index }: { index: number }) {
  const { t } = useI18n()
  const { state, updateExam, removeExam } = usePOS()
  const exam = state.examinations[index]
  const lensTypes = useLensTypes()
  const frameColors = useFrameColors()
  const frames = useInventory('Frame')

  const upd = (p: Partial<Exam>) => updateExam(index, p)

  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const path = await uploadPrescriptionImage(file)
      upd({ image_path: path })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  // Enter-to-next-field for prescription inputs is handled page-wide by the
  // CartStep container (enterMovesNext) - no row-local handler anymore.

  // A New frame with zero/negative stock stays ALLOWED - the seller is just
  // notified. A frame typed free-hand isn't in inventory yet, so it will be
  // auto-created at checkout and therefore also counts as 0 quantity.
  const frameInfo = String(exam.frame_info ?? '').trim()
  const matchedFrame = frameInfo
    ? (frames.data ?? []).find(
        (f) => (f.name ?? '').trim().toLowerCase() === frameInfo.toLowerCase(),
      )
    : undefined
  const warnZeroQty =
    String(exam.frame_status ?? 'New') === 'New' &&
    !!frameInfo &&
    (!matchedFrame || Number(matchedFrame.stock_qty ?? 0) <= 0)

  // Excel-style numeric grid: Enter lands on a cell with its value selected
  // (type to replace), and the arrow keys hop between cells while you're "on"
  // a cell rather than editing inside it.
  const numCol = (label: string, key: keyof Exam, col: number, w = 'w-13') => (
    <label className="flex flex-col">
      <span className="mb-0.5 text-[10px] font-semibold text-faint">{label}</span>
      <input
        data-rxr={index}
        data-rxc={col}
        onKeyDown={rxArrowNav}
        className={`${numField} ${w}`}
        value={String(exam[key] ?? '')}
        onChange={(e) => upd({ [key]: e.target.value } as Partial<Exam>)}
      />
    </label>
  )

  return (
    <div dir="ltr" className="rounded-xl border border-brand-faint bg-brand-bg/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Exam Type')}</span>
          <select
            className={`${small} w-26`}
            value={String(exam.exam_type ?? 'Distance')}
            onChange={(e) => upd({ exam_type: e.target.value })}
          >
            <option value="Distance">{t('Distance')}</option>
            <option value="Reading">{t('Reading')}</option>
            <option value="Contact Lenses">{t('Contact Lenses')}</option>
          </select>
        </label>

        <div className="flex items-end gap-0.5 rounded-md bg-white/50 p-0.5">
          {numCol('R.SPH', 'sphere_od', 0)}
          {numCol('R.CYL', 'cylinder_od', 1)}
          {numCol('R.AX', 'axis_od', 2, 'w-11')}
        </div>
        <div className="flex items-end gap-0.5 rounded-md bg-white/50 p-0.5">
          {numCol('L.SPH', 'sphere_os', 3)}
          {numCol('L.CYL', 'cylinder_os', 4)}
          {numCol('L.AX', 'axis_os', 5, 'w-11')}
        </div>
        {numCol('IPD', 'ipd', 6, 'w-11')}

        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Lens Type')}</span>
          <input
            className={`${small} w-40`}
            list="lens-types"
            value={String(exam.lens_info ?? '')}
            onChange={(e) => upd({ lens_info: e.target.value })}
          />
          <datalist id="lens-types">
            {(lensTypes.data ?? []).map((l) => (
              <option key={l.id} value={l.name} />
            ))}
          </datalist>
        </label>

        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Frame')}</span>
          <input
            className={`${small} w-40`}
            list="frame-products"
            value={String(exam.frame_info ?? '')}
            onChange={(e) => upd({ frame_info: e.target.value })}
          />
          {warnZeroQty && (
            <span className="max-w-40 text-[10px] font-semibold leading-tight text-warning">
              {matchedFrame
                ? t('This frame quantity is 0 or below - you can still sell it.')
                : t('Frame not found in inventory - it will be recorded with 0 quantity.')}
            </span>
          )}
          <datalist id="frame-products">
            {(frames.data ?? []).map((f) => (
              <option key={f.id} value={f.name} />
            ))}
          </datalist>
        </label>

        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Color')}</span>
          <input
            className={`${small} w-18`}
            list="frame-colors"
            value={String(exam.frame_color ?? '')}
            onChange={(e) => upd({ frame_color: e.target.value })}
          />
          <datalist id="frame-colors">
            {(frameColors.data ?? []).map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </label>

        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Status')}</span>
          <select
            className={`${small} w-20`}
            value={String(exam.frame_status ?? 'New')}
            onChange={(e) => upd({ frame_status: e.target.value })}
          >
            <option value="New">{t('New')}</option>
            <option value="Old">{t('Old')}</option>
          </select>
        </label>

        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title={t('Attach Image')}
          className={`ms-auto rounded-md px-2 py-1.5 text-sm hover:bg-surface ${
            exam.image_path ? 'text-success' : 'text-muted'
          }`}
        >
          {uploading ? '…' : exam.image_path ? '📎✓' : '📎'}
        </button>
        <button
          onClick={() => removeExam(index)}
          disabled={state.examinations.length <= 1}
          className="rounded-md px-2 py-1.5 text-sm text-danger hover:bg-danger/10 disabled:opacity-30"
          title={t('Remove')}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function PastPrescriptions({ customerId }: { customerId: string }) {
  const { t } = useI18n()
  const past = usePastExaminations(customerId)
  const { addExam } = usePOS()
  const [open, setOpen] = useState(false)
  const count = past.data?.length ?? 0

  if (count === 0) return null

  /** Import ONLY the prescription numbers (SPH/CYL/AX/IPD) into a new exam
   *  row - never the old frame, lens or color info. */
  function applyRx(p: PastExam) {
    addExam({
      ...emptyExam(),
      sphere_od: p.sphere_od ?? '',
      cylinder_od: p.cylinder_od ?? '',
      axis_od: p.axis_od ?? '',
      sphere_os: p.sphere_os ?? '',
      cylinder_os: p.cylinder_os ?? '',
      axis_os: p.axis_os ?? '',
      ipd: p.ipd ?? '',
    })
    setOpen(false)
  }

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg bg-brand-faint px-3 py-2 text-sm font-semibold text-brand-dark"
      >
        {t('Previous Prescriptions')} ({count}) {open ? '▲' : '▼'}
      </button>
      {open && (
        // One prescription PER ROW (compact list) so long histories don't eat
        // the whole screen; date + invoice number lead each row.
        <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-line bg-white">
          <ul className="divide-y divide-line/40">
            {(past.data ?? []).map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2"
              >
                <div className="min-w-32 text-sm font-semibold text-brand-dark">
                  {(p.sale.order_date ?? '').slice(0, 10) || 'N/A'}
                  {p.sale.invoice_no ? (
                    <span className="text-brand"> · #{p.sale.invoice_no}</span>
                  ) : null}
                </div>
                <div dir="ltr" className="flex flex-wrap gap-x-4 font-mono text-xs text-muted">
                  <span>
                    OD: {p.sphere_od || '-'}/{p.cylinder_od || '-'}x{p.axis_od || '-'}
                  </span>
                  <span>
                    OS: {p.sphere_os || '-'}/{p.cylinder_os || '-'}x{p.axis_os || '-'}
                  </span>
                  <span>IPD: {p.ipd || '-'}</span>
                </div>
                <button
                  onClick={() => applyRx(p)}
                  className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90"
                >
                  {t('Use this')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Examination fields embedded in the combined order step. */
export function ExamSection() {
  const { t } = useI18n()
  const { state, addExam, setDoctorName, setDeliveryDate } = usePOS()

  useEffect(() => {
    if (state.examinations.length === 0) addExam()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="mb-6">
      {state.customer && <PastPrescriptions customerId={state.customer.id} />}

      <div className="mb-4 flex flex-wrap gap-3">
        {/* Today's date - read-only context right before the delivery date. */}
        <label className="flex flex-col">
          <span className="mb-0.5 text-xs font-semibold text-faint">{t('Order Date')}</span>
          <input
            type="date"
            className={`${field} bg-surface text-muted`}
            value={localDateISO()}
            readOnly
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-0.5 text-xs font-semibold text-faint">{t('Delivery Date')}</span>
          <input
            type="date"
            className={field}
            value={state.deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
          />
        </label>
        <label className="flex flex-1 flex-col">
          <span className="mb-0.5 text-xs font-semibold text-faint">{t('Doctor Name')}</span>
          <input
            className={field}
            value={state.doctorName}
            onChange={(e) => setDoctorName(e.target.value)}
          />
        </label>
      </div>

      <div className="mb-3 space-y-2">
        {state.examinations.map((_, i) => (
          <ExamRow key={i} index={i} />
        ))}
      </div>

      <button
        onClick={() => addExam()}
        className="rounded-lg bg-brand-bg px-3 py-2 text-sm font-semibold text-brand-dark"
      >
        {t('+ Add Another Exam')}
      </button>
    </section>
  )
}
