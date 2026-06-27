import type { OrderExamination } from '../lib/database.types'
import { prescriptionImageUrl } from '../lib/storage'
import { useI18n } from '../i18n/LanguageContext'
import { useOrderExaminations } from '../data/examinations'

/** Presentational list of prescriptions/readings for an order. */
export function ExamList({ exams }: { exams: OrderExamination[] }) {
  const { t } = useI18n()
  if (!exams.length) return null
  return (
    <div className="space-y-2">
      {exams.map((e, i) => (
        <div key={e.id} className="rounded-lg border border-line/60 bg-white p-3">
          <div className="mb-1 font-semibold text-brand-dark">
            {t('Prescription')} {exams.length > 1 ? `#${i + 1}` : ''}{' '}
            <span className="font-normal text-faint">{e.exam_type}</span>
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
            <div>OD: {e.sphere_od || '-'} / {e.cylinder_od || '-'} × {e.axis_od || '-'}</div>
            <div>OS: {e.sphere_os || '-'} / {e.cylinder_os || '-'} × {e.axis_os || '-'}</div>
            <div>IPD: {e.ipd || '-'}</div>
            <div>{t('Lens Type')}: {e.lens_info || '-'}</div>
            <div>{t('Frame')}: {e.frame_info || '-'}</div>
            <div>{t('Color')}: {e.frame_color || '-'}</div>
          </div>
          {e.image_path && (
            <a
              href={prescriptionImageUrl(e.image_path)}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-brand hover:underline"
            >
              📎 {t('View Image')}
            </a>
          )}
        </div>
      ))}
    </div>
  )
}

/** Fetches an order's examinations on demand (for lists that don't embed them). */
export function OrderExamsLazy({ saleId }: { saleId: string }) {
  const exams = useOrderExaminations(saleId)
  if (!exams.data?.length) return null
  return (
    <div className="mt-2">
      <ExamList exams={exams.data} />
    </div>
  )
}
