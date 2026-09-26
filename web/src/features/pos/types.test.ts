import { describe, expect, it } from 'vitest'
import { emptyExam, inferLoadedCategory, needsExamination } from './types'

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

describe('inferLoadedCategory (opening a saved invoice)', () => {
  it('maps recognizable product categories, including loose legacy names', () => {
    expect(inferLoadedCategory('Frame', false)).toBe('Frame')
    expect(inferLoadedCategory('ContactLens', false)).toBe('ContactLens')
    expect(inferLoadedCategory('Contact Lenses', false)).toBe('ContactLens')
    expect(inferLoadedCategory('Sunglasses', false)).toBe('Sunglasses')
    expect(inferLoadedCategory('sunglasses', false)).toBe('Sunglasses')
    expect(inferLoadedCategory('Accessory', false)).toBe('Accessory')
    expect(inferLoadedCategory('نظارة', false)).toBe('Frame')
  })

  it('falls back to Other when there are no exams and the category is unknown', () => {
    expect(inferLoadedCategory(null, false)).toBe('Other')
    // The reported scenario: a legacy junk row whose "category" is nonsense.
    expect(inferLoadedCategory('قرملس', false)).toBe('Other')
  })

  it('ALWAYS lands on an exam category when the invoice has examinations', () => {
    expect(inferLoadedCategory(null, true)).toBe('Frame')
    expect(inferLoadedCategory('Lens', true)).toBe('Frame')
    expect(inferLoadedCategory('Accessory', true)).toBe('Frame')
    expect(inferLoadedCategory('Contact Lenses', true)).toBe('ContactLens')
  })
})
