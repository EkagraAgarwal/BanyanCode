export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".opencode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".opencode"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export const banyanFiles = Effect.fn("ConfigPaths.banyanProjectFiles")(function* (
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: ["banyancode.jsonc", "banyancode.json"],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const banyanDirectories = Effect.fn("ConfigPaths.banyanDirectories")(function* (
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.banyan.config,
    ...(!Flag.BANYANCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".banyancode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".banyancode"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.BANYANCODE_CONFIG_DIR ? [Flag.BANYANCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
