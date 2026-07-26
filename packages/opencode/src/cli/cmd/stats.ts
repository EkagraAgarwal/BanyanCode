import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { effectCmd } from "../effect-cmd"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"

export interface SessionStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

/** Default heatmap window: 12 months. */
export const HEATMAP_DEFAULT_DAYS = 365
/** ANSI 24-bit color levels: blank → light gray → light red → medium red → dark red. */
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

/**
 * Group sessions into per-day token totals, applying the same days/project
 * filters as `aggregateSessionStats`. Returns a Map keyed by local-date
 * (`YYYY-MM-DD`) so callers can render the activity heatmap directly.
 */
export function computeHeatmapBuckets(
  sessions: ReadonlyArray<Session.Info>,
  days?: number,
  projectFilter?: string,
  currentProject?: Project.Info,
): Map<string, number> {
  const MS_IN_DAY = 86_400_000
  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const timeFiltered = cutoffTime > 0 ? sessions.filter((s) => s.time.updated >= cutoffTime) : sessions
  const filtered = filterByProject(timeFiltered, projectFilter, currentProject)

  const buckets = new Map<string, number>()
  for (const s of filtered) {
    const tokens = s.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const total =
      tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    const key = dateKey(s.time.updated)
    buckets.set(key, (buckets.get(key) ?? 0) + total)
  }
  return buckets
}

function filterByProject(
  sessions: ReadonlyArray<Session.Info>,
  projectFilter: string | undefined,
  currentProject: Project.Info | undefined,
): ReadonlyArray<Session.Info> {
  if (projectFilter === undefined) return sessions
  if (projectFilter === "") {
    if (!currentProject) throw new Error("currentProject required when projectFilter is empty string")
    return sessions.filter((s) => s.projectID === currentProject.id)
  }
  return sessions.filter((s) => s.projectID === projectFilter)
}

interface HeatmapGrid {
  /** Ordered lines: [monthLabelRow, monRow, tueRow, wedRow, thuRow, friRow, satRow, sunRow]. */
  lines: string[]
  totalTokens: number
  peakTokens: number
  /** ISO local-date key for the peak day, or null when no activity. */
  peakDate: string | null
  activeDays: number
  /** Window length in days actually rendered (clamped to `days`). */
  days: number
  /** ISO local-date key for the first rendered column. */
  startDate: string
  /** ISO local-date key for the last rendered column. */
  endDate: string
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
  // Each label is centered above its month's columns, with empty cells between months.
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
    totalTokens: total,
    peakTokens: peak,
    peakDate,
    activeDays,
    days,
    startDate: dateKey(start.getTime()),
    endDate: todayKey,
  }
}

/** Map a bucket value to a 5-level intensity glyph. Tiers use `>=` so the
 *  boundary values land in the higher tier — a day equal to peak renders full. */
function intensityGlyph(value: number, peak: number): string {
  if (value <= 0) return HEATMAP_GLYPHS[0]
  if (peak <= 0) return HEATMAP_GLYPHS[0]
  const ratio = value / peak
  if (ratio >= 0.75) return HEATMAP_GLYPHS[4]
  if (ratio >= 0.5) return HEATMAP_GLYPHS[3]
  if (ratio >= 0.25) return HEATMAP_GLYPHS[2]
  return HEATMAP_GLYPHS[1]
}

/** Wrap a cell with its 24-bit ANSI color; blanks pass through. */
function colorCell(glyph: string): string {
  if (glyph === " ") return " "
  const idx = HEATMAP_GLYPHS.indexOf(glyph as (typeof HEATMAP_GLYPHS)[number])
  const rgb = HEATMAP_COLORS[idx]
  if (!rgb) return glyph
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${glyph}\x1b[0m`
}

function renderHeatmap(buckets: Map<string, number>, days: number) {
  const grid = buildHeatmapGrid(buckets, { days })
  const innerWidth = Math.max(56, ...grid.lines.map((l) => stripAnsi(l).length)) + 2
  const hbar = "─".repeat(innerWidth)
  console.log(`┌${hbar}┐`)
  console.log(`│${"ACTIVITY HEATMAP".padStart(Math.floor((innerWidth + 15) / 2)).padEnd(innerWidth)}│`)
  console.log(`├${hbar}┤`)
  for (const row of grid.lines) {
    const visibleLen = stripAnsi(row).length
    const pad = Math.max(0, innerWidth - visibleLen)
    process.stdout.write(`│ ${row}${" ".repeat(pad)} │\n`)
  }
  console.log(`├${hbar}┤`)
  const renderRow = (label: string, value: string) => {
    const content = `${label}${" ".repeat(Math.max(1, 16 - label.length))}${value}`
    const padding = Math.max(0, innerWidth - content.length - 1)
    console.log(`│ ${content}${" ".repeat(padding)} │`)
  }
  renderRow("Window", `${grid.days} days (${grid.startDate} → ${grid.endDate})`)
  renderRow("Total tokens", formatNumber(grid.totalTokens))
  renderRow("Peak tokens", grid.peakDate ? `${formatNumber(grid.peakTokens)} (${grid.peakDate})` : "0")
  renderRow("Active days", `${grid.activeDays.toLocaleString()} / ${grid.days}`)
  console.log(`└${hbar}┘`)
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "")
}

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs) =>
    yargs
      .option("days", {
        describe: "show stats for the last N days (default: all time)",
        type: "number",
      })
      .option("tools", {
        describe: "number of tools to show (default: all)",
        type: "number",
      })
      .option("models", {
        describe: "show model statistics (default: hidden). Pass a number to show top N, otherwise shows all",
      })
      .option("project", {
        describe: "filter by project (default: all projects, empty string: current project)",
        type: "string",
      })
      .option("heatmap", {
        describe: `render per-day token usage as an ASCII heatmap (last ${HEATMAP_DEFAULT_DAYS} days or --days window)`,
        type: "boolean",
      }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const stats = yield* aggregateSessionStats(args.days, args.project, ctx.project)
    let modelLimit: number | undefined
    if (args.models === true) {
      modelLimit = Infinity
    } else if (typeof args.models === "number") {
      modelLimit = args.models
    }
    displayStats(stats, args.tools, modelLimit)
    if (args.heatmap === true) {
      const sessions = yield* getAllSessions()
      const heatmapDays = args.days ?? HEATMAP_DEFAULT_DAYS
      const buckets = computeHeatmapBuckets(sessions, args.days, args.project, ctx.project)
      renderHeatmap(buckets, heatmapDays)
    }
  }),
})

const getAllSessions = Effect.fnUntraced(function* (cwd: string = process.cwd()) {
  const paths = findAllBanyanDbPaths(cwd)
  if (paths.length === 0) return []

  const out: Session.Info[] = []
  for (const dbPath of paths) {
    const sessions = yield* readSessionsFromDb(dbPath)
    out.push(...sessions)
  }
  return out
})

function readSessionsFromDb(dbPath: string): Effect.Effect<Session.Info[], never, never> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) =>
      Session.fromRow(row),
    )
  }).pipe(
    Effect.provide(Database.layerFromPath(dbPath)),
    // A single corrupt / unreadable workspace DB should not kill the whole
    // stats report. Skip the bad file and keep aggregating the rest.
    Effect.catchCause((cause) =>
      Effect.logWarning(`stats: skipping unreadable db ${dbPath}`, cause).pipe(
        Effect.as([] as Session.Info[]),
      ),
    ),
  )
}

/**
 * Find every `banyancode*.db` file in the project's `.banyancode/` directory
 * (excluding `-shm` / `-wal` siblings). Stats aggregate across all of them so
 * the report covers every workspace the user has touched in this project, not
 * just the single DB the active workspace's `Database.Service` resolves to.
 */
function findAllBanyanDbPaths(cwd: string = process.cwd()): string[] {
  const dir = findBanyanProjectDir(cwd)
  if (!dir) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  return entries
    .filter((name) => /^banyancode.*\.db$/.test(name))
    .filter((name) => !name.endsWith("-shm") && !name.endsWith("-wal"))
    .map((name) => path.join(dir, name))
}

function findBanyanProjectDir(startDir: string): string | undefined {
  let dir = startDir
  while (true) {
    const candidate = path.join(dir, ".banyancode")
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export const aggregateSessionStats = Effect.fn("Cli.stats.aggregate")(function* (
  days?: number,
  projectFilter?: string,
  currentProject?: Project.Info,
  cwd: string = process.cwd(),
) {
  const svc = yield* Session.Service
  const sessions = yield* getAllSessions(cwd)
  const MS_IN_DAY = 24 * 60 * 60 * 1000

  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const windowDays = (() => {
    if (days === undefined) return
    if (days === 0) return 1
    return days
  })()

  const timeFiltered = cutoffTime > 0 ? sessions.filter((s) => s.time.updated >= cutoffTime) : sessions
  const filteredSessions = filterByProject(timeFiltered, projectFilter, currentProject)

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: Date.now(),
      latest: Date.now(),
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }

  if (filteredSessions.length > 1000) {
    console.log(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...`)
  }

  if (filteredSessions.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  let earliestTime = Date.now()
  let latestTime = 0

  const sessionTotalTokens: number[] = []

  const results = yield* Effect.forEach(
    filteredSessions,
    (session) =>
      Effect.gen(function* () {
        const messages = yield* svc
          .messages({ sessionID: session.id })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))

        const sessionCost = session.cost ?? 0
        const sessionTokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        let sessionToolUsage: Record<string, number> = {}
        let sessionModelUsage: Record<
          string,
          {
            messages: number
            tokens: { input: number; output: number; cache: { read: number; write: number } }
            cost: number
          }
        > = {}

        for (const message of messages) {
          if (message.info.role === "assistant") {
            const modelKey = `${message.info.providerID}/${message.info.modelID}`
            if (!sessionModelUsage[modelKey]) {
              sessionModelUsage[modelKey] = {
                messages: 0,
                tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              }
            }
            sessionModelUsage[modelKey].messages++
            sessionModelUsage[modelKey].cost += message.info.cost || 0

            if (message.info.tokens) {
              sessionModelUsage[modelKey].tokens.input += message.info.tokens.input || 0
              sessionModelUsage[modelKey].tokens.output +=
                (message.info.tokens.output || 0) + (message.info.tokens.reasoning || 0)
              sessionModelUsage[modelKey].tokens.cache.read += message.info.tokens.cache?.read || 0
              sessionModelUsage[modelKey].tokens.cache.write += message.info.tokens.cache?.write || 0
            }
          }

          for (const part of message.parts) {
            if (part.type === "tool" && part.tool) {
              sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
            }
          }
        }

        return {
          messageCount: messages.length,
          sessionCost,
          sessionTokens,
          sessionTotalTokens:
            sessionTokens.input +
            sessionTokens.output +
            sessionTokens.reasoning +
            sessionTokens.cache.read +
            sessionTokens.cache.write,
          sessionToolUsage,
          sessionModelUsage,
          earliestTime: cutoffTime > 0 ? session.time.updated : session.time.created,
          latestTime: session.time.updated,
        }
      }),
    { concurrency: 20 },
  )

  for (const result of results) {
    earliestTime = Math.min(earliestTime, result.earliestTime)
    latestTime = Math.max(latestTime, result.latestTime)
    sessionTotalTokens.push(result.sessionTotalTokens)

    stats.totalMessages += result.messageCount
    stats.totalCost += result.sessionCost
    stats.totalTokens.input += result.sessionTokens.input
    stats.totalTokens.output += result.sessionTokens.output
    stats.totalTokens.reasoning += result.sessionTokens.reasoning
    stats.totalTokens.cache.read += result.sessionTokens.cache.read
    stats.totalTokens.cache.write += result.sessionTokens.cache.write

    for (const [tool, count] of Object.entries(result.sessionToolUsage)) {
      stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count
    }

    for (const [model, usage] of Object.entries(result.sessionModelUsage)) {
      if (!stats.modelUsage[model]) {
        stats.modelUsage[model] = {
          messages: 0,
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }
      }
      stats.modelUsage[model].messages += usage.messages
      stats.modelUsage[model].tokens.input += usage.tokens.input
      stats.modelUsage[model].tokens.output += usage.tokens.output
      stats.modelUsage[model].tokens.cache.read += usage.tokens.cache.read
      stats.modelUsage[model].tokens.cache.write += usage.tokens.cache.write
      stats.modelUsage[model].cost += usage.cost
    }
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = windowDays ?? rangeDays
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write
  stats.tokensPerSession = filteredSessions.length > 0 ? totalTokens / filteredSessions.length : 0
  sessionTotalTokens.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
})

function displayStats(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  const width = 56

  function renderRow(label: string, value: string): string {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - label.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  // Overview section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                       OVERVIEW                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  console.log(renderRow("Sessions", stats.totalSessions.toLocaleString()))
  console.log(renderRow("Messages", stats.totalMessages.toLocaleString()))
  console.log(renderRow("Days", stats.days.toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost & Tokens section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    COST & TOKENS                       │")
  console.log("├────────────────────────────────────────────────────────┤")
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  console.log(renderRow("Total Cost", `$${cost.toFixed(2)}`))
  console.log(renderRow("Avg Cost/Day", `$${costPerDay.toFixed(2)}`))
  console.log(renderRow("Avg Tokens/Session", formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  console.log(renderRow("Median Tokens/Session", formatNumber(Math.round(medianTokensPerSession))))
  console.log(renderRow("Input", formatNumber(stats.totalTokens.input)))
  console.log(renderRow("Output", formatNumber(stats.totalTokens.output)))
  console.log(renderRow("Cache Read", formatNumber(stats.totalTokens.cache.read)))
  console.log(renderRow("Cache Write", formatNumber(stats.totalTokens.cache.write)))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Model Usage section
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      MODEL USAGE                       │")
    console.log("├────────────────────────────────────────────────────────┤")

    for (const [model, usage] of modelsToDisplay) {
      console.log(`│ ${model.padEnd(54)} │`)
      console.log(renderRow("  Messages", usage.messages.toLocaleString()))
      console.log(renderRow("  Input Tokens", formatNumber(usage.tokens.input)))
      console.log(renderRow("  Output Tokens", formatNumber(usage.tokens.output)))
      console.log(renderRow("  Cache Read", formatNumber(usage.tokens.cache.read)))
      console.log(renderRow("  Cache Write", formatNumber(usage.tokens.cache.write)))
      console.log(renderRow("  Cost", `$${usage.cost.toFixed(4)}`))
      console.log("├────────────────────────────────────────────────────────┤")
    }
    // Remove last separator and add bottom border
    process.stdout.write("\x1B[1A") // Move up one line
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()

  // Tool Usage section
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      TOOL USAGE                        │")
    console.log("├────────────────────────────────────────────────────────┤")

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
      const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
      const bar = "█".repeat(barLength)
      const percentage = ((count / totalToolUsage) * 100).toFixed(1)

      const maxToolLength = 18
      const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
      const padding = Math.max(0, width - content.length - 1)
      console.log(`│${content}${" ".repeat(padding)} │`)
    }
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
