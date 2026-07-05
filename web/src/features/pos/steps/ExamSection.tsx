import { useEffect, useRef, useState } from 'react'
import { usePOS } from '../POSContext'
import { useI18n } from '../../../i18n/LanguageContext'
import { useLensTypes, useFrameColors, useAddMetadata } from '../../../data/metadata'
import { useInventory } from '../../../data/inventory'
import { usePastExaminations, type PastExam } from '../../../data/examinations'
import { uploadPrescriptionImage } from '../../../lib/storage'
import { emptyExam, type Exam } from '../types'

const small =
  'rounded-md border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-brand'

const field =
  'rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'

function ExamRow({ index }: { index: number }) {
  const { t } = useI18n()
  const { state, updateExam, removeExam } = usePOS()
  const exam = state.examinations[index]
  const lensTypes = useLensTypes()
  const frameColors = useFrameColors()
  const frames = useInventory('Frame')
  const addLensType = useAddMetadata('lens_types')
  const addFrameColor = useAddMetadata('frame_colors')
  const rowRef = useRef<HTMLDivElement>(null)

  /** Persist a free-typed value into a metadata table when it's new. */
  function maybeAddOption(
    value: string | undefined,
    known: readonly { name: string }[] | undefined,
    add: (name: string) => void,
  ) {
    const v = (value ?? '').trim()
    if (!v) return
    const exists = (known ?? []).some(
      (o) => o.name.trim().toLowerCase() === v.toLowerCase(),
    )
    if (!exists) add(v)
  }

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

  function onRxKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const root = rowRef.current
    if (!root) return
    const fields = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-rx]'))
    const next = fields[fields.indexOf(e.currentTarget) + 1]
    if (next) {
      next.focus()
      next.select()
    }
  }

  const numCol = (label: string, key: keyof Exam, w = 'w-16') => (
    <label className="flex flex-col">
      <span className="mb-0.5 text-[10px] font-semibold text-faint">{label}</span>
      <input
        data-rx
        className={`${small} ${w}`}
        value={String(exam[key] ?? '')}
        onChange={(e) => upd({ [key]: e.target.value } as Partial<Exam>)}
        onKeyDown={onRxKeyDown}
      />
    </label>
  )

  return (
    <div ref={rowRef} dir="ltr" className="rounded-xl border border-brand-faint bg-brand-bg/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Exam Type')}</span>
          <select
            className={`${small} w-32`}
            value={String(exam.exam_type ?? 'Distance')}
            onChange={(e) => upd({ exam_type: e.target.value })}
          >
            <option value="Distance">{t('Distance')}</option>
            <option value="Reading">{t('Reading')}</option>
            <option value="Contact Lenses">{t('Contact Lenses')}</option>
          </select>
        </label>

        <div className="flex items-end gap-1 rounded-md bg-white/50 p-1">
          {numCol('R.SPH', 'sphere_od')}
          {numCol('R.CYL', 'cylinder_od')}
          {numCol('R.AX', 'axis_od', 'w-14')}
        </div>
        <div className="flex items-end gap-1 rounded-md bg-white/50 p-1">
          {numCol('L.SPH', 'sphere_os')}
          {numCol('L.CYL', 'cylinder_os')}
          {numCol('L.AX', 'axis_os', 'w-14')}
        </div>
        {numCol('IPD', 'ipd', 'w-14')}

        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Lens Type')}</span>
          <input
            data-rx
            className={`${small} w-40`}
            list="lens-types"
            value={String(exam.lens_info ?? '')}
            onChange={(e) => upd({ lens_info: e.target.value })}
            onKeyDown={onRxKeyDown}
            onBlur={(e) =>
              maybeAddOption(e.target.value, lensTypes.data, (name) =>
                addLensType.mutate(name),
              )
            }
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
            data-rx
            className={`${small} w-40`}
            list="frame-products"
            value={String(exam.frame_info ?? '')}
            onChange={(e) => upd({ frame_info: e.target.value })}
            onKeyDown={onRxKeyDown}
          />
          <datalist id="frame-products">
            {(frames.data ?? []).map((f) => (
              <option key={f.id} value={f.name} />
            ))}
          </datalist>
        </label>

        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">{t('Color')}</span>
          <input
            data-rx
            className={`${small} w-28`}
            list="frame-colors"
            value={String(exam.frame_color ?? '')}
            onChange={(e) => upd({ frame_color: e.target.value })}
            onKeyDown={onRxKeyDown}
            onBlur={(e) =>
              maybeAddOption(e.target.value, frameColors.data, (name) =>
                addFrameColor.mutate(name),
              )
            }
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

  function use(p: PastExam) {
    const e = emptyExam()
    addExam({
      ...e,
      exam_type: p.exam_type ?? e.exam_type,
      sphere_od: p.sphere_od ?? '',
      cylinder_od: p.cylinder_od ?? '',
      axis_od: p.axis_od ?? '',
      sphere_os: p.sphere_os ?? '',
      cylinder_os: p.cylinder_os ?? '',
      axis_os: p.axis_os ?? '',
      ipd: p.ipd ?? '',
      lens_info: p.lens_info ?? '',
      frame_info: p.frame_info ?? '',
      frame_color: p.frame_color ?? '',
      frame_status: 'New',
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
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(past.data ?? []).map((p) => (
            <div key={p.id} className="rounded-lg border border-brand-faint bg-white p-3 text-xs">
              <div className="mb-1 font-semibold text-brand">
                {(p.sale.order_date ?? '').slice(0, 10) || 'N/A'}
                {p.sale.invoice_no ? ` · #${p.sale.invoice_no}` : ''}
              </div>
              <div>
                OD: {p.sphere_od || '-'}/{p.cylinder_od || '-'}x{p.axis_od || '-'}
              </div>
              <div>
                OS: {p.sphere_os || '-'}/{p.cylinder_os || '-'}x{p.axis_os || '-'}
              </div>
              <div className="text-muted">IPD: {p.ipd || '-'}</div>
              <button
                onClick={() => use(p)}
                className="mt-2 rounded-md bg-brand px-2 py-1 text-white"
              >
                {t('Use this')}
              </button>
            </div>
          ))}
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
