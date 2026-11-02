import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { FileChange } from "../src/codegraph/codegraph-auto-update.js"
import { make } from "../src/codegraph/codegraph-watcher.js"

const until = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await Bun.sleep(25)
}

test("sees project edits, including in new folders, but not dependency folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "banyancode-watch-"))
  await mkdir(join(root, "src"))
  await mkdir(join(root, "node_modules", "dep"), { recursive: true })
  const seen: FileChange[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* make({ root, onChange: (change) => Effect.sync(() => void seen.push(change)) })
          yield* Effect.promise(async () => {
            await Bun.sleep(200)
            await writeFile(join(root, "src", "a.ts"), "export const a = 1\n")
            await until(() => seen.some((change) => change.file.endsWith("a.ts")))

            await writeFile(join(root, "node_modules", "dep", "index.js"), "1\n")

            await mkdir(join(root, "src", "fresh"))
            await Bun.sleep(200)
            await writeFile(join(root, "src", "fresh", "b.ts"), "export const b = 2\n")
            await until(() => seen.some((change) => change.file.endsWith("b.ts")))
          })
        }),
      ),
    )
    expect(seen.some((change) => change.file.endsWith("a.ts"))).toBe(true)
    expect(seen.some((change) => change.file.endsWith("b.ts"))).toBe(true)
    expect(seen.some((change) => change.file.includes("node_modules"))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
