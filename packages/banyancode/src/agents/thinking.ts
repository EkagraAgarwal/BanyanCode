/**
 * v1 `thinking` → v2 reasoning variant mapping.
 *
 * v1 carried a BanyanCode-only `thinking` level (`off`…`ultra`) on the agent
 * and resolved it at spawn time against the model's variant keys. v2 has no
 * `thinking` field: reasoning effort is a *model variant* (`Model.Ref.variant`,
 * see `packages/core/src/variant.ts`), and each provider protocol decides what
 * a variant id means (`none`/`thinking`, `low`/`medium`/`high`/`xhigh`/`max`,
 * or a thinking-token budget). The agent's `model` ref carries the variant, so
 * this module translates the v1 level onto the ids the selected model actually
 * offers, using the same nearest-fallback ladder v1 used.
 *
 * Mapping table (raw v1 level → preferred v2 variant id):
 *
 *   off / none → none            (falls back to `off` when a model uses that id)
 *   minimal    → minimal
 *   low        → low
 *   medium     → medium
 *   high       → high
 *   xhigh      → xhigh
 *   max        → max
 *   ultra      → max             (v2 has no `ultra` variant)
 *
 * Anything else is treated as a raw variant id: an exact hit wins, an unknown
 * literal is dropped so a typo never becomes a provider 400. When the model
 * catalog is unavailable the variant is omitted rather than guessed; the one
 * exception is an explicitly configured `variant`, which is an escape hatch and
 * is passed through unvalidated (v1 behaved the same).
 */

/** Weakest → strongest. Used for nearest-fallback, as in v1 `Thinking.LADDER`. */
export const LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"] as const

export const MAPPING = {
  off: "none",
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "max",
} as const

const knownLevel = (level: string): level is keyof typeof MAPPING => Object.hasOwn(MAPPING, level)

/**
 * Resolve a v1 thinking level to a variant id the model offers.
 *
 * `available` is the model's `variants.map((variant) => variant.id)`. An empty
 * or missing list means "unknown model": callers decide whether to trust a raw
 * escape hatch or omit the variant.
 */
export const resolveThinkingVariant = (
  level: string | undefined,
  available: readonly string[] | undefined,
): string | undefined => {
  if (level === undefined || available === undefined || available.length === 0) return undefined
  // Exact hit covers known levels and custom variant-id passthrough.
  if (available.includes(level)) return level
  if (level === "off" || level === "none") {
    if (available.includes("none")) return "none"
    if (available.includes("off")) return "off"
    return undefined
  }
  if (!knownLevel(level)) return undefined
  const preferred = MAPPING[level]
  if (available.includes(preferred)) return preferred
  const index = LADDER.indexOf(level as (typeof LADDER)[number])
  if (index === -1) return undefined
  // Nearest fallback: strongest available at-or-below, else closest above.
  for (let i = index; i >= 0; i--) {
    const candidate = LADDER[i]
    if (candidate !== undefined && available.includes(candidate)) return candidate
  }
  for (let i = index + 1; i < LADDER.length; i++) {
    const candidate = LADDER[i]
    if (candidate !== undefined && available.includes(candidate)) return candidate
  }
  return undefined
}

export interface VariantInput {
  /** Explicit `agent.<id>.variant` (wins over `thinking`). */
  readonly variant?: string
  /** `agent.<id>.thinking` or `banyancode_thinking_default`. */
  readonly thinking?: string
  /** Variant already on the agent's model ref (from markdown or the catalog). */
  readonly current?: string
  /** The model's variant ids, or undefined when the catalog does not know the model. */
  readonly available?: readonly string[]
}

/**
 * Choose the variant to stamp on the agent's model ref, in v1 precedence:
 * explicit `variant` → `thinking` → existing variant.
 */
export const resolveVariant = (input: VariantInput): string | undefined => {
  if (input.variant !== undefined) {
    if (input.available === undefined) return input.variant
    return input.available.includes(input.variant) ? input.variant : undefined
  }
  if (input.thinking !== undefined) {
    // An unresolvable level (unknown model, unsupported effort) keeps whatever
    // the agent already had instead of wiping it.
    return resolveThinkingVariant(input.thinking, input.available) ?? input.current
  }
  return input.current
}
