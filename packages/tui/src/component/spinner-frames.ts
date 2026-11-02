export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * BanyanCode's sprout spinner: a seedling turning through a full braille cycle.
 * 12 fps, so a spinner shares the TUI's motion budget instead of starting its
 * own faster loop.
 */
export const SPROUT_FRAMES = [
  "⢀",
  "⣀",
  "⣄",
  "⣤",
  "⣦",
  "⣶",
  "⣷",
  "⣿",
  "⣾",
  "⣶",
  "⣦",
  "⣤",
  "⣄",
  "⣀",
]

export const SPROUT_INTERVAL_MS = 1000 / 12
