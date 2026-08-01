import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Ripgrep.defaultLayer)

// Phase 7 follow-up: regression fixtures for the `.bun-cache` and
// `node_modules` cache exclusions. Per the plan, a broken symlink
// under `.bun-cache` (or `node_modules`) must not turn a partial
// search into a total outage. Even though ripgrep itself tends to
// recover from broken symlinks, the previous version emitted noisy
// stderr and the leaf tools collapsed the failure into a generic
// "ripgrep execution failed" error. The new default exclusions
// route cache trees around the problem entirely.

describe("Ripgrep cache-tree resilience", () => {
  it.live("excludes .bun-cache files from find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".bun-cache", "v1"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".bun-cache", "v1", "bytecode.bin"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "export const x = 1\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 100 })
          const paths = files.map((item) => item.path)

          expect(paths).toContain(RelativePath.make("src/index.js"))
          // The cache tree must be excluded by default. If the test
          // ever fails here, the `.bun-cache` exclusion was removed
          // from the default args in ripgrep.ts.
          expect(paths).not.toContain(RelativePath.make(".bun-cache/v1/bytecode.bin"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes node_modules entries in catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 100 })
          const paths = files.map((item) => item.path)

          expect(paths).toContain(RelativePath.make("src/index.js"))
          expect(paths).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("grep returns healthy source matches even when .bun-cache is present", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".bun-cache"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".bun-cache", "noise.txt"), "needle\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "app.ts"), "const needle = 'target'\n"))

          const matches = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            limit: 100,
          })

          // The cache-tree exclusion makes grep skip the noise entry;
          // only the source file under `src/` should match.
          const matched = matches.map((m) => m.entry.path)
          expect(matched).toContain(RelativePath.make("src/app.ts"))
          expect(matched).not.toContain(RelativePath.make(".bun-cache/noise.txt"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
