import { describe, expect, test } from "bun:test"
import { cli, fakeServer, plain, rpcOutput, tmpRoot } from "./fixture"

const goal = {
  id: "goal_1",
  objective: "ship the release",
  status: "active",
  rounds: 2,
  maxRounds: 50,
  boot: "boot-1",
  updatedAt: 1_700_000_000_000,
}

describe("goal commands (v2 native goal mode)", () => {
  test("set runs the /goal command and prints v1's shape", async () => {
    const root = await tmpRoot("banyancode-cli-goal-set-")
    const commands: Array<{ sessionID: string; name: string; text: string }> = []
    let current: typeof goal | null = null
    const server = fakeServer(async (request, url) => {
      const command = /^\/api\/session\/([^/]+)\/command$/.exec(url.pathname)
      if (command && request.method === "POST") {
        const body = (await request.json()) as { name: string; text: string }
        commands.push({ sessionID: decodeURIComponent(command[1] ?? ""), name: body.name, text: body.text })
        current = goal
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/rpc/opencode.goal/get") return rpcOutput(current)
      return undefined
    })
    try {
      const result = await cli(root, [
        "goal",
        "set",
        "ship the release",
        "--plan",
        "./plan.md",
        "--priority",
        "high",
        "--session",
        "ses_1",
        "--server",
        server.url,
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("✓ goal set")
      expect(result.stderr).toContain("id:        goal_1")
      expect(result.stderr).toContain("condition: ship the release")
      expect(result.stderr).toContain("plan:      (none)")
      expect(result.stderr).toContain("priority:  (default)")
      expect(result.stderr).toContain("--plan/--priority are accepted for script compatibility")
      expect(commands).toEqual([{ sessionID: "ses_1", name: "goal", text: "ship the release" }])
    } finally {
      server.stop()
    }
  }, 180_000)

  test("status and list read the goal and keep v1 labels", async () => {
    const root = await tmpRoot("banyancode-cli-goal-status-")
    const server = fakeServer((_request, url) => {
      if (url.pathname === "/api/rpc/opencode.goal/get") return rpcOutput(goal)
      return undefined
    })
    try {
      const status = await cli(root, ["goal", "status", "--session", "ses_1", "--server", server.url])
      expect(status.exitCode).toBe(0)
      expect(status.stderr).toContain("Active goal: goal_1")
      expect(status.stderr).toContain("condition:     ship the release")
      expect(status.stderr).toContain("iteration:     2")
      expect(status.stderr).toContain("last reason:   (none)")
      expect(status.stderr).toContain("status:        active (rounds 2/50)")

      const list = await cli(root, ["goal", "list", "--session", "ses_1", "--server", server.url])
      expect(list.stderr).toContain("Goals for session ses_1: 1")
      expect(list.stderr).toContain("status=active iter=2")
    } finally {
      server.stop()
    }
  }, 180_000)

  test("reports no goal without failing", async () => {
    const root = await tmpRoot("banyancode-cli-goal-empty-")
    const server = fakeServer((_request, url) =>
      url.pathname === "/api/rpc/opencode.goal/get" ? rpcOutput(null) : undefined,
    )
    try {
      const status = await cli(root, ["goal", "status", "--session", "ses_9", "--server", server.url])
      expect(status.exitCode).toBe(0)
      expect(status.stderr).toContain("no active goal for session ses_9")

      const list = await cli(root, ["goal", "list", "--session", "ses_9", "--server", server.url])
      expect(list.stderr).toContain("Goals for session ses_9: 0")

      const cancel = await cli(root, ["goal", "cancel", "--session", "ses_9", "--server", server.url])
      expect(cancel.exitCode).toBe(0)
      expect(cancel.stderr).toContain("no active goal for session ses_9")
    } finally {
      server.stop()
    }
  }, 180_000)

  test("cancel clears the goal through /goal clear", async () => {
    const root = await tmpRoot("banyancode-cli-goal-cancel-")
    const texts: string[] = []
    const server = fakeServer(async (request, url) => {
      if (request.method === "POST" && /\/command$/.test(url.pathname)) {
        const body = (await request.json()) as { name: string; text: string }
        texts.push(`${body.name}:${body.text}`)
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/rpc/opencode.goal/get") return rpcOutput(goal)
      return undefined
    })
    try {
      const result = await cli(root, ["goal", "cancel", "--session", "ses_1", "--server", server.url])
      expect(result.exitCode).toBe(0)
      expect(plain(result.stderr)).toContain("✓ goal cancelled id=goal_1")
      expect(texts).toEqual(["goal:clear"])
    } finally {
      server.stop()
    }
  }, 180_000)
})
