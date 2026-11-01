/**
 * CamelCase initials matcher.
 * Splits a query into initials (e.g. "AAL" -> ["a", "a", "l"])
 * and matches against node names where each initial appears in order
 * at word boundaries (PascalCase / camelCase).
 *
 * Example: "AAL" matches "AbstractApiLayer" because:
 *   A → AbstractApiLayer starts with 'A' ✓
 *   A → ...Api... has 'A' after a word boundary ✓
 *   L → ...Layer has 'L' after a word boundary ✓
 */

// Regex to find the next word boundary (start of a capital letter or digit segment)
const WORD_BOUNDARY_RE = /[A-Z][a-z]*|^\d+/g

/**
 * Extract initials from a query string.
 * "AAL" -> ["a", "a", "l"]
 * "ML" -> ["m", "l"]
 */
export function queryInitials(query: string): string[] {
  return query.toLowerCase().split("").filter(Boolean)
}

/**
 * Extract word-start characters from a PascalCase/camelCase name.
 * "AbstractApiLayer" -> ["a", "a", "l"]
 * "buildService" -> ["b", "s"]
 * "CodeGraphBuilder" -> ["c", "g", "b"]
 */
export function nameInitials(name: string): string[] {
  const segments = name.match(WORD_BOUNDARY_RE) ?? []
  return segments.map((s) => s[0].toLowerCase())
}

/**
 * Check if query initials match name initials in order.
 * Returns true if each initial in `queryInitials` appears at a word boundary
 * in `name` in the same order.
 */
export function matchesCamelCaseInitials(query: string, name: string): boolean {
  const qInitials = queryInitials(query)
  const nInitials = nameInitials(name)

  if (qInitials.length === 0 || nInitials.length < qInitials.length) {
    return false
  }

  let qi = 0
  for (const ni of nInitials) {
    if (qi < qInitials.length && ni === qInitials[qi]) {
      qi++
    }
  }

  return qi === qInitials.length
}

/**
 * Convert a camelCase/PascalCase name to snake_case.
 * "AbstractApiLayer" -> "abstract_api_layer"
 * "buildService" -> "build_service"
 */
export function camelToSnake(name: string): string {
  return name
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "")
    .replace(/_+/g, "_")
}
