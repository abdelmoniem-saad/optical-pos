import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ar } from './translations'

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) return walk(p)
    if (!/\.(ts|tsx)$/.test(entry.name)) return []
    if (/\.test\./.test(entry.name)) return []
    return [p]
  })
}

/** Literal t('…') / t("…") calls. Dynamic keys (t(s), t(item.label)) are not
 *  statically checkable and are deliberately out of scope. */
const KEY_RE = /\bt\(\s*(?:'([^']+)'|"([^"]+)")\s*\)/g

describe('Arabic translations', () => {
  it('has no empty values', () => {
    const empty = Object.entries(ar)
      .filter(([, v]) => !String(v).trim())
      .map(([k]) => k)
    throwIfAny(empty, 'Empty Arabic values')
    expect(empty).toEqual([])
  })

  it('covers every literal t(...) key used in the app', () => {
    const missing = new Set<string>()
    for (const file of walk(SRC_DIR)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(KEY_RE)) {
        const key = m[1] ?? m[2]
        if (key && !(key in ar)) {
          missing.add(`${key}   (${file.slice(SRC_DIR.length).replace(/\\/g, '/')})`)
        }
      }
    }
    throwIfAny([...missing].sort(), 'Missing Arabic translations')
    expect(missing.size).toBe(0)
  })
})

function throwIfAny(items: string[], title: string): void {
  if (items.length === 0) return
  throw new Error(`${title} (${items.length}):\n${items.join('\n')}`)
}
