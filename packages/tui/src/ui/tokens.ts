export const space = {
  none: 0,
  xs: 0,
  sm: 1,
  md: 2,
  lg: 3,
  xl: 4,
} as const

export const fontWeight = {
  regular: 0,
  bold: 1,
  dim: 2,
} as const

export const density = {
  rowGap: space.sm,
  sectionGap: space.md,
  columnGap: space.sm,
  blockGap: space.lg,
} as const

export const separator = {
  thin: "─",
  thick: "━",
  double: "═",
} as const

export const glyph = {
  bullet: "●",
  circle: "○",
  half: "◐",
  cross: "✗",
  empty: "∅",
  loading: "◌",
  arrow: "→",
  pipe: "│",
  tee: "├",
  corner: "└",
  branch: "┌",
  expand: "▼",
  collapse: "▶",
} as const
