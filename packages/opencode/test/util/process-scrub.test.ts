import { describe, expect, test } from "bun:test"
import { Process } from "@/util/process"

describe("util.process server secret scrub", () => {
  test("scrubServerSecretsFromEnv removes both keys, keeps the rest", () => {
    const input = {
      KEEP: "1",
      OPENCODE_SERVER_PASSWORD: "secret",
      BANYANCODE_SERVER_PASSWORD: "secret",
    }
    expect(Process.scrubServerSecretsFromEnv(input)).toEqual({ KEEP: "1" })
    expect(input.OPENCODE_SERVER_PASSWORD).toBe("secret")
  })

  test("scrub is case-insensitive", () => {
    const input = { KEEP: "1", opencode_server_password: "secret" }
    expect(Process.scrubServerSecretsFromEnv(input)).toEqual({ KEEP: "1" })
  })

  test("spawned children never inherit the server password", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "live-secret"
    process.env.BANYANCODE_SERVER_PASSWORD = "live-secret"
    process.env.OPENCODE_SCRUB_PROBE = "visible"
    try {
      const script = `process.stdout.write(JSON.stringify({
        open: process.env.OPENCODE_SERVER_PASSWORD ?? null,
        banyan: process.env.BANYANCODE_SERVER_PASSWORD ?? null,
        probe: process.env.OPENCODE_SCRUB_PROBE ?? null,
      }))`
      const merged = await Process.run([process.execPath, "-e", script], {
        env: { OPENCODE_SPAWN_EXTRA: "extra" },
      })
      expect(JSON.parse(merged.stdout.toString())).toEqual({ open: null, banyan: null, probe: "visible" })
      const inherited = await Process.run([process.execPath, "-e", script])
      expect(JSON.parse(inherited.stdout.toString())).toEqual({ open: null, banyan: null, probe: "visible" })
    } finally {
      delete process.env.OPENCODE_SERVER_PASSWORD
      delete process.env.BANYANCODE_SERVER_PASSWORD
      delete process.env.OPENCODE_SCRUB_PROBE
    }
  })
})
