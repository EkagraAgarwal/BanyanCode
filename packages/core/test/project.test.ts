import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@opencode-ai/core/git"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const databaseLayer = Database.layerFromPath(":memory:")
const it = testEffect(
  Layer.mergeAll(
    ProjectV2.layer.pipe(
      Layer.provide(databaseLayer),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Git.defaultLayer),
    ),
    databaseLayer,
  ),
)

function remoteID(remote: string) {
  return ProjectV2.ID.make(Hash.fast(`git-remote:${remote}`))
}

function abs(value: string) {
  return AbsolutePath.make(value)
}

function real(value: string) {
  return Effect.promise(() => fs.realpath(value)).pipe(Effect.map((value) => AbsolutePath.make(value)))
}

// On win32, os.tmpdir() lives under the user profile, which is commonly
// itself a git repo carrying a `banyancode` cache file — fs.up would find
// that ancestor repo and resolve() would never take the non-git path. Create
// the dir at the drive root instead (mirrors the D:/terminalbench scenario;
// no git ancestors). POSIX /tmp is not under a repo, so the stock fixture
// suffices.
async function nonGitDir() {
  if (process.platform !== "win32") return tmpdir()
  const dir = path.join(
    path.parse(process.cwd()).root,
    `opencode-core-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  )
  await fs.mkdir(dir)
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

async function initRepo(dir: string, opts?: { commit?: boolean; remote?: string }) {
  await $`git init`.cwd(dir).quiet()
  await $`git config core.fsmonitor false`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  await $`git config user.email test@opencode.test`.cwd(dir).quiet()
  await $`git config user.name Test`.cwd(dir).quiet()
  if (opts?.commit) await $`git commit --allow-empty -m root`.cwd(dir).quiet()
  if (opts?.remote) await $`git remote add origin ${opts.remote}`.cwd(dir).quiet()
}

async function rootCommit(dir: string) {
  return (await $`git rev-list --max-parents=0 HEAD`.cwd(dir).text()).trim()
}

describe("Project directories schemas", () => {
  it.effect("decodes project directory input and inline directory results", () =>
    Effect.sync(() => {
      expect(Schema.decodeUnknownSync(ProjectV2.DirectoriesInput)({ projectID: ProjectV2.ID.make("project") })).toEqual(
        {
          projectID: ProjectV2.ID.make("project"),
        },
      )
      expect(
        Schema.decodeUnknownSync(ProjectV2.Directories)([
          { directory: AbsolutePath.make("/tmp/project"), type: "main" },
        ]),
      ).toEqual([{ directory: AbsolutePath.make("/tmp/project"), type: "main" }])
    }),
  )

  it.effect("lists stored project directories newest first for the requested project", () =>
    Effect.gen(function* () {
      const project = yield* ProjectV2.Service
      const { db } = yield* Database.Service
      const projectID = ProjectV2.ID.make("directories-project")
      const otherID = ProjectV2.ID.make("directories-other")
      yield* db
        .insert(ProjectTable)
        .values([
          { id: projectID, worktree: AbsolutePath.make("/repo"), sandboxes: [], time_created: 1, time_updated: 1 },
          { id: otherID, worktree: AbsolutePath.make("/other"), sandboxes: [], time_created: 1, time_updated: 1 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ProjectDirectoryTable)
        .values([
          { project_id: projectID, directory: AbsolutePath.make("/repo/z"), type: "root", time_created: 2 },
          { project_id: projectID, directory: AbsolutePath.make("/repo/a"), type: "main", time_created: 1 },
          { project_id: otherID, directory: AbsolutePath.make("/other"), type: "main", time_created: 3 },
        ])
        .run()
        .pipe(Effect.orDie)

      expect(yield* project.directories({ projectID })).toEqual([
        { directory: AbsolutePath.make("/repo/z"), type: "root" },
        { directory: AbsolutePath.make("/repo/a"), type: "main" },
      ])
    }),
  )
})

describe("ProjectV2.resolve", () => {
  it.live("returns global for non-git directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => nonGitDir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      // Regression: resolve used to return the filesystem root (drive root on
      // win32) for non-git directories, which poisoned InstanceRef.worktree
      // and made codegraph builds index the whole drive.
      expect(result.directory).toBe(abs(tmp.path))
      expect(result.directory).not.toBe(abs(path.parse(tmp.path).root))
      expect(result.previous).toBeUndefined()
      expect(result.vcs).toBeUndefined()
    }),
  )

  it.live("returns the input directory (not the drive root) for a nested non-git directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => nonGitDir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "a", "b"), { recursive: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(path.join(tmp.path, "a", "b")))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(result.directory).toBe(abs(path.join(tmp.path, "a", "b")))
      expect(result.directory).not.toBe(abs(path.parse(tmp.path).root))
    }),
  )

  it.live("returns git global for repo with no commits and no remote", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.previous).toBeUndefined()
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("falls back to root commit when origin is missing", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.previous).toBeUndefined()
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("prefers normalized origin over root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:Acme/App.git" }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(remoteID("github.com/Acme/App"))
      expect(result.id).not.toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("normalizes ssh and https remotes to the same id", () =>
    Effect.gen(function* () {
      const ssh = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const https = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(ssh.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => initRepo(https.path, { commit: true, remote: "https://github.com/owner/repo.git" }))
      const project = yield* ProjectV2.Service

      const a = yield* project.resolve(abs(ssh.path))
      const b = yield* project.resolve(abs(https.path))

      expect(a.id).toBe(remoteID("github.com/owner/repo"))
      expect(b.id).toBe(a.id)
    }),
  )

  it.live("ignores file remotes and falls back to root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: `file://${tmp.path}` }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
    }),
  )

  it.live("returns previous cached id from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.previous).toBe(ProjectV2.ID.make("old-id"))
      expect(result.id).toBe(remoteID("github.com/owner/repo"))
    }),
  )

  it.live("does not write the cache while resolving", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      const project = yield* ProjectV2.Service

      yield* project.resolve(abs(tmp.path))

      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "opencode")).exists())).toBe(false)
    }),
  )

  it.live("resolves from nested directories to repo root", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "a", "b"), { recursive: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(path.join(tmp.path, "a", "b")))

      expect(result.directory).toBe(yield* real(tmp.path))
    }),
  )

  it.live("linked worktree returns opened worktree directory and previous from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const worktree = `${tmp.path}-worktree`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${worktree}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      yield* Effect.promise(() => $`git worktree add ${worktree} -b test-${Date.now()}`.cwd(tmp.path).quiet())
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(worktree))

      expect(result.directory).toBe(yield* real(worktree))
      expect(result.previous).toBe(ProjectV2.ID.make("old-id"))
      expect(result.id).toBe(remoteID("github.com/owner/repo"))
      expect(result.vcs?.type).toBe("git")
    }),
  )
})
