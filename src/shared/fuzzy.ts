/** Tiny dependency-free fuzzy matcher for the command palette. */

/** Score a single lowercase query token against one target string. -1 = no match. */
export function scoreToken(token: string, target: string): number {
  const t = target.toLowerCase()
  const idx = t.indexOf(token)
  if (idx >= 0) {
    // substring match: earlier and tighter is better, prefix gets a bonus
    return 100 - Math.min(idx, 50) + (idx === 0 ? 25 : 0) + Math.max(0, 10 - (t.length - token.length))
  }
  // subsequence match (e.g. "cwl" -> "cloudwatch logs")
  let qi = 0
  for (let i = 0; i < t.length && qi < token.length; i++) {
    if (t[i] === token[qi]) qi++
  }
  return qi === token.length ? 10 : -1
}

/**
 * Score a whole query against a list of haystack strings.
 * Every whitespace-separated token must match at least one haystack, otherwise -1.
 */
export function scoreQuery(query: string, haystacks: string[]): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 0
  let total = 0
  for (const token of tokens) {
    let best = -1
    for (const h of haystacks) {
      const s = scoreToken(token, h)
      if (s > best) best = s
    }
    if (best < 0) return -1
    total += best
  }
  return total
}
