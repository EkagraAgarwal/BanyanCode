import { describe, expect, test } from "bun:test"
import path from "path"
import {
  buildPayload,
  heartbeat,
  mapInstallMethod,
  pingOnFirstRun,
  readInstallIdentity,
  shouldHeartbeat,
  shouldPing,
  telemetryEnabled,
  transportAvailable,
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
      event_type: "heartbeat",
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
    endpoint: "https://telemetry.test",
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
    expect(body.event_type).toBe("first_run")
    expect(typeof body.install_method).toBe("string")
    expect(typeof body.ci).toBe("boolean")
  })
})

describe("heartbeat gating", () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.parse("2026-01-01T00:00:00Z")

  test("no identity -> false", () => {
    expect(shouldHeartbeat(undefined, now)).toBe(false)
  })

  test("no last_success -> false", () => {
    const identity: InstallIdentity = { install_id: "uuid", telemetry: {} }
    expect(shouldHeartbeat(identity, now)).toBe(false)
  })

  test("no last_heartbeat -> true", () => {
    const identity: InstallIdentity = {
      install_id: "uuid",
      telemetry: { last_success: new Date(now - DAY).toISOString() },
    }
    expect(shouldHeartbeat(identity, now)).toBe(true)
  })

  test("fresh last_heartbeat -> false", () => {
    const identity: InstallIdentity = {
      install_id: "uuid",
      telemetry: {
        last_success: new Date(now - 2 * DAY).toISOString(),
        last_heartbeat: new Date(now - 1000).toISOString(),
      },
    }
    expect(shouldHeartbeat(identity, now)).toBe(false)
  })

  test("stale last_heartbeat (7 days + 1h) -> true", () => {
    const identity: InstallIdentity = {
      install_id: "uuid",
      telemetry: {
        last_success: new Date(now - 10 * DAY).toISOString(),
        last_heartbeat: new Date(now - 7 * DAY - 60 * 60 * 1000).toISOString(),
      },
    }
    expect(shouldHeartbeat(identity, now)).toBe(true)
  })

  test("malformed last_heartbeat -> true", () => {
    const identity: InstallIdentity = {
      install_id: "uuid",
      telemetry: { last_success: new Date(now).toISOString(), last_heartbeat: "not-a-date" },
    }
    expect(shouldHeartbeat(identity, now)).toBe(true)
  })
})

describe("heartbeat", () => {
  const optionsFor = (tmp: { path: string }) => ({
    stateDir: tmp.path,
    configDir: path.join(tmp.path, "config"),
    probeInstalls: async () => [],
    endpoint: "https://telemetry.test",
  })
  const installWithSuccess = async (tmp: { path: string }) => {
    await Bun.write(
      path.join(tmp.path, "install.json"),
      JSON.stringify({ install_id: "test-id", telemetry: { last_success: new Date().toISOString() } }),
    )
  }

  test("no identity -> idle, fetch never called", async () => {
    await using tmp = await tmpdir()
    const fetchImpl = (async () => {
      throw new Error("must not be called")
    }) as unknown as typeof fetch
    expect(await heartbeat({ ...optionsFor(tmp), fetchImpl })).toBe("idle")
  })

  test("no last_success -> idle, fetch never called", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "install.json"), JSON.stringify({ install_id: "test-id", telemetry: {} }))
    const fetchImpl = (async () => {
      throw new Error("must not be called")
    }) as unknown as typeof fetch
    expect(await heartbeat({ ...optionsFor(tmp), fetchImpl })).toBe("idle")
  })

  test("fires after last_success, writes last_heartbeat, then idles on cadence", async () => {
    await using tmp = await tmpdir()
    await installWithSuccess(tmp)
    let calls = 0
    let captured: { url: string; body?: string } | undefined
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls++
      captured = { url: String(input), body: init?.body as string | undefined }
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch
    const options = { ...optionsFor(tmp), endpoint: "https://telemetry.test", fetchImpl }
    expect(await heartbeat(options)).toBe("fired")
    expect(calls).toBe(1)
    expect(captured?.url).toBe("https://telemetry.test/ping")
    const body = JSON.parse(captured?.body ?? "{}")
    expect(body.event_type).toBe("heartbeat")
    const identity = await readInstallIdentity(tmp.path)
    expect(identity?.telemetry.last_heartbeat).toBeDefined()
    expect(identity?.telemetry.last_attempt).toBeUndefined()
    expect(await heartbeat(options)).toBe("idle")
    expect(calls).toBe(1)
  })

  test("consent off -> disabled and nothing written", async () => {
    await using tmp = await tmpdir()
    const fetchImpl = (async () => {
      throw new Error("must not be called")
    }) as unknown as typeof fetch
    const options = { ...optionsFor(tmp), fetchImpl, env: { BANYANCODE_TELEMETRY: "off" } }
    expect(await heartbeat(options)).toBe("disabled")
    expect(await readInstallIdentity(tmp.path)).toBeUndefined()
  })
})

describe("posthog transport", () => {
  const optionsFor = (tmp: { path: string }) => ({
    stateDir: tmp.path,
    configDir: path.join(tmp.path, "config"),
    probeInstalls: async () => [],
  })

  test("first run posts banyan_install to posthog capture", async () => {
    await using tmp = await tmpdir()
    let captured: { url: string; body?: string } | undefined
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      captured = { url: String(input), body: init?.body as string | undefined }
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch
    expect(await pingOnFirstRun({ ...optionsFor(tmp), posthogKey: "phc_test", fetchImpl })).toBe("fired")
    expect(captured?.url).toBe("https://us.i.posthog.com/i/v0/e/")
    const body = JSON.parse(captured?.body ?? "{}")
    expect(body.api_key).toBe("phc_test")
    expect(body.distinct_id).toBe((await readInstallIdentity(tmp.path))?.install_id)
    expect(body.event).toBe("banyan_install")
    expect(body.properties.version).toBeDefined()
    expect(body.properties.channel).toBeDefined()
    expect(body.properties.os).toBeDefined()
    expect(body.properties.arch).toBeDefined()
    expect(body.properties.install_method).toBeDefined()
    expect(body.properties.ci).toBeDefined()
    expect(body.properties.install_id).toBeUndefined()
    expect(body.properties.event_type).toBeUndefined()
  })

  test("heartbeat posts banyan_heartbeat to posthog capture", async () => {
    await using tmp = await tmpdir()
    await Bun.write(
      path.join(tmp.path, "install.json"),
      JSON.stringify({ install_id: "test-id", telemetry: { last_success: new Date().toISOString() } }),
    )
    let captured: { url: string; body?: string } | undefined
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      captured = { url: String(input), body: init?.body as string | undefined }
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch
    expect(await heartbeat({ ...optionsFor(tmp), posthogKey: "phc_test", fetchImpl })).toBe("fired")
    expect(captured?.url).toBe("https://us.i.posthog.com/i/v0/e/")
    const body = JSON.parse(captured?.body ?? "{}")
    expect(body.distinct_id).toBe("test-id")
    expect(body.event).toBe("banyan_heartbeat")
    expect(body.properties.install_id).toBeUndefined()
    expect(body.properties.event_type).toBeUndefined()
  })

  test("transportAvailable: no key/endpoint is false, endpoint or key alone is true", () => {
    expect(transportAvailable({})).toBe(false)
    expect(transportAvailable({ endpoint: "https://x" })).toBe(true)
    expect(transportAvailable({ posthogKey: "phc_x" })).toBe(true)
  })

  test("no key and no endpoint -> noop, fetch never called, state untouched", async () => {
    await using tmp = await tmpdir()
    const fetchImpl = (async () => {
      throw new Error("must not be called")
    }) as unknown as typeof fetch
    expect(await pingOnFirstRun({ ...optionsFor(tmp), fetchImpl })).toBe("noop")
    expect(await readInstallIdentity(tmp.path)).toBeUndefined()
  })
})
