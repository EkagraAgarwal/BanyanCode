import { describe, expect } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { BanyanFilesystem } from "../../src/banyancode/filesystem"
import { EventV2 } from "../../src/event"
import { testEffect } from "../lib/effect"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const live = BanyanFilesystem.defaultLayer.pipe(
  Layer.provideMerge(EventV2.defaultLayer),
  Layer.provideMerge(NodeFileSystem.layer),
)

const it = testEffect(live)

describe("BanyanFilesystem.listTree", () => {
  it.effect("returns a non-empty tree for a populated directory", () =>
    Effect.gen(function* () {
      const fs = yield* BanyanFilesystem.Service
      const tmp = yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeTempDirectoryScoped()))

      // Create nested files: src/index.ts and package.json
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.join(tmp, "src"))
            yield* fs.writeFileString(path.join(tmp, "src", "index.ts"), "export {}")
            yield* fs.writeFileString(path.join(tmp, "package.json"), "{}")
          }),
        ),
      )

      const tree = yield* fs.listTree({ root: tmp, maxDepth: 3 })
      expect(tree.kind).toBe("directory")
      expect(tree.children?.length ?? 0).toBeGreaterThan(0)
      const names = tree.children?.map((c) => c.name) ?? []
      expect(names).toContain("src")
      expect(names).toContain("package.json")
      const src = tree.children?.find((c) => c.name === "src")
      expect(src?.kind).toBe("directory")
      const srcNames = src?.children?.map((c) => c.name) ?? []
      expect(srcNames).toContain("index.ts")
    }),
  )
})