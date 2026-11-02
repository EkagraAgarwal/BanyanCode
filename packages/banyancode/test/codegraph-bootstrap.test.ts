import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { make } from "../src/codegraph/codegraph-bootstrap"
import { isHomeOrAbove } from "../src/codegraph/workspace-identity"

const ensured = async (root: string) => {
  const started: string[] = []
  const bootstrap = await Effect.runPromise(
    make({
      readiness: {
        status: () => Effect.succeed({ reason: "missing" }),
        ensureReady: (input: { root: string }) =>
          Effect.sync(() => {
            started.push(input.root)
            return { reason: "ready" }
          }),
      } as never,
      watchEnabled: () => Effect.succeed(true),
    }),
  )
  await Effect.runPromise(bootstrap.ensureGraph({ root }))
  await Effect.runPromise(Effect.sleep("20 millis"))
  return started
}

describe("codegraph bootstrap", () => {
  test("never starts a build in the home folder or above it", async () => {
    expect(await ensured(homedir())).toEqual([])
    expect(await ensured(dirname(homedir()))).toEqual([])
  })

  test("starts a build in a project, including one under the home folder", async () => {
    const project = join(homedir(), "code", "project")
    expect(await ensured(project)).toEqual([project])
    expect(isHomeOrAbove(project)).toBe(false)
  })
})
