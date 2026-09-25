import { describe, expect, it } from 'vitest'
import { emptyExam, needsExamination } from './types'

describe('emptyExam', () => {
  it('matches the legacy defaults', () => {
    expect(emptyExam()).toEqual({
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
    })
  })

  it('returns a fresh object each call (no shared mutation)', () => {
    const a = emptyExam()
    const b = emptyExam()
    a.sphere_od = '1.00'
    expect(b.sphere_od).toBe('')
  })
})

describe('needsExamination', () => {
  it('is true only for frames and contact lenses', () => {
    expect(needsExamination('Frame')).toBe(true)
    expect(needsExamination('ContactLens')).toBe(true)
    expect(needsExamination('Sunglasses')).toBe(false)
    expect(needsExamination('Accessory')).toBe(false)
    expect(needsExamination('Other')).toBe(false)
    expect(needsExamination(null)).toBe(false)
  })
})
