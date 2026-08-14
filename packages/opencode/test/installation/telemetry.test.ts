import { describe, expect, test } from "bun:test"
import path from "path"
import {
  buildPayload,
  mapInstallMethod,
  pingOnFirstRun,
  readInstallIdentity,
  shouldPing,
  telemetryEnabled,
  type InstallIdentity,
  type PingPayload,
} from "../../src/installation/telemetry"
import { tmpdir } from "../fixture/fixture"

describe("state machine", () => {
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  const now = Date.parse("2026-01-01T00:00:00Z")

  test("no file -> should ping", () => {
    expect(shouldPing(undefined, now)).toBe(true)
  })

  test("file without last_success and fresh attempt -> no", () => {
    const identity: InstallIdentity = {
      install_id: "uuid",
      telemetry: { last_attempt: new Date(now - HOUR).toISOString() },
    }
    expect(shouldPing(identity, now)).toBe(false)
  })

  test("file without last_success and stale attempt -> yes", () => {
    const identity: InstallIdentity = {
      install_id: "uuid",
      telemetry: { last_attempt: new Date(now - DAY - HOUR).toISOString() },
    }
    expect(shouldPing(identity, now)).toBe(true)
  })

  test("file with malformed last_attempt -> yes (retry)", () => {
    const identity: InstallIdentity = {
      install_id: "uuid",
      telemetry: { last_attempt: "not-a-date" },
    }
    expect(shouldPing(identity, now)).toBe(true)
  })

  test("last_success -> never", () => {
    const identity: InstallIdentity = {
      install_id: "uuid",
      telemetry: { last_success: new Date(now).toISOString() },
    }
    expect(shouldPing(identity, now)).toBe(false)
  })
})

describe("consent", () => {
  test("default on", () => {
    expect(telemetryEnabled({})).toBe(true)
  })

  test("BANYANCODE_TELEMETRY=off disables", () => {
    expect(telemetryEnabled({ BANYANCODE_TELEMETRY: "off" })).toBe(false)
  })

  test("DO_NOT_TRACK=1 disables", () => {
    expect(telemetryEnabled({ DO_NOT_TRACK: "1" })).toBe(false)
  })

  test("config off disables", () => {
    expect(telemetryEnabled({}, "off")).toBe(false)
  })

  test("config on keeps enabled", () => {
    expect(telemetryEnabled({}, "on")).toBe(true)
  })
})

describe("install_method mapping", () => {
  const install = (method: "npm" | "yarn" | "pnpm" | "bun" | "brew" | "curl" | "scoop" | "choco" | "snap") => [
    { method, path: "/fake/banyancode" },
  ]

  test("npm family maps to npm", () => {
    expect(mapInstallMethod(install("npm"))).toBe("npm")
    expect(mapInstallMethod(install("yarn"))).toBe("npm")
  })

  test("pnpm", () => {
    expect(mapInstallMethod(install("pnpm"))).toBe("pnpm")
  })

  test("bun", () => {
    expect(mapInstallMethod(install("bun"))).toBe("bun")
  })

  test("brew maps to homebrew", () => {
    expect(mapInstallMethod(install("brew"))).toBe("homebrew")
  })

  test("standalone installers", () => {
    expect(mapInstallMethod(install("curl"))).toBe("standalone")
    expect(mapInstallMethod(install("scoop"))).toBe("standalone")
    expect(mapInstallMethod(install("choco"))).toBe("standalone")
    expect(mapInstallMethod(install("snap"))).toBe("standalone")
  })

  test("no install detected -> source on local builds", () => {
    expect(mapInstallMethod([])).toBe("source")
  })
})

describe("payload", () => {
  test("stays under 200 bytes with worst-case values", () => {
    const payload: PingPayload = {
      install_id: "123e4567-e89b-12d3-a456-426614174000",
      version: "26.07.4-dev.abc1234",
      channel: "latest",
      os: "linux",
      arch: "x64",
      install_method: "standalone",
      ci: true,
    }
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(200)
  })

  test("carries install identity and normalized method", async () => {
    const identity: InstallIdentity = { install_id: "test-id", telemetry: {} }
    const payload = await buildPayload(identity, { CI: "1" }, async () => [{ method: "npm", path: "/x" }])
    expect(payload.install_id).toBe("test-id")
    expect(payload.ci).toBe(true)
    expect(payload.install_method).toBe("npm")
    expect(payload.os).toBe(process.platform)
    expect(payload.arch).toBe(process.arch)
  })
})

describe("pingOnFirstRun", () => {
  const optionsFor = (tmp: { path: string }) => ({
    stateDir: tmp.path,
    configDir: path.join(tmp.path, "config"),
    probeInstalls: async () => [],
  })

  test("first run pings, writes last_success, stops pinging", async () => {
    await using tmp = await tmpdir()
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch
    const options = { ...optionsFor(tmp), fetchImpl }
    expect(await pingOnFirstRun(options)).toBe("fired")
    expect(calls).toBe(1)
    const identity = await readInstallIdentity(tmp.path)
    expect(identity?.install_id).toBeDefined()
    expect(identity?.telemetry.last_attempt).toBeDefined()
    expect(identity?.telemetry.last_success).toBeDefined()
    expect(await pingOnFirstRun(options)).toBe("idle")
    expect(calls).toBe(1)
  })

  test("failed ping keeps last_attempt, no last_success", async () => {
    await using tmp = await tmpdir()
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
    expect(await pingOnFirstRun({ ...optionsFor(tmp), fetchImpl })).toBe("fired")
    const identity = await readInstallIdentity(tmp.path)
    expect(identity?.telemetry.last_attempt).toBeDefined()
    expect(identity?.telemetry.last_success).toBeUndefined()
  })

  test("post failure is silent and leaves state dir untouched", async () => {
    await using tmp = await tmpdir()
    const fetchImpl = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    expect(await pingOnFirstRun({ ...optionsFor(tmp), fetchImpl })).toBe("fired")
    const identity = await readInstallIdentity(tmp.path)
    expect(identity?.telemetry.last_attempt).toBeDefined()
    expect(identity?.telemetry.last_success).toBeUndefined()
  })

  test("consent off never pings and writes nothing", async () => {
    await using tmp = await tmpdir()
    const fetchImpl = (async () => {
      throw new Error("must not be called")
    }) as unknown as typeof fetch
    const options = { ...optionsFor(tmp), fetchImpl, env: { BANYANCODE_TELEMETRY: "off" } }
    expect(await pingOnFirstRun(options)).toBe("disabled")
    expect(await readInstallIdentity(tmp.path)).toBeUndefined()
  })

  test("config file with banyancode_telemetry off disables", async () => {
    await using tmp = await tmpdir()
    const configDir = path.join(tmp.path, "config")
    await Bun.write(path.join(configDir, "banyancode.json"), JSON.stringify({ banyancode_telemetry: "off" }))
    const fetchImpl = (async () => {
      throw new Error("must not be called")
    }) as unknown as typeof fetch
    const options = { ...optionsFor(tmp), configDir, fetchImpl }
    expect(await pingOnFirstRun(options)).toBe("disabled")
    expect(await readInstallIdentity(tmp.path)).toBeUndefined()
  })

  test("posts payload to {endpoint}/ping", async () => {
    await using tmp = await tmpdir()
    let captured: { url: string; body?: string } | undefined
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      captured = { url: String(input), body: init?.body as string | undefined }
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch
    expect(
      await pingOnFirstRun({ ...optionsFor(tmp), endpoint: "https://telemetry.test", fetchImpl }),
    ).toBe("fired")
    expect(captured?.url).toBe("https://telemetry.test/ping")
    const body = JSON.parse(captured?.body ?? "{}")
    expect(body.install_id).toBeDefined()
    expect(typeof body.install_method).toBe("string")
    expect(typeof body.ci).toBe("boolean")
  })
})
