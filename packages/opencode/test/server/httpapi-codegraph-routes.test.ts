import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

// Bound the codegraph auto-build wait so an unbuilt tmp project answers quickly; the build keeps running detached.
process.env.BANYANCODE_CODEGRAPH_READY_WAIT_MS = "1000"

// Disposal may have to wait for that detached build to wind down.
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
}, 60_000)

// Regression: createRoutes() used the codegraph Analyzer/Repo only via Layer.provide, so the handler died
// with "Service not found: .../CodegraphRepo" (HTTP 500 UnknownError). /global/preflight and /global/blast-radius
// additionally hit the permission bridge, which needs an InstanceRef that /global routes do not have.
const cases = [
  ["/global/code-find", { intent: "definition", target: "createMcpServer", includeKeywordFallback: true, limit: 2 }],
  ["/global/preflight", { target: "createMcpServer" }],
  ["/global/blast-radius", { target: "createMcpServer" }],
] as const

describe("codegraph global routes", () => {
  for (const [route, body] of cases) {
    it.live(
      `${route} resolves its services through the real server composition`,
      Effect.gen(function* () {
        const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(route, {
              method: "POST",
              headers: { "content-type": "application/json", "x-opencode-directory": tmp.path },
              body: JSON.stringify(body),
            }),
          ),
        )
        const text = yield* Effect.promise(() => response.text())
        if (response.status === 500) console.error(text)
        expect(response.status).not.toBe(500)
        expect(text).not.toContain("UnknownError")
        expect(text).not.toContain("Service not found")
      }),
      120_000,
    )
  }
})
