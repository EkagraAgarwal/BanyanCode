/**
 * Pure-TS Levenshtein distance implementation.
 * No external dependencies.
 */

export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length

  if (m === 0) return n
  if (n === 0) return m

  // Use two rows instead of full matrix — O(min(m,n)) space
  let prev = new Uint16Array(n + 1)
  let curr = new Uint16Array(n + 1)

  for (let j = 0; j <= n; j++) {
    prev[j] = j
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      )
    }
    // Swap rows
    const tmp = prev
    prev = curr
    curr = tmp
  }

  return prev[n]
}
