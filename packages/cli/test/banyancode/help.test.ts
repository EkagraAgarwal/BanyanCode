import { describe, expect, test } from "bun:test"
import { cli, tmpRoot } from "./fixture"

describe("banyancode CLI subcommands (v1 parity section 8a)", () => {
  test("top-level help lists every BanyanCode command", async () => {
    const root = await tmpRoot()
    const result = await cli(root, ["--help"])
    expect(result.exitCode).toBe(0)
    for (const command of [
      "codegraph",
      "goal",
      "repository",
      "websearch-free",
      "tools",
      "telemetry",
      "db",
    ]) {
      expect(result.stdout).toContain(command)
    }
  }, 120_000)

  test("codegraph exposes build/status/cancel/remove/force-kill/path/trace and v1 flags", async () => {
    const root = await tmpRoot()
    const [help, build] = await Promise.all([
      cli(root, ["codegraph", "--help"]),
      cli(root, ["codegraph", "build", "--help"]),
    ])
    expect(help.exitCode).toBe(0)
    for (const command of ["build", "status", "cancel", "remove", "force-kill", "path", "trace"]) {
      expect(help.stdout).toContain(command)
    }
    expect(build.stdout).toContain("--root")
    expect(build.stdout).toContain("--force")
    expect(build.stdout).toContain("--watch")
    expect(build.stdout).toContain("--timeout")
  }, 120_000)

  test("goal and repository keep v1 positionals and flags", async () => {
    const root = await tmpRoot()
    const [goal, set, repo, trace, relationships] = await Promise.all([
      cli(root, ["goal", "--help"]),
      cli(root, ["goal", "set", "--help"]),
      cli(root, ["repository", "--help"]),
      cli(root, ["repository", "trace", "--help"]),
      cli(root, ["repository", "relationships", "--help"]),
    ])
    for (const command of ["set", "status", "list", "cancel"]) expect(goal.stdout).toContain(command)
    expect(set.stdout).toContain("condition")
    expect(set.stdout).toContain("--plan")
    expect(set.stdout).toContain("--priority")
    expect(set.stdout).toContain("--session")
    for (const command of ["query", "explain", "trace", "impact", "tests", "relationships", "ownership"]) {
      expect(repo.stdout).toContain(command)
    }
    expect(trace.stdout).toContain("--depth")
    expect(relationships.stdout).toContain("--depth")
  }, 120_000)

  test("websearch-free, tools, telemetry, db and stats expose their v1 surface", async () => {
    const root = await tmpRoot()
    const [websearch, tools, telemetry, report, db, stats] = await Promise.all([
      cli(root, ["websearch-free", "--help"]),
      cli(root, ["tools", "--help"]),
      cli(root, ["telemetry", "--help"]),
      cli(root, ["telemetry", "agent-report", "--help"]),
      cli(root, ["db", "gc", "--help"]),
      cli(root, ["stats", "--help"]),
    ])
    expect(websearch.stdout).toContain("--num")
    expect(tools.stdout).toContain("--category")
    for (const command of ["status", "on", "off", "agent-report", "agent-export"]) {
      expect(telemetry.stdout).toContain(command)
    }
    expect(report.stdout).toContain("--run-id")
    expect(report.stdout).toContain("--session-id")
    expect(report.stdout).toContain("--since")
    expect(report.stdout).toContain("--json")
    expect(db.stdout).toContain("--yes")
    expect(db.stdout).toContain("--dry-run")
    expect(db.stdout).toContain("--root")
    expect(stats.stdout).toContain("--heatmap")
  }, 120_000)
})
