/**
 * The command palette's matcher (§2.7: "jump to any run or agent by fuzzy name").
 *
 * Hand-rolled on purpose — §16.1's dependency policy takes dependencies for "parsing,
 * accessibility, or browser-compatibility problems", and explicitly not for "trivial
 * wrappers or flowition-specific domain logic". A subsequence scorer over run ids and agent
 * labels is forty lines and knows what a run id looks like; a fuzzy-search package is a
 * supply-chain surface for the same result.
 *
 * Scoring, in one sentence: characters must appear in order (a subsequence match), and the
 * score rewards matches that start a word or the string and matches that run consecutively.
 * That is enough to put `flo_ab12` above `workflow-b12` for the query `ab12`, which is the
 * only ranking property the palette actually needs.
 */

export interface FuzzyMatch {
  score: number
  /** The matched character indices, for the highlight. */
  indices: number[]
}

/** Can the remaining query characters still be found, in order, from `from`? */
const fits = (needle: string[], k: number, haystack: string, from: number): boolean => {
  let at = from
  for (let i = k; i < needle.length; i++) {
    const found = haystack.indexOf(needle[i]!, at)
    if (found < 0) return false
    at = found + 1
  }
  return true
}

const isBoundary = (text: string, index: number): boolean => {
  if (index === 0) return true
  const previous = text[index - 1]!
  return previous === ' ' || previous === '_' || previous === '-' || previous === '/'
    || previous === '.' || previous === ':'
}

/**
 * Score `query` against `text`. `null` when the query is not a subsequence of the text.
 * An empty query matches everything with score 0, which keeps the unfiltered palette in
 * its natural (caller-supplied) order.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] }
  const needle = [...query.toLowerCase()].filter((c) => c !== ' ')
  const haystack = text.toLowerCase()
  const indices: number[] = []
  let score = 0
  let at = 0
  let previous = -2
  for (let k = 0; k < needle.length; k++) {
    const character = needle[k]!
    let found = haystack.indexOf(character, at)
    if (found < 0) return null
    // A purely greedy scan takes the FIRST occurrence, which ranks `judge-panel-auth`
    // below a string whose `a`, `u`, `t`, `h` happen to be scattered: the `a` of "auth"
    // would be spent on the one in "panel". So when the first hit is neither a word start
    // nor a continuation of the previous match, look ahead for one that is — and take it
    // only if the REST of the query still fits after it, so this never turns a match into
    // a miss.
    if (!(found === previous + 1 || isBoundary(text, found))) {
      for (let j = found + 1; j < haystack.length; j++) {
        if (haystack[j] !== character) continue
        if (!(j === previous + 1 || isBoundary(text, j))) continue
        if (fits(needle, k + 1, haystack, j + 1)) found = j
        break
      }
    }
    score += 1
    if (found === previous + 1) score += 3          // consecutive run
    if (isBoundary(text, found)) score += 2         // word start
    if (found === 0) score += 2                     // string start
    indices.push(found)
    previous = found
    at = found + 1
  }
  // Shorter haystacks win ties: `flo_ab12` should beat `flo_ab12_compare`.
  return { score: score - text.length * 0.01, indices }
}

export interface Rankable { text: string }

/** Filter + sort by score, stable within equal scores (the caller's order is meaningful). */
export function rank<T extends Rankable>(query: string, items: T[]): (T & { match: FuzzyMatch })[] {
  const scored: (T & { match: FuzzyMatch })[] = []
  for (const item of items) {
    const match = fuzzyMatch(query, item.text)
    if (match) scored.push({ ...item, match })
  }
  if (!query) return scored
  return scored
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.match.score - a.item.match.score || a.index - b.index)
    .map(({ item }) => item)
}
