import { describe, expect, test } from "bun:test"
import { buildCleanupSteps, buildShutdownCleanup } from "../../src/mcp-server/transport-stdio"

function recorder(name: string, calls: string[], fail = false) {
  return async () => {
    calls.push(name)
    if (fail) throw new Error(`${name} failed`)
  }
}

describe("transport-stdio shutdown sequence", () => {
  test("cleanup runs listener stop, aborts, dispose, db close in order", async () => {
    const calls: string[] = []
    const cleanup = buildCleanupSteps({
      stopListener: recorder("stop", calls),
      abortOwnedSessions: recorder("abort", calls),
      disposeInstances: recorder("dispose", calls),
      closeDatabase: recorder("dbclose", calls),
    })
    await cleanup()
    expect(calls).toEqual(["stop", "abort", "dispose", "dbclose"])
  })

  test("a failing step does not skip the later steps", async () => {
    const calls: string[] = []
    const cleanup = buildCleanupSteps({
      stopListener: recorder("stop", calls, true),
      abortOwnedSessions: recorder("abort", calls, true),
      disposeInstances: recorder("dispose", calls),
    })
    await cleanup()
    expect(calls).toEqual(["stop", "abort", "dispose"])
  })

  test("absent optional hooks are skipped", async () => {
    const calls: string[] = []
    await buildCleanupSteps({ stopListener: recorder("stop", calls) })()
    expect(calls).toEqual(["stop"])
  })

  test("attach mode leaves cleanup a no-op and never calls injected hooks", async () => {
    const calls: string[] = []
    const serverCleanup = recorder("server", calls)
    const cleanup = buildShutdownCleanup({
      attach: "http://127.0.0.1:4096",
      abortOwnedSessions: recorder("abort", calls),
      serverCleanup,
      disposeInstances: recorder("dispose", calls),
      closeDatabase: recorder("dbclose", calls),
    })
    await cleanup()
    expect(calls).toEqual(["server"])
  })

  test("in-process mode orders injected hooks after the server cleanup", async () => {
    const calls: string[] = []
    const cleanup = buildShutdownCleanup({
      abortOwnedSessions: recorder("abort", calls),
      serverCleanup: recorder("server", calls),
      disposeInstances: recorder("dispose", calls),
      closeDatabase: recorder("dbclose", calls),
    })
    await cleanup()
    expect(calls).toEqual(["server", "abort", "dispose", "dbclose"])
  })
})
