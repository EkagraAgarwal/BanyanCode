export * as BanyanFilesystem from "./filesystem"

import { Context, Effect, Layer, Ref } from "effect"
import fs from "node:fs/promises"
import path from "path"

export interface TreeNode {
  readonly path: string
  readonly name: string
  readonly kind: "file" | "directory"
  readonly children?: ReadonlyArray<TreeNode>
}

export interface ListTreeInput {
  readonly root: string
  readonly maxDepth?: number
}

export interface Interface {
  readonly listTree: (input: ListTreeInput) => Effect.Effect<TreeNode, never, never>
  readonly invalidate: (root: string) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/Filesystem") {}

const DEFAULT_IGNORE = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".banyancode",
  ".opencode",
  "target",
  "__pycache__",
  ".next",
  ".nuxt",
  ".cache",
])

const DEFAULT_MAX_DEPTH = 2
const MAX_MAX_DEPTH = 4
const CACHE_TTL_MS = 5_000

interface CacheEntry {
  tree: TreeNode
  computedAt: number
}

const computeName = (p: string): string => {
  const last = p.lastIndexOf("/")
  return last >= 0 ? p.slice(last + 1) : p
}

const listDir = (
  dirPath: string,
  depth: number,
  maxDepth: number,
  ignore: Set<string>,
): Effect.Effect<ReadonlyArray<TreeNode>> =>
  Effect.gen(function* () {
    const entries = yield* Effect.promise(() => fs.readdir(dirPath, { withFileTypes: true }))
    const children: TreeNode[] = []
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue
      const childPath = path.posix.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          const subtree = yield* listDir(childPath, depth + 1, maxDepth, ignore)
          children.push({ path: childPath, name: entry.name, kind: "directory", children: subtree })
        } else {
          children.push({ path: childPath, name: entry.name, kind: "directory" })
        }
      } else {
        children.push({ path: childPath, name: entry.name, kind: "file" })
      }
    }
    return children
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .concat()
      .slice()
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cache = yield* Ref.make<Map<string, CacheEntry>>(new Map())

    const listTree: Interface["listTree"] = (input) =>
      Effect.gen(function* () {
        const root = input.root
        const maxDepth = Math.min(input.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_MAX_DEPTH)
        const now = Date.now()
        const cached = yield* Ref.get(cache).pipe(Effect.map((m) => m.get(root)))

        if (cached && now - cached.computedAt < CACHE_TTL_MS) {
          return cached.tree
        }

        const children = yield* listDir(root, 0, maxDepth, DEFAULT_IGNORE)
        const tree: TreeNode = { path: root, name: computeName(root), kind: "directory", children }
        yield* Ref.update(cache, (m) => {
          const next = new Map(m)
          next.set(root, { tree, computedAt: now })
          return next
        })
        return tree
      })

    const invalidate: Interface["invalidate"] = (root) =>
      Ref.update(cache, (m) => {
        const next = new Map(m)
        for (const key of next.keys()) {
          if (key === root || key.startsWith(root + "/")) {
            next.delete(key)
          }
        }
        return next
      })

    return Service.of({ listTree, invalidate })
  }),
)

export const defaultLayer = layer
