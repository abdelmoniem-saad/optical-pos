import { describe, it, expect } from 'vitest'
import { findOrphanedImages, orphanBytes, type StorageFile } from '../lib/storageOrphans'

const PREFIX = 'store/s1/orders'
// Every fixture file is a month old unless a test says otherwise, so the
// 14-day age gate (031) does not hide what these tests are about.
const OLD = '2020-01-01T00:00:00Z'
const file = (name: string, size?: number): StorageFile =>
  size === undefined ? { name, created_at: OLD } : ({ name, size, created_at: OLD } as StorageFile)

describe('findOrphanedImages', () => {
  it('flags a file no sales row references', () => {
    // A photo uploaded during a checkout that then failed half-way: it is in
    // the bucket, but no sale points at it.
    const orphans = findOrphanedImages(
      [file('100-rx-abc.jpg')],
      [],
      PREFIX,
    )
    expect(orphans).toEqual([`${PREFIX}/100-rx-abc.jpg`])
  })

  it('KEEPS a file a live sale still references', () => {
    const orphans = findOrphanedImages(
      [file('100-rx-abc.jpg')],
      [`${PREFIX}/100-rx-abc.jpg`],
      PREFIX,
    )
    expect(orphans).toEqual([])
  })

  it('KEEPS a file a VOIDED sale still references - the bias is toward keep', () => {
    // The whole safety property: deleting a live-looking photo is far worse
    // than leaving a stray. A voided invoice's image is still referenced by its
    // row, so it is never a deletion candidate here.
    const orphans = findOrphanedImages(
      [file('200-frame-xyz.jpg')],
      [`${PREFIX}/200-frame-xyz.jpg`],
      PREFIX,
    )
    expect(orphans).toEqual([])
  })

  it('returns only the unreferenced files when some are kept', () => {
    const orphans = findOrphanedImages(
      [file('a.jpg'), file('b.jpg'), file('c.jpg')],
      [`${PREFIX}/b.jpg`],
      PREFIX,
    )
    expect(orphans).toEqual([`${PREFIX}/a.jpg`, `${PREFIX}/c.jpg`])
  })

  it('never treats the empty-folder placeholder as an orphan', () => {
    const orphans = findOrphanedImages(
      [file('.emptyFolderPlaceholder'), file('real-orphan.jpg')],
      [],
      PREFIX,
    )
    expect(orphans).toEqual([`${PREFIX}/real-orphan.jpg`])
  })

  it('ignores blank / null names and null references without throwing', () => {
    const orphans = findOrphanedImages(
      [file(''), file('   '), { name: '' } as StorageFile],
      [null, undefined, '  '],
      PREFIX,
    )
    expect(orphans).toEqual([])
  })

  it('tolerates a trailing slash on the prefix', () => {
    const orphans = findOrphanedImages(
      [file('x.jpg')],
      [`${PREFIX}/x.jpg`],
      `${PREFIX}/`,
    )
    expect(orphans).toEqual([])
  })

  it('keeps a file referenced by its bare name too - defensive, never over-deletes', () => {
    // If a caller passed unprefixed reference paths, the file must still be
    // protected rather than deleted on a prefix mismatch.
    const orphans = findOrphanedImages(
      [file('y.jpg')],
      ['y.jpg'],
      PREFIX,
    )
    expect(orphans).toEqual([])
  })

  it('an empty bucket has nothing to delete', () => {
    expect(findOrphanedImages([], [], PREFIX)).toEqual([])
  })
})

describe('orphanBytes', () => {
  it('sums the sizes of the orphan files only', () => {
    const files = [file('a.jpg', 100), file('b.jpg', 250), file('c.jpg', 999)]
    expect(orphanBytes(files, ['a.jpg', 'c.jpg'])).toBe(1099)
  })

  it('reads size from metadata when the top-level field is absent', () => {
    const files = [{ name: 'a.jpg', metadata: { size: 42 } } as unknown as StorageFile]
    expect(orphanBytes(files, ['a.jpg'])).toBe(42)
  })

  it('counts a size-less file as zero rather than throwing', () => {
    expect(orphanBytes([file('a.jpg')], ['a.jpg'])).toBe(0)
  })
})

describe('the 14-day age gate (031, design 4.1)', () => {
  const NOW = Date.parse('2026-11-27T12:00:00Z')
  const DAY = 24 * 60 * 60 * 1000
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()

  it('never lists a photo younger than 14 days - its sale may not be written yet', () => {
    // A photo attached in the cart is uploaded before checkout; a queued
    // offline checkout may only reach the database the next day.
    const files = [{ name: 'young.jpg', created_at: at(13 * DAY) }]
    expect(findOrphanedImages(files, [], PREFIX, { now: NOW })).toEqual([])
  })

  it('lists an unreferenced photo once it is 14 days old', () => {
    const files = [{ name: 'old.jpg', created_at: at(14 * DAY) }]
    expect(findOrphanedImages(files, [], PREFIX, { now: NOW })).toEqual([`${PREFIX}/old.jpg`])
  })

  it('keeps a file whose upload time is missing or unreadable', () => {
    const files: StorageFile[] = [{ name: 'a.jpg' }, { name: 'b.jpg', created_at: null }, { name: 'c.jpg', created_at: 'soon' }]
    expect(findOrphanedImages(files, [], PREFIX, { now: NOW })).toEqual([])
  })

  it('keeps every referenced photo of a store with 1,500 sales', () => {
    // The old keep-list was one select capped at 1,000 rows; the paged one
    // (referencedPaths) returns all of them, and the diff keeps them all.
    const names = Array.from({ length: 1500 }, (_, i) => `rx-${i}.jpg`)
    const files = names.map((name) => ({ name, created_at: at(100 * DAY) }))
    const referenced = names.map((n) => `${PREFIX}/${n}`)
    expect(findOrphanedImages(files, referenced, PREFIX, { now: NOW })).toEqual([])
  })
})
