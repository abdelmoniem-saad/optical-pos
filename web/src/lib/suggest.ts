/**
 * Filtering for a type-ahead list. Pure, in lib/ with the other pure helpers
 * (payments.ts has sumByMethod and friends) so it can be tested without a
 * browser or a React tree.
 */

export interface SuggestOption {
  id: string
  name: string
}

/**
 * Matches, ordered so the most useful answer is first.
 *
 * STARTS-WITH FIRST, then the rest. A lens catalogue is full of families that
 * share a prefix - "Progressive..." and "Photochromic..." both begin with P,
 * "Single Vision" and "Semi-Rimless" with S - so typing "pro" should put
 * Progressive above every other P entry rather than leaving the exact match
 * buried in alphabetical order. Both groups keep their original order within
 * themselves, because the catalogue's own sort_order is the shop's ranking and
 * this component has no business second-guessing it.
 *
 * Case-insensitive and substring-based, not prefix-only: with lens names this
 * long, "chromic" is how people search for Photochromic, not "pho".
 */
export function filterOptions(
  options: readonly SuggestOption[],
  term: string,
): SuggestOption[] {
  const q = term.trim().toLowerCase()
  if (!q) return [...options]

  const starts: SuggestOption[] = []
  const contains: SuggestOption[] = []
  for (const o of options) {
    const n = o.name.toLowerCase()
    if (n.startsWith(q)) starts.push(o)
    else if (n.includes(q)) contains.push(o)
  }
  return [...starts, ...contains]
}
