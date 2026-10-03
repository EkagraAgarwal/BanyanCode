#!/usr/bin/env bun
/**
 * perf-probe.ts — §11.6 measure-before-and-after probe (Wave 2 gate).
 *
 * Measure-only. Spawns `banyancode serve` (subprocess) against a tmpdir
 * project, samples RSS + CPU each second while idle, then incrementally
 * indexes a generated corpus of changed files in a tmpdir repo.
 *
 * Session-replay is SKIPPED: there is no recorded http-recorder cassette
 * for the §11.6 shape (long bash output + 50-turn conversation) in this
 * repo yet. When a cassette lands, add a `--cassette` phase here.
 *
 * The `banyancode debug db` CLI integration touches CLI routes and is NOT
 * part of this script's job; instead the same breakdown logic lives here
 * behind `--db-report <path>` (read-only open of any sqlite file) so the
 * CLI command can reuse it later.
 *
 * Usage:
 *   bun run script/perf-probe.ts [--idle-seconds 60] [--files 200]
 *     [--port 0] [--out <json-path>] [--keep] [--skip-serve] [--skip-index]
 *   bun run script/perf-probe.ts --db-report <sqlite-path> [--out <json-path>]
 *
 * The script only ever kills the child processes IT spawned (serve/build).
 * It never touches any other banyancode.exe / node process on the machine.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { cpus, totalmem, platform, arch } from "node:os"

// ---------------------------------------------------------------- args

interface Args {
  idleSeconds: number
  files: number
  port: number
  out: string | null
  keep: boolean
  skipServe: boolean
  skipIndex: boolean
  dbReport: string | null
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    idleSeconds: 60,
    files: 200,
    port: 0,
    out: null,
    keep: false,
    skipServe: false,
    skipIndex: false,
    dbReport: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    const next = () => argv[++i]
    if (t === "--idle-seconds") a.idleSeconds = Number(next())
    else if (t === "--files") a.files = Number(next())
    else if (t === "--port") a.port = Number(next())
    else if (t === "--out") a.out = next()
    else if (t === "--keep") a.keep = true
    else if (t === "--skip-serve") a.skipServe = true
    else if (t === "--skip-index") a.skipIndex = true
    else if (t === "--db-report") a.dbReport = next()
    else if (t === "--help" || t === "-h") {
      console.log(
        "perf-probe.ts [--idle-seconds N] [--files N] [--port N] [--out f] [--keep] [--skip-serve] [--skip-index] [--db-report sqlite-path]",
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${t}`)
      process.exit(1)
    }
  }
  return a
}

// ------------------------------------------------------- process sample

interface Sample {
  rssBytes: number
  cpuSeconds: number
}

const IS_WIN = process.platform === "win32"

/** RSS (working set, self + direct children) + cumulative CPU seconds. */
async function sampleTree(pid: number): Promise<Sample | null> {
  try {
    if (IS_WIN) {
      const ps =
        `$ids = @(${pid}) + @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' ` +
        `| Select-Object -ExpandProperty ProcessId); ` +
        `$rss = 0; $cpu = 0.0; foreach ($i in $ids) { try { $p = Get-Process -Id $i -ErrorAction Stop; ` +
        `$rss += $p.WorkingSet64; if ($null -ne $p.CPU) { $cpu += $p.CPU } } catch {} }; ` +
        `Write-Output "$rss $cpu"`
      const out = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 15000)
      const m = out.trim().split(/\s+/)
      if (m.length >= 2 && Number(m[0]) > 0) return { rssBytes: Number(m[0]), cpuSeconds: Number(m[1]) }
      return null
    }
    // posix: /proc when available (linux), else ps fallback
    const procStat = `/proc/${pid}/stat`
    if (existsSync(procStat)) {
      const kids = await execFile("pgrep", ["-P", String(pid)], 5000).catch(() => "")
      const ids = [pid, ...kids.trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => n > 0)]
      let rss = 0
      let ticks = 0
      for (const id of ids) {
        try {
          const st = (await Bun.file(`/proc/${id}/stat`).text()).trim()
          const parts = st.slice(st.lastIndexOf(")") + 1).trim().split(/\s+/)
          // fields after comm: state(0) ppid(1) ... utime(11) stime(12)
          ticks += Number(parts[11]) + Number(parts[12])
          const status = await Bun.file(`/proc/${id}/status`).text()
          const vm = status.split("\n").find((l) => l.startsWith("VmRSS:"))
          if (vm) rss += Number(vm.split(/\s+/)[1]) * 1024
        } catch {
          // raced exit; ignore
        }
      }
      const hz = 100
      return { rssBytes: rss, cpuSeconds: ticks / hz }
    }
    const out = await execFile("ps", ["-o", "rss=,cputime=", "-p", String(pid)], 5000)
    const m = out.trim().split(/\s+/)
    if (m.length >= 2) return { rssBytes: Number(m[0]) * 1024, cpuSeconds: parseCpuTime(m[1]) }
    return null
  } catch {
    return null
  }
}

function parseCpuTime(s: string): number {
  // [[dd-]hh:]mm:ss
  const parts = s.split(/[-:]/).map(Number)
  if (parts.some((n) => Number.isNaN(n))) return 0
  let sec = parts.pop()!
  let mult = 60
  while (parts.length) {
    sec += parts.pop()! * mult
    mult *= 60
  }
  return sec
}

function execFile(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    const t = setTimeout(() => {
      c.kill()
      reject(new Error(`${cmd} timed out`))
    }, timeoutMs)
    c.stdout.on("data", (d) => (out += d))
    c.on("error", (e) => {
      clearTimeout(t)
      reject(e)
    })
    c.on("close", () => {
      clearTimeout(t)
      resolvePromise(out)
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------- db sizes

interface DbSnapshot {
  totalBytes: number
  files: { name: string; bytes: number }[]
  eventRows: number | null
  eventBytes: number | null
}

function dirSize(root: string): { totalBytes: number; files: { name: string; bytes: number }[] } {
  const files: { name: string; bytes: number }[] = []
  const walk = (dir: string) => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (st.isFile()) files.push({ name: p.slice(root.length + 1), bytes: st.size })
      } catch {
        // ignore
      }
    }
  }
  walk(root)
  files.sort((x, y) => y.bytes - x.bytes)
  return { totalBytes: files.reduce((s, f) => s + f.bytes, 0), files: files.slice(0, 15) }
}

async function eventStats(dbDir: string): Promise<{ rows: number | null; bytes: number | null }> {
  // Sum over every *.db in the dir that has an `event` table. Read-only.
  let rows = 0
  let bytes = 0
  let found = false
  let entries: string[] = []
  try {
    entries = readdirSync(dbDir)
  } catch {
    return { rows: null, bytes: null }
  }
  const { Database } = await import("bun:sqlite")
  for (const e of entries) {
    if (!e.endsWith(".db")) continue
    try {
      const db = new Database(join(dbDir, e), { readonly: true })
      try {
        const tbl = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='event'").all()
        if (tbl.length === 0) continue
        found = true
        const r = db.query("SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(data)),0) AS b FROM event").get() as {
          c: number
          b: number
        }
        rows += r.c
        bytes += r.b
      } finally {
        db.close()
      }
    } catch {
      // locked / not a db / no table — skip
    }
  }
  return found ? { rows, bytes } : { rows: null, bytes: null }
}

async function snapDb(dbDirs: string[]): Promise<DbSnapshot> {
  const total = { totalBytes: 0, files: [] as { name: string; bytes: number }[] }
  let rows = 0
  let bytes = 0
  let foundEvent = false
  let anyDir = false
  for (const d of dbDirs) {
    if (!existsSync(d)) continue
    anyDir = true
    const part = dirSize(d)
    total.totalBytes += part.totalBytes
    total.files.push(...part.files)
    const ev = await eventStats(d)
    if (ev.rows !== null) {
      foundEvent = true
      rows += ev.rows
      bytes += ev.bytes!
    }
  }
  total.files.sort((x, y) => y.bytes - x.bytes)
  void anyDir
  return {
    totalBytes: total.totalBytes,
    files: total.files.slice(0, 15),
    eventRows: foundEvent ? rows : null,
    eventBytes: foundEvent ? bytes : null,
  }
}

// ------------------------------------------------------------ db-report

export interface DbReport {
  path: string
  fileBytes: number
  pageSize: number
  pageCount: number
  freelistCount: number
  autoVacuum: number
  journalMode: string
  objects: { name: string; type: string; bytes: number }[]
  eventTypes: { type: string; rows: number; bytes: number; largestRowBytes: number }[]
  largestRows: { id: string; type: string; bytes: number }[]
  /** Top-level JSON field sizes of the single largest event row. */
  largestRowFields: { field: string; bytes: number }[]
  warnings: string[]
}

/** Read-only breakdown of any sqlite file (dbstat + event-type sizes). */
export async function dbReport(dbPath: string): Promise<DbReport> {
  const warnings: string[] = []
  const { Database } = await import("bun:sqlite")
  const abs = resolve(dbPath)
  if (!existsSync(abs)) throw new Error(`db-report: file not found: ${abs}`)
  const fileBytes = statSync(abs).size
  const db = new Database(abs, { readonly: true })
  try {
    const pragma = (sql: string): string => (db.query(sql).get() as Record<string, unknown> | null)
      ? String(Object.values(db.query(sql).get() as Record<string, unknown>)[0])
      : ""
    const pageSize = Number(pragma("PRAGMA page_size")) || 0
    const pageCount = Number(pragma("PRAGMA page_count")) || 0
    const freelistCount = Number(pragma("PRAGMA freelist_count")) || 0
    const autoVacuum = Number(pragma("PRAGMA auto_vacuum")) || 0
    const journalMode = pragma("PRAGMA journal_mode")

    // dbstat per-object sizes (may be unavailable in some builds)
    const objects: DbReport["objects"] = []
    try {
      const rows = db.query("SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name ORDER BY b DESC").all() as {
        name: string
        b: number
      }[]
      const types = new Map(
        (
          db.query("SELECT name, type FROM sqlite_master").all() as { name: string; type: string }[]
        ).map((r) => [r.name, r.type] as const),
      )
      for (const r of rows) objects.push({ name: r.name, type: types.get(r.name) ?? "?", bytes: r.b })
    } catch {
      warnings.push("dbstat unavailable; per-object sizes skipped")
    }

    // event-type breakdown + largest rows (only when an `event` table exists)
    const eventTypes: DbReport["eventTypes"] = []
    const largestRows: DbReport["largestRows"] = []
    let largestRowFields: DbReport["largestRowFields"] = []
    const hasEvent =
      (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='event'").all() as unknown[]).length > 0
    if (hasEvent) {
      const byType = db.query(
        "SELECT type, COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)),0) AS bytes, COALESCE(MAX(LENGTH(data)),0) AS mx FROM event GROUP BY type ORDER BY bytes DESC",
      ).all() as { type: string; rows: number; bytes: number; mx: number }[]
      for (const r of byType) eventTypes.push({ type: r.type, rows: r.rows, bytes: r.bytes, largestRowBytes: r.mx })
      const top = db.query(
        "SELECT id, type, LENGTH(data) AS b FROM event ORDER BY b DESC LIMIT 10",
      ).all() as { id: string; type: string; b: number }[]
      for (const r of top) largestRows.push({ id: r.id, type: r.type, bytes: r.b })
      if (top.length > 0) {
        try {
          const body = db.query("SELECT data AS d FROM event WHERE id = ?").get(top[0].id) as { d: string } | null
          if (body && typeof body.d === "string") {
            const parsed: unknown = JSON.parse(body.d)
            if (parsed && typeof parsed === "object") {
              largestRowFields = Object.entries(parsed as Record<string, unknown>)
                .map(([field, v]) => ({ field, bytes: JSON.stringify(v)?.length ?? 0 }))
                .sort((x, y) => y.bytes - x.bytes)
                .slice(0, 15)
            }
          }
        } catch {
          warnings.push("largest event row is not JSON; field breakdown skipped")
        }
      }
    } else {
      warnings.push("no `event` table in this database")
    }

    return {
      path: abs,
      fileBytes,
      pageSize,
      pageCount,
      freelistCount,
      autoVacuum,
      journalMode,
      objects: objects.slice(0, 25),
      eventTypes,
      largestRows,
      largestRowFields,
      warnings,
    }
  } finally {
    db.close()
  }
}

export function printDbReport(r: DbReport): void {
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`
  console.log(`db-report: ${r.path} (${mb(r.fileBytes)})`)
  console.log(
    `  pages: ${r.pageCount} x ${r.pageSize}B, freelist=${r.freelistCount}, auto_vacuum=${r.autoVacuum}, journal=${r.journalMode}`,
  )
  if (r.objects.length > 0) {
    console.log("  objects:")
    for (const o of r.objects.slice(0, 12)) console.log(`    ${o.name} [${o.type}] ${mb(o.bytes)}`)
  }
  if (r.eventTypes.length > 0) {
    console.log("  event types:")
    for (const t of r.eventTypes)
      console.log(`    ${t.type}: ${t.rows} rows, ${mb(t.bytes)}, largest ${mb(t.largestRowBytes)}`)
  }
  if (r.largestRows.length > 0) {
    console.log("  largest event rows:")
    for (const row of r.largestRows.slice(0, 5)) console.log(`    ${row.id} [${row.type}] ${mb(row.bytes)}`)
  }
  if (r.largestRowFields.length > 0) {
    console.log("  largest-row top-level fields:")
    for (const f of r.largestRowFields.slice(0, 10)) console.log(`    ${f.field}: ${mb(f.bytes)}`)
  }
  for (const w of r.warnings) console.log(`  warn: ${w}`)
}

// ---------------------------------------------------------------- main

interface IdleResult {
  samples: number
  peakRssBytes: number
  steadyRssBytes: number
  p95RssBytes: number
  cpuSeconds: number
  cpuPctOneCore: number
  wallSeconds: number
}

interface BuildRun {
  name: string
  wallMs: number
  peakRssBytes: number
  exitCode: number | null
  timedOut: boolean
  tail: string
  /** The `db:` path the build printed (proves isolation), if parsed. */
  dbPath: string | null
}

async function waitForPortLog(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolvePromise) => {
    let buf = ""
    const t = setTimeout(() => resolvePromise(null), timeoutMs)
    const onData = (d: Buffer) => {
      buf += d.toString()
      const m = buf.match(/listening on http:\/\/[^:]+:(\d+)/)
      if (m) {
        clearTimeout(t)
        resolvePromise(Number(m[1]))
      }
      if (buf.length > 65536) buf = buf.slice(-32768)
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
  })
}

/** Sample `pid` every `intervalMs` for `seconds`; returns summary. */
async function sampleIdle(pid: number, seconds: number, intervalMs = 1000): Promise<IdleResult> {
  const rss: number[] = []
  let firstCpu: number | null = null
  let lastCpu: number | null = null
  const t0 = Date.now()
  for (let i = 0; i < seconds; i++) {
    const s = await sampleTree(pid)
    if (s) {
      rss.push(s.rssBytes)
      if (firstCpu === null) firstCpu = s.cpuSeconds
      lastCpu = s.cpuSeconds
    }
    const elapsed = Date.now() - t0
    const target = (i + 1) * intervalMs
    if (target > elapsed) await sleep(target - elapsed)
  }
  const wall = (Date.now() - t0) / 1000
  const sorted = [...rss].sort((x, y) => x - y)
  const peak = rss.length ? Math.max(...rss) : 0
  const tail = rss.slice(-20)
  const steady = tail.length ? tail.reduce((s, v) => s + v, 0) / tail.length : 0
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0
  const cpu = firstCpu !== null && lastCpu !== null ? Math.max(0, lastCpu - firstCpu) : 0
  return {
    samples: rss.length,
    peakRssBytes: peak,
    steadyRssBytes: Math.round(steady),
    p95RssBytes: p95,
    cpuSeconds: Math.round(cpu * 100) / 100,
    cpuPctOneCore: wall > 0 ? Math.round((cpu / wall) * 10000) / 100 : 0,
    wallSeconds: Math.round(wall * 10) / 10,
  }
}

/** Run `codegraph build` as a child, sampling its peak RSS. Only kills this child. */
async function runBuild(
  pkgDir: string,
  projectDir: string,
  repoRoot: string,
  name: string,
  env: NodeJS.ProcessEnv,
  buildTimeoutMs: number,
  force: boolean,
): Promise<BuildRun> {
  const t0 = Date.now()
  let peak = 0
  let tail = ""
  const forceArgs = force ? ["--force"] : []
  const child = spawn(
    "bun",
    [join(pkgDir, "src", "index.ts"), "codegraph", "build", "--root", repoRoot, ...forceArgs, "--watch", "false", "--timeout", "280"],
    {
      // cwd = scratch project so Database.path() (cwd-derived) lands in
      // scratch; entry + --root are absolute so resolution is unaffected.
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const pid = child.pid!
  child.stdout?.on("data", (d: Buffer) => {
    tail += d.toString()
    if (tail.length > 8192) tail = tail.slice(-8192)
  })
  child.stderr?.on("data", (d: Buffer) => {
    tail += d.toString()
    if (tail.length > 8192) tail = tail.slice(-8192)
  })
  let timedOut = false
  const sampler = (async () => {
    for (;;) {
      await sleep(250)
      if (child.exitCode !== null) break
      const s = await sampleTree(pid)
      if (s && s.rssBytes > peak) peak = s.rssBytes
      if (Date.now() - t0 > buildTimeoutMs) {
        timedOut = true
        try {
          child.kill()
        } catch {
          // already exited
        }
        break
      }
    }
  })()
  const exitCode: number | null = await new Promise((resolvePromise) => {
    child.on("close", (code) => resolvePromise(code))
  })
  await sampler
  // The build prints a `  db: <path>` line wrapped in ANSI color codes;
  // match the first *.db token anywhere in the tail instead of a clean line.
  const dbMatch = tail.match(/([A-Za-z]:\\[^\s"']*?\.db|\/[^\s"']*?\.db)/)
  return {
    name,
    wallMs: Date.now() - t0,
    peakRssBytes: peak,
    exitCode,
    timedOut,
    tail: tail.trim().split("\n").slice(-5).join("\n"),
    dbPath: dbMatch ? dbMatch[1].trim() : null,
  }
}

function genCorpus(repoRoot: string, files: number, seedMarker: string): void {
  mkdirSync(join(repoRoot, "src"), { recursive: true })
  for (let i = 0; i < files; i++) {
    const dep = i > 0 ? `import { fn${i - 1} } from "./mod${i - 1}"\n` : ""
    writeFileSync(
      join(repoRoot, "src", `mod${i}.ts`),
      `${dep}// ${seedMarker} file ${i}\nexport function fn${i}(x: number): number {\n  return x * ${i + 1} + ${i}${
        i > 0 ? ` + fn${i - 1}(x)` : ""
      }\n}\nexport const val${i} = fn${i}(${i})\n`,
    )
  }
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "probe-corpus", private: true }, null, 2))
}

async function gitCommit(args: Args): Promise<string> {
  try {
    return (await execFile("git", ["rev-parse", "--short", "HEAD"], 10000)).trim()
  } catch {
    return "unknown"
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Standalone db-report mode: no serve, no corpus.
  if (args.dbReport) {
    const r = await dbReport(args.dbReport)
    printDbReport(r)
    if (args.out) {
      writeFileSync(args.out, JSON.stringify(r, null, 2))
      console.log(`wrote ${args.out}`)
    } else {
      console.log(JSON.stringify(r))
    }
    return
  }

  const pkgDir = resolve(join(import.meta.dir, ".."))
  const scratch = mkdtempSync(join(tmpdir(), "perf-probe-"))
  const projectDir = join(scratch, "project")
  const repoDir = join(scratch, "repo")
  const homeDir = join(scratch, "home")
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(repoDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  const dbBaseDir = join(scratch, "dbs")
  mkdirSync(dbBaseDir, { recursive: true })
  const dbDir = join(projectDir, ".banyancode")

  // Isolated env for every child WE spawn. Port 0 = ephemeral (never
  // clashes with a live user CLI); cwd = tmp project so the per-project
  // DB lands in scratch, never in a real checkout.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_DATA_HOME: join(homeDir, "data"),
    XDG_CONFIG_HOME: join(homeDir, "config"),
    XDG_STATE_HOME: join(homeDir, "state"),
    XDG_CACHE_HOME: join(homeDir, "cache"),
    BANYANCODE_CONFIG_DIR: join(homeDir, "banyan-config"),
    // Critical: Database.path()/deriveBanyanDbPath walk UP from cwd for an
    // existing `.banyancode` marker, so a scratch dir under $env:TEMP would
    // otherwise inherit e.g. C:\Users\<you>\.banyancode and write real DB
    // files there. This override pins every per-root DB file into scratch
    // (filename/hash scheme unchanged).
    BANYANCODE_PROJECT_DB_DIR: dbBaseDir,
    OPENCODE_SERVER_PASSWORD: "probe-only",
  }

  let serve: ChildProcess | null = null
  const result: Record<string, unknown> = {
    probe: "perf-probe.ts v1 (§11.6 Wave-2 gate)",
    generatedAt: new Date().toISOString(),
    machine: { platform: platform(), arch: arch(), cpus: cpus().length, totalMemBytes: totalmem() },
    tree: { commit: await gitCommit(args), cwd: process.cwd() },
    config: { idleSeconds: args.idleSeconds, files: args.files, port: args.port },
  }

  const dbDirs = [dbBaseDir, dbDir, join(repoDir, ".banyancode")]
  const dbNote =
    "scratch dbs/ (BANYANCODE_PROJECT_DB_DIR override — every per-root DB lands here) " +
    "plus project/repo .banyancode dirs (expected empty: marker walk-up is bypassed by the override); " +
    "serve is pure-idle with no client requests, so idle writes ≈ 0 is expected"
  try {
    const t0snap = await snapDb(dbDirs)
    result["dbPre"] = t0snap
    result["dbScopeNote"] = dbNote

    // ---- phase 1: idle serve
    if (!args.skipServe) {
      serve = spawn("bun", [join(pkgDir, "src", "index.ts"), "serve", "--port", String(args.port), "--hostname", "127.0.0.1"], {
        // cwd = scratch project so the cwd-derived per-project DB lands in
        // scratch; the entry path is absolute so this is unaffected.
        cwd: projectDir,
        env: { ...childEnv },
        stdio: ["ignore", "pipe", "pipe"],
      })
      // NOTE: `serve` below is narrowed non-null inside closures via local.
      const svc = serve
      svc.stdout?.on("data", () => {})
      svc.stderr?.on("data", () => {})
      svc.on("error", (e) => console.error(`serve spawn error: ${e.message}`))
      const servePid = svc.pid
      if (!servePid) throw new Error("serve did not produce a pid")
      const actualPort = await waitForPortLog(svc, 60000)
      if (actualPort === null) {
        result["serve"] = { started: false, error: "no 'listening on' line within 60s" }
      } else {
        result["servePort"] = actualPort
        await sleep(3000) // let startup settle before the idle window
        const idle = await sampleIdle(servePid, args.idleSeconds)
        result["serve"] = { started: true, port: actualPort, ...idle }
      }
    } else {
      result["serve"] = { started: false, skipped: "--skip-serve" }
    }

    const t1snap = await snapDb(dbDirs)
    result["dbPostIdle"] = t1snap

    // ---- phase 2: session replay — skipped, no cassette exists
    result["sessionReplay"] = {
      skipped: true,
      reason:
        "no recorded http-recorder cassette for the §11.6 shape (long bash output + 50-turn conversation) exists in this repo; replay phase not implemented",
    }

    // ---- phase 3: incremental index of N changed files
    if (!args.skipIndex) {
      genCorpus(repoDir, args.files, "v1")
      const runs: BuildRun[] = []
      const files = args.files
      runs.push(await runBuild(pkgDir, projectDir, repoDir, `full-${files}`, childEnv, 290000, true))
      // Second run: identical input, identical full build -> RSS-growth check.
      runs.push(await runBuild(pkgDir, projectDir, repoDir, `repeat-full-${files}`, childEnv, 290000, true))
      // Third run: touch every file (content change), no --force -> incremental reindex.
      genCorpus(repoDir, args.files, "v2")
      runs.push(await runBuild(pkgDir, projectDir, repoDir, `incremental-${files}`, childEnv, 290000, false))
      const growth = runs[1] && runs[0] ? runs[1].peakRssBytes - runs[0].peakRssBytes : null
      result["index"] = {
        files: args.files,
        runs: runs.map((r) => ({ ...r, wallSeconds: Math.round(r.wallMs / 100) / 10 })),
        rssGrowthIdenticalRunsBytes: growth,
        note: "runs[0] vs runs[1] are the two identical indexing runs (§11.6/C1: expect no RSS growth); runs[2] is the incremental reindex of changed files",
      }
    } else {
      result["index"] = { skipped: "--skip-index" }
    }

    const t2snap = await snapDb(dbDirs)
    result["dbPostIndex"] = t2snap

    // ---- targets vs §11.6 (adapted: task's four comparisons)
    const serveIdle = result["serve"] as IdleResult & { started: boolean }
    const idx = result["index"] as { rssGrowthIdenticalRunsBytes?: number | null }
    result["targets"] = {
      idleCpuPctOneCore: serveIdle?.started ? serveIdle.cpuPctOneCore : null,
      idleCpuTarget: "< 0.5% of one core",
      idleCpuPass: serveIdle?.started ? serveIdle.cpuPctOneCore < 0.5 : null,
      durableWritesPerSecStreamingBash: null,
      durableWritesNote: "unmeasured: session-replay skipped (no cassette)",
      eventBytesPerSessionVsPreQ0: null,
      eventBytesNote: "unmeasured: needs pre-Q0 baseline DB for comparison",
      rssGrowthIdenticalRunsBytes: idx?.rssGrowthIdenticalRunsBytes ?? null,
      rssGrowthPass: typeof idx?.rssGrowthIdenticalRunsBytes === "number" ? idx.rssGrowthIdenticalRunsBytes <= 0 : null,
    }
  } finally {
    // Only ever kill the serve child WE spawned (own handle/pid).
    if (serve && serve.exitCode === null) {
      try {
        serve.kill()
      } catch {
        // already exited
      }
      await new Promise((resolvePromise) => {
        const t = setTimeout(resolvePromise, 8000)
        serve!.on("close", () => {
          clearTimeout(t)
          resolvePromise(undefined)
        })
      })
    }
    if (!args.keep) {
      try {
        rmSync(scratch, { recursive: true, force: true })
      } catch {
        // best effort
      }
    } else {
      console.log(`kept scratch: ${scratch}`)
    }
  }

  const json = JSON.stringify(result, null, 2)
  if (args.out) {
    writeFileSync(args.out, json)
    console.log(`wrote ${args.out}`)
  }
  // Key numbers always go to stdout.
  const s = result["serve"] as IdleResult & { started: boolean }
  const db0 = result["dbPre"] as DbSnapshot
  const db1 = result["dbPostIdle"] as DbSnapshot
  const db2 = result["dbPostIndex"] as DbSnapshot
  console.log("--- perf-probe key numbers ---")
  if (s?.started) {
    console.log(
      `idle: samples=${s.samples} wall=${s.wallSeconds}s peakRSS=${(s.peakRssBytes / 1048576).toFixed(1)}MB ` +
        `steadyRSS=${(s.steadyRssBytes / 1048576).toFixed(1)}MB p95RSS=${(s.p95RssBytes / 1048576).toFixed(1)}MB ` +
        `cpu=${s.cpuSeconds}s (${s.cpuPctOneCore}% of one core)`,
    )
  } else {
    console.log(`idle: serve not started (${JSON.stringify(result["serve"])})`)
  }
  console.log("sessionReplay: SKIPPED (no cassette infra yet)")
  const ix = result["index"] as { runs?: BuildRun[]; rssGrowthIdenticalRunsBytes?: number | null; skipped?: string }
  if (ix?.runs) {
    for (const r of ix.runs)
      console.log(
        `index ${r.name}: wall=${(r.wallMs / 1000).toFixed(1)}s peakRSS=${(r.peakRssBytes / 1048576).toFixed(1)}MB exit=${r.exitCode} timedOut=${r.timedOut}`,
      )
    console.log(`index rss growth (identical runs): ${ix.rssGrowthIdenticalRunsBytes} bytes`)
  } else {
    console.log(`index: ${ix?.skipped ?? "n/a"}`)
  }
  console.log(
    `db bytes: pre=${db0.totalBytes} postIdle=${db1.totalBytes} (+${db1.totalBytes - db0.totalBytes}) postIndex=${db2.totalBytes} (+${db2.totalBytes - db1.totalBytes})`,
  )
  console.log(
    `event rows/bytes: pre=${db0.eventRows}/${db0.eventBytes} postIdle=${db1.eventRows}/${db1.eventBytes} postIndex=${db2.eventRows}/${db2.eventBytes}`,
  )
  if (!args.out) console.log(json)
}

await main()
