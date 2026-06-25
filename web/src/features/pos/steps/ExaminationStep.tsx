import { useEffect, useState } from 'react'
import { usePOS } from '../POSContext'
import { useLensTypes, useFrameColors } from '../../../data/metadata'
import { useInventory } from '../../../data/inventory'
import { usePastExaminations, type PastExam } from '../../../data/examinations'
import { emptyExam, type Exam } from '../types'

const small =
  'rounded-md border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-brand'

function ExamRow({ index }: { index: number }) {
  const { state, updateExam, removeExam } = usePOS()
  const exam = state.examinations[index]
  const lensTypes = useLensTypes()
  const frameColors = useFrameColors()
  const frames = useInventory('Frame')

  const upd = (p: Partial<Exam>) => updateExam(index, p)
  const numCol = (label: string, key: keyof Exam, w = 'w-16') => (
    <label className="flex flex-col">
      <span className="mb-0.5 text-[10px] font-semibold text-faint">{label}</span>
      <input
        className={`${small} ${w}`}
        value={String(exam[key] ?? '')}
        onChange={(e) => upd({ [key]: e.target.value } as Partial<Exam>)}
      />
    </label>
  )

  return (
    <div className="rounded-xl border border-brand-faint bg-brand-bg/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">Exam Type</span>
          <select
            className={`${small} w-32`}
            value={String(exam.exam_type ?? 'Distance')}
            onChange={(e) => upd({ exam_type: e.target.value })}
          >
            <option>Distance</option>
            <option>Reading</option>
            <option>Contact Lenses</option>
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
          <span className="mb-0.5 text-[10px] font-semibold text-faint">Lens Type</span>
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
          <span className="mb-0.5 text-[10px] font-semibold text-faint">Frame</span>
          <input
            className={`${small} w-40`}
            list="frame-products"
            value={String(exam.frame_info ?? '')}
            onChange={(e) => upd({ frame_info: e.target.value })}
          />
          <datalist id="frame-products">
            {(frames.data ?? []).map((f) => (
              <option key={f.id} value={f.name} />
            ))}
          </datalist>
        </label>

        <label className="flex flex-col">
          <span className="mb-0.5 text-[10px] font-semibold text-faint">Color</span>
          <input
            className={`${small} w-28`}
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
          <span className="mb-0.5 text-[10px] font-semibold text-faint">Status</span>
          <select
            className={`${small} w-20`}
            value={String(exam.frame_status ?? 'New')}
            onChange={(e) => upd({ frame_status: e.target.value })}
          >
            <option>New</option>
            <option>Old</option>
          </select>
        </label>

        <button
          onClick={() => removeExam(index)}
          disabled={state.examinations.length <= 1}
          className="ml-auto rounded-md px-2 py-1.5 text-sm text-danger hover:bg-danger/10 disabled:opacity-30"
          title="Remove"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function PastPrescriptions({ customerId }: { customerId: string }) {
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
        Previous Prescriptions ({count}) {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(past.data ?? []).map((p) => (
            <div key={p.id} className="rounded-lg border border-brand-faint bg-white p-3 text-xs">
              <div className="mb-1 font-semibold text-brand">
                {(p.sale.order_date ?? '').slice(0, 10) || 'N/A'}
                {p.sale.invoice_no ? ` · #${p.sale.invoice_no}` : ''}
              </div>
              <div>OD: {p.sphere_od || '-'}/{p.cylinder_od || '-'}x{p.axis_od || '-'}</div>
              <div>OS: {p.sphere_os || '-'}/{p.cylinder_os || '-'}x{p.axis_os || '-'}</div>
              <div className="text-muted">IPD: {p.ipd || '-'}</div>
              <button
                onClick={() => use(p)}
                className="mt-2 rounded-md bg-brand px-2 py-1 text-white"
              >
                Use this
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ExaminationStep() {
  const {
    state,
    addExam,
    back,
    goToAdditional,
    saveExamsAndProceed,
    setDoctorName,
    setDeliveryDate,
  } = usePOS()

  // Ensure there's always at least one row.
  useEffect(() => {
    if (state.examinations.length === 0) addExam()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const field =
    'rounded-lg border border-line bg-white px-3 py-2 outline-none focus:border-brand'

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xl font-bold text-brand-dark">Step 2: Order &amp; Examination</h2>
        <span className="text-sm text-success">#{state.invoiceNo}</span>
      </div>
      <p className="mb-4 text-sm text-muted">
        {state.customer?.name ?? 'Walk-in Customer'}
      </p>

      {state.customer && <PastPrescriptions customerId={state.customer.id} />}

      <div className="mb-4 flex flex-wrap gap-3">
        <label className="flex flex-col">
          <span className="mb-0.5 text-xs font-semibold text-faint">Delivery Date</span>
          <input
            type="date"
            className={field}
            value={state.deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
          />
        </label>
        <label className="flex flex-1 flex-col">
          <span className="mb-0.5 text-xs font-semibold text-faint">Doctor Name</span>
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
        className="mb-4 rounded-lg bg-brand-bg px-3 py-2 text-sm font-semibold text-brand-dark"
      >
        + Add Another Exam
      </button>

      {state.error && (
        <div className="mb-3 whitespace-pre-line rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {state.error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={back} className="rounded-lg border border-line px-4 py-2.5 text-muted hover:bg-surface">
          ← Back
        </button>
        <div className="flex gap-2">
          <button
            onClick={goToAdditional}
            className="rounded-lg bg-warning px-4 py-2.5 font-semibold text-white"
          >
            Add More Items
          </button>
          <button
            onClick={() => saveExamsAndProceed()}
            disabled={state.busy}
            className="rounded-lg bg-success px-4 py-2.5 font-semibold text-white disabled:opacity-60"
          >
            {state.busy ? 'Working…' : 'Next: Payment →'}
          </button>
        </div>
      </div>
    </div>
  )
}
