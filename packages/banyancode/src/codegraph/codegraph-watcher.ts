export * as CodegraphWatcher from "./codegraph-watcher"

import { readdir, stat } from "node:fs/promises"
import { Effect, Scope, Stream } from "effect"
import path from "node:path"
import type { FileChange } from "./codegraph-auto-update.js"

/**
 * Project-tree watcher for the incremental graph update.
 *
 * The host's `filesystem.changed` event fires only for files it watches
 * explicitly, not for ordinary edits, so the code graph subscribes to the
 * project tree itself. The host's watcher skips dependency folders natively:
 * a plain recursive `fs.watch` took one inotify watch per directory on Linux,
 * node_modules included, and on Windows held a handle that stopped the project
 * folder being renamed or deleted.
 *
 * If the host can't watch, the graph keeps working: the host event subscription
 * and the periodic reconciliation still feed it.
 */
export interface Update {
  readonly path: string
  readonly type: "create" | "update" | "delete"
}

export interface Deps {
  readonly root: string
  readonly updates: Stream.Stream<Update, unknown>
  /** Feed one project-tree change into auto-update. */
  readonly onChange: (change: FileChange) => Effect.Effect<void>
}

// Names the host's ignore list doesn't cover, but which are never project edits.
const SKIPPED_SEGMENTS = [".banyancode", ".opencode", "dist", "build", "target", "out", "coverage", "vendor", ".venv", "venv"]

const skipped = (absolute: string, root: string): boolean => {
  const relative = path.relative(root, absolute)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) return true
  return relative.split(path.sep).some((segment) => SKIPPED_SEGMENTS.includes(segment))
}

const EVENT = { create: "add", update: "change", delete: "unlink" } as const

// A folder moved into place reports only the folder itself, so the files in it have to be found here.
const NEVER_WALKED = new Set([...SKIPPED_SEGMENTS, ".git", "node_modules"])
const walk = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !NEVER_WALKED.has(entry.name))
      .map((entry) => walk(path.join(directory, entry.name))),
  )
  return [...entries.filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name)), ...nested.flat()]
}
const filesUnder = (update: Update) =>
  Effect.promise(async () => {
    if (update.type === "delete") return [update.path]
    const info = await stat(update.path).catch(() => undefined)
    return info?.isDirectory() ? walk(update.path) : [update.path]
  })

export const make = (deps: Deps): Effect.Effect<void, never, Scope.Scope> => {
  const root = path.resolve(deps.root)
  return deps.updates.pipe(
    Stream.filter((update) => !skipped(update.path, root)),
    Stream.runForEach((update) =>
      filesUnder(update).pipe(
        Effect.flatMap((files) =>
          Effect.forEach(files, (file) => deps.onChange({ file, event: EVENT[update.type] }), { discard: true }),
        ),
      ),
    ),
    Effect.catchCause((cause) => Effect.logWarning("codegraph auto-update: file watch stopped", { cause })),
    Effect.forkScoped,
    Effect.asVoid,
  )
}
