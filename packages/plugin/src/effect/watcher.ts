import type { Stream } from "effect"

export interface WatcherUpdate {
  readonly path: string
  readonly type: "create" | "update" | "delete"
}

export interface WatcherDomain {
  /** Changes under a directory, using the host's native watcher and its ignore list. */
  readonly directory: (path: string) => Stream.Stream<WatcherUpdate, unknown>
}
