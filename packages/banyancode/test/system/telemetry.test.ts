import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildPayload,
  heartbeat,
  pingOnFirstRun,
  readInstallIdentity,
  telemetryEnabled,
  transportAvailable,
} from "../../src/system/install-telemetry.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-telemetry-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

interface Captured {
  readonly url: string
  readonly body: any
}

const fakeFetch = (captured: Captured[], ok = true) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response("{}", { status: ok ? 200 : 500 })
  }) as unknown as typeof fetch

describe("install telemetry", () => {
  test("opt-out switches", () => {
    expect(telemetryEnabled({}, undefined)).toBe(true)
    expect(telemetryEnabled({ BANYANCODE_TELEMETRY: "off" }, "on")).toBe(false)
    expect(telemetryEnabled({ DO_NOT_TRACK: "1" }, "on")).toBe(false)
    expect(telemetryEnabled({}, "off")).toBe(false)
    expect(transportAvailable({ endpoint: "" })).toBe(false)
    expect(transportAvailable({ posthogKey: "phc_x" })).toBe(true)
  })

  test("no key means a silent no-op with no state file", async () => {
    await withTemp(async (directory) => {
      const outcome = await pingOnFirstRun({
        stateDir: directory,
        endpoint: "",
        env: {},
        version: "26.10.9",
        channel: "latest",
      })
      expect(outcome).toBe("noop")
      await expect(readFile(join(directory, "install.json"), "utf8")).rejects.toThrow()
    })
  })

  test("disabled setting and DO_NOT_TRACK do not touch the transport", async () => {
    await withTemp(async (directory) => {
      const captured: Captured[] = []
      expect(
        await pingOnFirstRun({
          stateDir: directory,
          endpoint: "https://telemetry.test",
          fetchImpl: fakeFetch(captured),
          env: { BANYANCODE_TELEMETRY: "off" },
        }),
      ).toBe("disabled")
      expect(
        await pingOnFirstRun({
          stateDir: directory,
          endpoint: "https://telemetry.test",
          fetchImpl: fakeFetch(captured),
          env: { DO_NOT_TRACK: "1" },
        }),
      ).toBe("disabled")
      expect(captured).toHaveLength(0)
    })
  })

  test("first run posts banyan_install to PostHog and a retry within a day is idle", async () => {
    await withTemp(async (directory) => {
      const captured: Captured[] = []
      const options = {
        stateDir: directory,
        posthogKey: "phc_test",
        fetchImpl: fakeFetch(captured),
        env: { CI: "1" },
        now: () => Date.parse("2026-11-01T00:00:00Z"),
        version: "26.10.9",
        channel: "latest",
      }
      expect(await pingOnFirstRun(options)).toBe("fired")
      expect(captured).toHaveLength(1)
      expect(captured[0]!.url).toBe("https://us.i.posthog.com/i/v0/e/")
      expect(captured[0]!.body.api_key).toBe("phc_test")
      expect(captured[0]!.body.event).toBe("banyan_install")
      expect(captured[0]!.body.properties).toMatchObject({
        version: "26.10.9",
        channel: "latest",
        os: process.platform,
        arch: process.arch,
        ci: true,
      })
      expect(captured[0]!.body.properties).not.toHaveProperty("install_id")
      expect(captured[0]!.body.distinct_id).toBeString()

      const identity = await readInstallIdentity(directory)
      expect(identity?.telemetry.last_success).toBeString()
      expect(await pingOnFirstRun(options)).toBe("idle")
      expect(captured).toHaveLength(1)
    })
  })

  test("a failed attempt retries after 24 hours, not before", async () => {
    await withTemp(async (directory) => {
      const captured: Captured[] = []
      let now = Date.parse("2026-11-01T00:00:00Z")
      const options = {
        stateDir: directory,
        posthogKey: "phc_test",
        fetchImpl: fakeFetch(captured, false),
        env: {},
        now: () => now,
      }
      expect(await pingOnFirstRun(options)).toBe("fired")
      expect(await pingOnFirstRun(options)).toBe("idle")
      now += 25 * 60 * 60 * 1000
      expect(await pingOnFirstRun(options)).toBe("fired")
    })
  })

  test("heartbeat only fires after a successful first run and posts banyan_heartbeat", async () => {
    await withTemp(async (directory) => {
      const captured: Captured[] = []
      let now = Date.parse("2026-11-01T00:00:00Z")
      const options = {
        stateDir: directory,
        posthogKey: "phc_test",
        fetchImpl: fakeFetch(captured),
        env: {},
        now: () => now,
      }
      expect(await heartbeat(options)).toBe("idle")
      expect(await pingOnFirstRun(options)).toBe("fired")
      expect(await heartbeat(options)).toBe("fired")
      expect(captured).toHaveLength(2)
      expect(captured[1]!.body.event).toBe("banyan_heartbeat")
      expect(await heartbeat(options)).toBe("idle")
      now += 8 * 24 * 60 * 60 * 1000
      expect(await heartbeat(options)).toBe("fired")
    })
  })

  test("custom endpoint posts the raw payload", async () => {
    await withTemp(async (directory) => {
      const captured: Captured[] = []
      const identity = { install_id: "install-1", telemetry: {} }
      const payload = buildPayload(identity, {
        version: "26.10.9",
        channel: "dev",
        env: {},
        installMethod: "bun",
      })
      expect(payload).toMatchObject({
        install_id: "install-1",
        event_type: "first_run",
        version: "26.10.9",
        channel: "dev",
        install_method: "bun",
      })
      const outcome = await pingOnFirstRun({
        stateDir: directory,
        endpoint: "https://telemetry.test",
        fetchImpl: fakeFetch(captured),
        env: {},
        now: () => 1,
      })
      expect(outcome).toBe("fired")
      expect(captured[0]!.url).toBe("https://telemetry.test/ping")
      expect(captured[0]!.body.event_type).toBe("first_run")
    })
  })
})
