import { describe, it, expect } from 'vitest'
import { findOrphanedImages, orphanBytes, type StorageFile } from '../lib/storageOrphans'

const PREFIX = 'store/s1/orders'
const file = (name: string, size?: number): StorageFile =>
  size === undefined ? { name } : ({ name, size } as StorageFile)

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
