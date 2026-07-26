// Tests for the `banyancode stats --heatmap` feature.
//
// `computeHeatmapBuckets` and `buildHeatmapGrid` are pure functions tested in
// isolation below. The DB integration test at the bottom uses
// `Database.layerFromPath(tmpDbPath)` per `test/AGENTS.md` to confirm the
// aggregation works against the real schema.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@/session/session"
import { Project } from "@/project/project"
import {
  buildHeatmapGrid,
  computeHeatmapBuckets,
  dateKey,
  HEATMAP_DEFAULT_DAYS,
} from "@/cli/cmd/stats"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionID } from "@/session/schema"

function atLocal(year: number, monthIndex: number, day: number, hour = 12): number {
  return new Date(year, monthIndex, day, hour, 0, 0, 0).getTime()
}

function makeSession(
  projectID: string,
  updated: number,
  tokens: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  } = {},
): Session.Info {
  const input = tokens.input ?? 0
  const output = tokens.output ?? 0
  const reasoning = tokens.reasoning ?? 0
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0
  return {
    id: `ses_${updated}_${input}_${output}` as never,
    slug: "test",
    projectID: projectID as never,
    workspaceID: undefined,
    directory: "/tmp",
    path: undefined,
    parentID: undefined,
    summary: undefined,
    cost: 0,
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
    },
    share: undefined,
    title: "test",
    agent: undefined,
    model: undefined,
    version: "1",
    metadata: undefined,
    revert: undefined,
    permission: undefined,
    time: {
      created: updated,
      updated,
      compacting: undefined,
      archived: undefined,
    },
  }
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

describe("dateKey", () => {
  test("formats local date as YYYY-MM-DD", () => {
    expect(dateKey(atLocal(2025, 0, 5))).toBe("2025-01-05")
    expect(dateKey(atLocal(2025, 11, 31))).toBe("2025-12-31")
  })
})

describe("computeHeatmapBuckets", () => {
  test("sums all five token columns per local-date", () => {
    const day1 = atLocal(2025, 2, 10)
    const day2 = atLocal(2025, 2, 11)
    const sessions = [
      makeSession("prj_a", day1, {
        input: 100,
        output: 200,
        reasoning: 50,
        cache: { read: 80, write: 20 },
      }),
      makeSession("prj_a", day1, {
        input: 10,
        output: 20,
        reasoning: 5,
        cache: { read: 8, write: 2 },
      }),
      makeSession("prj_a", day2, {
        input: 5,
        output: 7,
        reasoning: 1,
        cache: { read: 3, write: 1 },
      }),
    ]
    const buckets = computeHeatmapBuckets(sessions)
    expect(buckets.get("2025-03-10")).toBe(
      100 + 200 + 50 + 80 + 20 + (10 + 20 + 5 + 8 + 2),
    )
    expect(buckets.get("2025-03-11")).toBe(5 + 7 + 1 + 3 + 1)
  })

  test("sessions outside the --days window are excluded", () => {
    const recent = atLocal(2025, 5, 1)
    const old = atLocal(2024, 0, 1)
    const sessions = [
      makeSession("prj", recent, { input: 100 }),
      makeSession("prj", old, { input: 999 }),
    ]
    const buckets = computeHeatmapBuckets(sessions, 30)
    expect(buckets.get("2024-01-01")).toBeUndefined()
  })

  test("project filter keeps only matching sessions", () => {
    const day = atLocal(2025, 2, 10)
    const sessions = [
      makeSession("prj_a", day, { input: 50 }),
      makeSession("prj_b", day, { input: 200 }),
    ]
    expect(computeHeatmapBuckets(sessions, undefined, "prj_a").get("2025-03-10")).toBe(50)
    expect(computeHeatmapBuckets(sessions, undefined, "prj_b").get("2025-03-10")).toBe(200)
  })

  test("empty-string project filter keeps only the current project's sessions", () => {
    const day = atLocal(2025, 2, 10)
    const sessions = [
      makeSession("prj_a", day, { input: 50 }),
      makeSession("prj_b", day, { input: 200 }),
    ]
    const currentProject = {
      id: "prj_b" as never,
      worktree: "",
      name: undefined,
      icon: undefined,
      vcs: undefined,
      commands: undefined,
      time: { created: 0, updated: 0, initialized: undefined },
      sandboxes: [],
    } as unknown as Project.Info
    expect(
      computeHeatmapBuckets(sessions, undefined, "", currentProject).get("2025-03-10"),
    ).toBe(200)
  })

  test("empty-string project filter throws when no currentProject is supplied", () => {
    const day = atLocal(2025, 2, 10)
    expect(() => computeHeatmapBuckets([makeSession("prj_a", day)], undefined, "")).toThrow(
      /currentProject required/,
    )
  })
})

describe("buildHeatmapGrid", () => {
  // Sun Jun 29 2025 — start lands on Mon Jun 16, so leadingPad = 0.
  // The window covers Mon Jun 16 → Sun Jun 29 (14 days).
  const fixedToday = new Date(2025, 5, 29)

  function bucketsFromActivity(records: Array<{ date: string; tokens: number }>) {
    const m = new Map<string, number>()
    for (const { date, tokens } of records) m.set(date, tokens)
    return m
  }

  test("produces 1 label row + 7 data rows = 8 lines", () => {
    const grid = buildHeatmapGrid(new Map(), { today: fixedToday, days: 14 })
    expect(grid.lines.length).toBe(8)
    for (let row = 1; row < 8; row++) {
      expect(grid.lines[row].slice(0, 3)).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)
    }
  })

  test("row width = 4 char label + leadingPad + days columns", () => {
    const grid = buildHeatmapGrid(new Map(), { today: fixedToday, days: 14 })
    // leadingPad = 0 (start = Mon), so each row's visible width = 4 + 14 = 18.
    const visibleLens = grid.lines
      .slice(1)
      .map((l: string) => l.replace(ANSI_PATTERN, "").length)
    for (const len of visibleLens) expect(len).toBe(4 + 14)
  })

  test("window starting on a non-Mon weekday inserts blanks in earlier rows", () => {
    // Jul 2 2025 = Wed. start = Jun 26 (Thu). leadingPad = (4 + 6) % 7 = 3.
    // Mon, Tue, Wed rows should each start with 3 blank cells, then no data
    // (only Mon Jun 30 sits in the data range; Tue/Wed are blank).
    const startDay = new Date(2025, 6, 2)
    const grid = buildHeatmapGrid(new Map(), { today: startDay, days: 7 })
    const strip = (rowIdx: number) =>
      grid.lines[rowIdx].replace(ANSI_PATTERN, "").slice(4)
    const monCells = strip(1)
    const tueCells = strip(2)
    const wedCells = strip(3)
    // leadingPad=3 + 7 day cols = 10 cells per row.
    expect(monCells.length).toBe(3 + 7)
    expect(tueCells.length).toBe(3 + 7)
    expect(wedCells.length).toBe(3 + 7)
    expect(monCells.slice(0, 3)).toBe("   ")
    expect(tueCells.slice(0, 3)).toBe("   ")
    expect(wedCells.slice(0, 3)).toBe("   ")
    // Mon Jun 30 (col index 7 in the data area) lands on the Mon row — empty
    // because no buckets were supplied.
    expect(monCells[7]).toBe(" ")
  })

  test("intensity glyphs follow the 5-level peak-relative scale", () => {
    // Mon Jun 16 → Sun Jun 29 (14 days). Each weekday appears exactly twice.
    const buckets = bucketsFromActivity([
      { date: "2025-06-29", tokens: 100 }, // Sun = peak
      { date: "2025-06-22", tokens: 80 }, // Sun ≥ 75% → full
      { date: "2025-06-28", tokens: 50 }, // Sat ≥ 50% → dark
      { date: "2025-06-27", tokens: 25 }, // Fri ≥ 25% → medium
      { date: "2025-06-26", tokens: 10 }, // Thu < 25% → light
      { date: "2025-06-19", tokens: 0 }, // Thu zero
    ])
    const grid = buildHeatmapGrid(buckets, { today: fixedToday, days: 14 })

    const stripRow = (rowIdx: number) =>
      grid.lines[rowIdx].replace(ANSI_PATTERN, "").slice(4)

    // Sun row = grid.lines[7]. Sun cols: 06-22 (col 6) and 06-29 (col 13).
    const sunCells = stripRow(7)
    expect(sunCells[13]).toBe("█") // 06-29 peak
    expect(sunCells[6]).toBe("█") // 06-22 ≥ 75%
    // Sat row = grid.lines[6]. Sat cols: 06-21 (col 5) and 06-28 (col 12).
    const satCells = stripRow(6)
    expect(satCells[12]).toBe("▓") // 06-28 ≥ 50%
    expect(satCells[5]).toBe(" ") // 06-21 zero
    // Fri row = grid.lines[5]. Fri cols: 06-20 (col 4) and 06-27 (col 11).
    const friCells = stripRow(5)
    expect(friCells[11]).toBe("▒") // 06-27 ≥ 25%
    expect(friCells[4]).toBe(" ") // 06-20 zero
    // Thu row = grid.lines[4]. Thu cols: 06-19 (col 3) and 06-26 (col 10).
    const thuCells = stripRow(4)
    expect(thuCells[10]).toBe("░") // 06-26 < 25%
    expect(thuCells[3]).toBe(" ") // 06-19 zero
  })

  test("peakDate / peakTokens / activeDays / totalTokens are correct", () => {
    const buckets = bucketsFromActivity([
      { date: "2025-06-29", tokens: 1000 },
      { date: "2025-06-28", tokens: 0 },
      { date: "2025-06-27", tokens: 50 },
      // outside window, ignored:
      { date: "2025-01-01", tokens: 999_999 },
    ])
    const grid = buildHeatmapGrid(buckets, { today: fixedToday, days: 14 })
    expect(grid.peakTokens).toBe(1000)
    expect(grid.peakDate).toBe("2025-06-29")
    expect(grid.activeDays).toBe(2)
    expect(grid.totalTokens).toBe(1050)
    expect(grid.startDate).toBe("2025-06-16")
    expect(grid.endDate).toBe("2025-06-29")
  })

  test("month-label row contains every month in the 12-month window", () => {
    // fixedToday = Sun Jun 29 2025; 365-day window covers Jul 2024 … Jun 2025.
    const grid = buildHeatmapGrid(new Map(), { today: fixedToday, days: HEATMAP_DEFAULT_DAYS })
    const labelRow = grid.lines[0]
    const expected = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"]
    let cursor = 0
    for (const m of expected) {
      const idx = labelRow.indexOf(m, cursor)
      expect(idx).toBeGreaterThanOrEqual(0)
      cursor = idx + m.length
    }
  })

  test("uses 365-day window by default", () => {
    const grid = buildHeatmapGrid(new Map(), { today: fixedToday })
    expect(grid.days).toBe(HEATMAP_DEFAULT_DAYS)
  })
})

describe("computeHeatmapBuckets (DB integration)", () => {
  let projectA: string
  let projectB: string
  let database: ReturnType<typeof Database.layerFromPath>
  let dir: string
  let dispose: () => Promise<void>

  beforeAll(async () => {
    const tmp = await tmpdir()
    dir = tmp.path
    dispose = () => tmp[Symbol.asyncDispose]()
    database = Database.layerFromPath(path.join(dir, "banyancode.db"))

    projectA = "prj_test_1"
    projectB = "prj_test_2"
    const t1 = atLocal(2025, 5, 30)
    const t2 = atLocal(2025, 5, 29)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const worktree = AbsolutePath.make(dir)
        yield* db
          .insert(ProjectTable)
          .values([
            {
              id: ProjectV2.ID.make(projectA),
              worktree,
              sandboxes: [],
              time_created: t1,
              time_updated: t1,
            },
          ])
        yield* db
          .insert(ProjectTable)
          .values([
            {
              id: ProjectV2.ID.make(projectB),
              worktree,
              sandboxes: [],
              time_created: t1,
              time_updated: t1,
            },
          ])
        yield* db
          .insert(SessionTable)
          .values([
            {
              id: SessionID.make("ses_db_test_a"),
              project_id: ProjectV2.ID.make(projectA),
              directory: worktree,
              slug: "a",
              title: "a",
              version: "1",
              cost: 0,
              tokens_input: 100,
              tokens_output: 200,
              tokens_reasoning: 50,
              tokens_cache_read: 80,
              tokens_cache_write: 20,
              time_created: t1,
              time_updated: t1,
            },
          ])
        yield* db
          .insert(SessionTable)
          .values([
            {
              id: SessionID.make("ses_db_test_b"),
              project_id: ProjectV2.ID.make(projectB),
              directory: worktree,
              slug: "b",
              title: "b",
              version: "1",
              cost: 0,
              tokens_input: 999,
              tokens_output: 0,
              tokens_reasoning: 0,
              tokens_cache_read: 0,
              tokens_cache_write: 0,
              time_created: t2,
              time_updated: t2,
            },
          ])
      }).pipe(Effect.provide(database), Effect.scoped, Effect.orDie),
    )
  })

  afterAll(async () => {
    await dispose?.()
  })

  test("buckets reflect rows inserted through the real schema", async () => {
    const buckets = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(SessionTable).all()
        return computeHeatmapBuckets(rows.map((r) => Session.fromRow(r)))
      }).pipe(Effect.provide(database), Effect.scoped),
    )
    expect(buckets.get("2025-06-30")).toBe(100 + 200 + 50 + 80 + 20)
    expect(buckets.get("2025-06-29")).toBe(999)
  })
})
