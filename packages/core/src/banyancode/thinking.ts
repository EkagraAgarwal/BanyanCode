export * as Thinking from "./thinking"

import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from "../v1/config/banyan-config"

export { DEFAULT_THINKING_LEVEL, THINKING_LEVELS }

// Weakest to strongest. Used for nearest-fallback when the exact level is not
// a key of the model's variant map. "off" is handled separately (omit).
const LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"] as const

const isKnownLevel = (level: string): level is (typeof THINKING_LEVELS)[number] =>
  (THINKING_LEVELS as readonly string[]).includes(level)

/**
 * Map a thinking level to a concrete variant id for the given model.
 *
 * `available` is the key set of the model's variant map
 * (`ProviderTransform.variants(model)` keys on V1, catalog variant ids on V2).
 * Returns undefined when thinking should be omitted (off without an off/none
 * key, unknown level, or no usable key) — callers treat undefined as "send
 * nothing" so an unsupported level never becomes a provider 400.
 */
export const resolveThinkingVariant = (
  level: string | undefined | null,
  available: string[] | readonly string[] | Record<string, unknown>,
): string | undefined => {
  if (level === undefined || level === null) return undefined
  const keys = Array.isArray(available) ? available : Object.keys(available)
  if (keys.length === 0) return undefined
  // off: use the model's explicit off/none key when present, else omit.
  if (level === "off" || level === "none") {
    if (keys.includes("off")) return "off"
    if (keys.includes("none")) return "none"
    return undefined
  }
  // Exact hit covers known levels and custom variant-id passthrough.
  if (keys.includes(level)) return level
  if (!isKnownLevel(level)) return undefined
  const index = (LADDER as readonly string[]).indexOf(level)
  if (index === -1) return undefined
  // Nearest fallback: strongest available at-or-below, else closest above.
  for (let i = index; i >= 0; i--) {
    const candidate = LADDER[i]
    if (candidate !== undefined && keys.includes(candidate)) return candidate
  }
  for (let i = index + 1; i < LADDER.length; i++) {
    const candidate = LADDER[i]
    if (candidate !== undefined && keys.includes(candidate)) return candidate
  }
  return undefined
}

/** Resolve the configured thinking level: per-agent override, else default. */
export const resolveThinkingLevel = (
  thinking: string | undefined | null,
  defaultLevel?: string | undefined | null,
): string => thinking ?? defaultLevel ?? DEFAULT_THINKING_LEVEL
