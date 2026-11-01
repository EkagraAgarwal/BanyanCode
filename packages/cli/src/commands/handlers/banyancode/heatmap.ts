/**
 * Activity heatmap for `banyancode stats --heatmap`.
 *
 * v1's grid renderer (`cli/cmd/stats.ts`) ported verbatim — same 7×N layout,
 * month labels, glyph tiers, 24-bit colours and box drawing. The only change
 * is the input: v2's `session.stats` reports per-day *steps*
 * (`SessionStats.Activity`), not per-day tokens, so the summary rows say
 * "steps" where v1 said "tokens".
 */

/** Default heatmap window: 12 months. */
export const HEATMAP_DEFAULT_DAYS = 365
/** ANSI 24-bit colour levels: blank → light gray → light red → medium red → dark red. */
const HEATMAP_COLORS = [
  null,
  [211, 211, 211],
  [244, 168, 168],
  [232, 84, 84],
  [185, 28, 28],
] as const
/** Block characters per intensity level (0 = blank). */
const HEATMAP_GLYPHS = [" ", "░", "▒", "▓", "█"] as const

/** Local-date key in ISO YYYY-MM-DD form (uses the host's local timezone). */
export function dateKey(epochMs: number): string {
  const d = new Date(epochMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Group `{ date, steps }` activity rows into a per-day bucket map. */
export function computeHeatmapBuckets(activity: ReadonlyArray<{ date: string; steps: number }>) {
  const buckets = new Map<string, number>()
  for (const entry of activity) buckets.set(entry.date, (buckets.get(entry.date) ?? 0) + entry.steps)
  return buckets
}

export interface HeatmapGrid {
  readonly lines: ReadonlyArray<string>
  readonly total: number
  readonly peak: number
  readonly peakDate: string | null
  readonly activeDays: number
  readonly days: number
  readonly startDate: string
  readonly endDate: string
}

/**
 * Build a 7-row × N-column ASCII heatmap from a bucket map. Pure: no I/O, no
 * clock. Inject `today` for deterministic tests. The default window is
 * `HEATMAP_DEFAULT_DAYS` days ending on `today` (local time).
 */
export function buildHeatmapGrid(
  buckets: ReadonlyMap<string, number>,
  options?: { today?: Date; days?: number },
): HeatmapGrid {
  const today = options?.today ?? new Date()
  const days = options?.days ?? HEATMAP_DEFAULT_DAYS
  const todayKey = dateKey(today.getTime())

  const start = new Date(today)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))

  // First-column alignment: pad with blanks until the first rendered day
  // falls on its day-of-week row. 0 = Mon, 6 = Sun, matching the row order below.
  const leadingPad = (start.getDay() + 6) % 7

  // Peak across the window so intensity scaling is stable regardless of
  // whether the user's peak day actually appears in the supplied buckets.
  let peak = 0
  let total = 0
  let activeDays = 0
  let peakDate: string | null = null
  for (const [key, value] of buckets) {
    if (key < dateKey(start.getTime()) || key > todayKey) continue
    total += value
    if (value > 0) activeDays++
    if (value > peak) {
      peak = value
      peakDate = key
    }
  }

  const rowLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  const totalCols = leadingPad + days
  const rows: string[][] = Array.from({ length: 7 }, () => new Array(totalCols).fill(" "))

  const cursor = new Date(start)
  for (let i = 0; i < days; i++) {
    const key = dateKey(cursor.getTime())
    const value = buckets.get(key) ?? 0
    const dayOfWeek = (cursor.getDay() + 6) % 7
    rows[dayOfWeek][leadingPad + i] = intensityGlyph(value, peak)
    cursor.setDate(cursor.getDate() + 1)
  }

  // Build month-label row aligned to the same column count as the data rows.
  const cursor2 = new Date(start)
  const monthSpans: Array<{ startCol: number; endCol: number; name: string }> = []
  let lastMonthCursor = -1
  for (let i = 0; i < days; i++) {
    const m = cursor2.getMonth()
    if (m !== lastMonthCursor) {
      monthSpans.push({
        startCol: leadingPad + i,
        endCol: 0,
        name: cursor2.toLocaleString("en-US", { month: "short" }),
      })
      lastMonthCursor = m
    }
    cursor2.setDate(cursor2.getDate() + 1)
  }
  for (let i = 0; i < monthSpans.length; i++) {
    monthSpans[i].endCol = i + 1 < monthSpans.length ? monthSpans[i + 1].startCol : totalCols
  }
  const labelChars = new Array(totalCols).fill(" ")
  for (const { startCol, endCol, name } of monthSpans) {
    const span = endCol - startCol
    const offset = Math.max(0, Math.floor((span - name.length) / 2))
    for (let i = 0; i < name.length && startCol + offset + i < totalCols; i++) {
      labelChars[startCol + offset + i] = name[i]
    }
  }
  const monthLabelRow = labelChars.join("")

  const coloredRows = rows.map((cells, rowIdx) => {
    const label = (rowLabels[rowIdx] + " ").padEnd(4)
    return label + cells.map((cell) => colorCell(cell)).join("")
  })

  return {
    lines: [monthLabelRow, ...coloredRows],
    total,
    peak,
    peakDate,
    activeDays,
    days,
    startDate: dateKey(start.getTime()),
    endDate: todayKey,
  }
}

/** Map a bucket value to a 5-level intensity glyph. */
function intensityGlyph(value: number, peak: number): string {
  if (value <= 0) return HEATMAP_GLYPHS[0]
  if (peak <= 0) return HEATMAP_GLYPHS[0]
  const ratio = value / peak
  if (ratio >= 0.75) return HEATMAP_GLYPHS[4]
  if (ratio >= 0.5) return HEATMAP_GLYPHS[3]
  if (ratio >= 0.25) return HEATMAP_GLYPHS[2]
  return HEATMAP_GLYPHS[1]
}

/** Wrap a cell with its 24-bit ANSI colour; blanks pass through. */
function colorCell(glyph: string): string {
  if (glyph === " ") return " "
  const idx = HEATMAP_GLYPHS.indexOf(glyph as (typeof HEATMAP_GLYPHS)[number])
  const rgb = HEATMAP_COLORS[idx]
  if (!rgb) return glyph
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${glyph}\x1b[0m`
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "")
}

/** v1 `renderHeatmap`: same box, same rows; `unit` names the per-day metric. */
export function renderHeatmap(
  buckets: ReadonlyMap<string, number>,
  days: number,
  unit = "steps",
  options?: { today?: Date },
): string {
  const grid = buildHeatmapGrid(buckets, { days, today: options?.today })
  const innerWidth = Math.max(56, ...grid.lines.map((line) => stripAnsi(line).length)) + 2
  const hbar = "─".repeat(innerWidth)
  const lines: string[] = []
  lines.push(`┌${hbar}┐`)
  lines.push(`│${"ACTIVITY HEATMAP".padStart(Math.floor((innerWidth + 15) / 2)).padEnd(innerWidth)}│`)
  lines.push(`├${hbar}┤`)
  for (const row of grid.lines) {
    const visibleLen = stripAnsi(row).length
    const pad = Math.max(0, innerWidth - visibleLen)
    lines.push(`│ ${row}${" ".repeat(pad)} │`)
  }
  lines.push(`├${hbar}┤`)
  const renderRow = (label: string, value: string) => {
    const content = `${label}${" ".repeat(Math.max(1, 16 - label.length))}${value}`
    const padding = Math.max(0, innerWidth - content.length - 1)
    lines.push(`│ ${content}${" ".repeat(padding)} │`)
  }
  renderRow("Window", `${grid.days} days (${grid.startDate} → ${grid.endDate})`)
  renderRow(`Total ${unit}`, grid.total.toLocaleString("en-US"))
  renderRow(`Peak ${unit}`, grid.peakDate ? `${grid.peak.toLocaleString("en-US")} (${grid.peakDate})` : "0")
  renderRow("Active days", `${grid.activeDays.toLocaleString("en-US")} / ${grid.days}`)
  lines.push(`└${hbar}┘`)
  return lines.join("\n")
}
