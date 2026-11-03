import type { RGBA } from "@opentui/core"
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { ToolLetter } from "./data/understory"

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
    /** User and info text, reads. */
    sky: theme.tool.read,
    /** Shell calls and section rules. */
    bark: theme.tool.shell,
    /** Verification and the running edge. */
    lime: theme.tool.verify,
    /** Web tools: the only kind with no existing role. */
    violet: theme.tool.web,
    tool: theme.tool,
  }
}

export type Palette = ReturnType<typeof palette>

/**
 * The colour a tool block carries. Kind is never conveyed by colour alone: the
 * block always draws its letter too, so a theme that collapses two kinds still
 * reads. Unclassified tools (`?`) stay muted.
 */
export function kindColor(letter: ToolLetter, theme: Palette): RGBA {
  if (letter === "R") return theme.tool.read
  if (letter === "S") return theme.tool.search
  if (letter === "E") return theme.tool.edit
  if (letter === "$") return theme.tool.shell
  if (letter === "V") return theme.tool.verify
  if (letter === "W") return theme.tool.web
  if (letter === "T") return theme.muted
  return theme.faint
}
