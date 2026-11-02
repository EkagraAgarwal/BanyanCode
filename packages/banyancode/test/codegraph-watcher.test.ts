import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { FileChange } from "../src/codegraph/codegraph-auto-update.js"
import { make, type Update } from "../src/codegraph/codegraph-watcher.js"
import { join, resolve } from "node:path"

test("turns host updates into changes, skipping build output and anything outside the project", async () => {
  const root = resolve("project-root")
  const updates: Update[] = [
    { path: join(root, "src", "a.ts"), type: "update" },
    { path: join(root, "src", "new.ts"), type: "create" },
    { path: join(root, "src", "gone.ts"), type: "delete" },
    { path: join(root, "dist", "a.js"), type: "update" },
    { path: join(root, ".banyancode", "x"), type: "update" },
    { path: resolve("elsewhere", "b.ts"), type: "update" },
  ]
  const seen: FileChange[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* make({
          root,
          updates: Stream.fromIterable(updates),
          onChange: (change) => Effect.sync(() => void seen.push(change)),
        })
        yield* Effect.sleep("20 millis")
      }),
    ),
  )
  expect(seen).toEqual([
    { file: join(root, "src", "a.ts"), event: "change" },
    { file: join(root, "src", "new.ts"), event: "add" },
    { file: join(root, "src", "gone.ts"), event: "unlink" },
  ])
})

test("a watch that fails doesn't take anything else down", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* make({ root: resolve("r"), updates: Stream.fail(new Error("no watcher")), onChange: () => Effect.void })
        yield* Effect.sleep("20 millis")
      }),
    ),
  )
})
