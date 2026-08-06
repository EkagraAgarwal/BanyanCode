import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Location } from "@opencode-ai/core/location"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextBuiltIns } from "@opencode-ai/core/system-context/builtins"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

// The production builtins layer registers the BanyanCode codegraph policy
// source as a SEPARATE registry entry. `SystemContext.initialize` concatenates
// every admitted source's baseline, so the combined baseline below would carry
// the policy text when BanyanCode is enabled. The pure-builtins assertions in
// this file are exact string matches for the env/date/instructions block, so
// gate BanyanCode OFF here to keep them focused; the dedicated
// "V2 baseline policy" describe block re-enables it and asserts the policy is
// present in the production baseline.
process.env.BANYANCODE_ENABLE = "0"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const instructionFile = FSUtil.resolve("/repo/AGENTS.md")
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const localDate = (time: number) => new Date(time).toDateString()
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const it = testEffect(
  SystemContextBuiltIns.locationLayer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ config: "/global" })),
    Layer.provide(locationLayer),
  ),
)
const instructionFS = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.pipe(
    Effect.map((fs) =>
      FSUtil.Service.of({
        ...fs,
        up: () => Effect.succeed([instructionFile]),
        readFileStringSafe: (path) => Effect.succeed(path === instructionFile ? "Be precise." : undefined),
      }),
    ),
  ),
).pipe(Layer.provide(FSUtil.defaultLayer))
const itWithInstructions = testEffect(
  SystemContextBuiltIns.locationLayer.pipe(
    Layer.provide(instructionFS),
    Layer.provide(Global.layerWith({ config: "/global" })),
    Layer.provide(locationLayer),
  ),
)

describe("SystemContextBuiltIns", () => {
  it.effect("loads location-scoped environment and host-local date context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
        ].join("\n"),
      )
    }),
  )

  it.effect("reconciles the date without repeating unchanged environment context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)

      expect(refreshed).toMatchObject({
        _tag: "Updated",
        text: `Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`,
      })
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect(yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)).toEqual({ _tag: "Unchanged" })
    }),
  )

  itWithInstructions.effect("composes ambient instructions after built-in context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service

      expect((yield* SystemContext.initialize(yield* context.load())).baseline).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
          "",
          `Instructions from: ${instructionFile}\nBe precise.`,
        ].join("\n"),
      )
    }),
  )
})

describe("V2 baseline policy", () => {
  // The production builtins layer registers the BanyanCode codegraph policy
  // source when BanyanCode is enabled. This test asserts the V2 baseline —
  // produced by the REAL `SystemContextBuiltIns.locationLayer` — carries the
  // policy, i.e. the V2 prompt wiring is live in production, not just in a
  // hand-wired test layer. The env flag must be set BEFORE the layer builds,
  // so this is a plain async test that builds the layer explicitly.
  test("baseline contains the codegraph policy when BanyanCode is enabled", async () => {
    const prev = process.env.BANYANCODE_ENABLE
    process.env.BANYANCODE_ENABLE = "1"
    try {
      const layer = SystemContextBuiltIns.locationLayer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Global.layerWith({ config: "/global" })),
        Layer.provide(locationLayer),
      )
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* SystemContextRegistry.Service
            const initialized = yield* SystemContext.initialize(yield* context.load())
            expect(initialized.baseline).toContain("## Codegraph-first search policy (ALWAYS)")
            expect(initialized.baseline).toContain("code_find")
            expect(initialized.snapshot["banyancode/codegraph-policy"]).toBeDefined()
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.BANYANCODE_ENABLE
      else process.env.BANYANCODE_ENABLE = prev
    }
  })
})
