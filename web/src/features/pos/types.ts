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
