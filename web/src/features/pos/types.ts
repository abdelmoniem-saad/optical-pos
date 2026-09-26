import type { Customer, OrderExaminationInsert } from '../../lib/database.types'
import type { CartLine } from '../../data/sales'

export type POSStep = 'category' | 'customer' | 'additional' | 'cart'

export type Category = 'Frame' | 'Sunglasses' | 'ContactLens' | 'Accessory' | 'Other'

/** One examination row (an order can have several). */
export type Exam = Omit<OrderExaminationInsert, 'sale_id'>

export type { CartLine, Customer }

/** A blank examination row with the same defaults as the Flet exam step. */
export function emptyExam(): Exam {
  return {
    exam_type: 'Distance',
    sphere_od: '',
    cylinder_od: '',
    axis_od: '',
    sphere_os: '',
    cylinder_os: '',
    axis_os: '',
    ipd: '',
    lens_info: '',
    frame_info: '',
    frame_color: '',
    frame_status: 'New',
    image_path: '',
  }
}

/** Categories that require the examination step (Glasses / Contact Lenses). */
export function needsExamination(category: Category | null): boolean {
  return category === 'Frame' || category === 'ContactLens'
}

/**
 * Category for a LOADED invoice (day navigation). Legacy product rows carry
 * loose category names ('Contact Lenses', 'نظارة', …), so matching is fuzzy -
 * and the decisive rule: an invoice WITH examinations must always land on an
 * exam category, otherwise the prescription section would be hidden on open.
 */
export function inferLoadedCategory(
  productCategory: string | null | undefined,
  hasExams: boolean,
): Category {
  const pc = (productCategory ?? '').toLowerCase()
  let c: Category = 'Other'
  if (pc.includes('contact')) c = 'ContactLens'
  else if (pc.includes('sun') || pc.includes('شمس')) c = 'Sunglasses'
  else if (pc.includes('frame') || pc.includes('glass') || pc.includes('نظار')) c = 'Frame'
  else if (pc.includes('access')) c = 'Accessory'
  if (hasExams && !needsExamination(c)) c = 'Frame'
  return c
}
