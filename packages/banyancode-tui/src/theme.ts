import type { ResolvedTheme } from "@opencode/theme/tui"

/**
 * The v1 surfaces were written against a flat `{ text, textMuted, primary,
 * success, warning, error, info, border, backgroundElement }` palette. v2's
 * ResolvedTheme nests the same semantics, so every ported component reads
 * colors through this adapter instead of hard-coding token paths.
 */
export function palette(theme: ResolvedTheme) {
  return {
    text: theme.text.base,
    muted: theme.text.muted,
    faint: theme.text.faint,
    primary: theme.hue.interactive[300],
    accent: theme.hue.accent[300],
    info: theme.text.feedback.info.base,
    success: theme.text.feedback.success.base,
    warning: theme.text.feedback.warning.base,
    error: theme.text.feedback.error.base,
    border: theme.border.base,
    borderSubtle: theme.text.faint,
    surface: theme.background.raised.base,
    surfaceHigh: theme.background.raised.high,
    background: theme.background.base,
    leaf: theme.growth.leaf,
    highlight: theme.growth.highlight,
    done: theme.growth.done,
    faded: theme.growth.faded,
    wood: theme.growth.wood,
    bright: theme.growth.bright,
    diffAdded: theme.diff.text.added,
    diffRemoved: theme.diff.text.removed,
  }
}

export type Palette = ReturnType<typeof palette>
