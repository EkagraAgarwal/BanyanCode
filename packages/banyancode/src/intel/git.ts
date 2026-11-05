import { execFile } from "node:child_process"
import { Effect } from "effect"

/**
 * Git reads used by `repo op=query` and `repo op=ownership`. Ported
 * from v1 `repository-intelligence/git-service.ts`, but on `node:child_process`
 * so the plugin works in both the Bun and Node builds.
 *
 * Every failure degrades to an empty value: git may be absent, the workspace
 * may not be a repo, or the index may be shallow. Repository intelligence must
 * never fail because of git.
 */

export interface RecentCommit {
  readonly sha: string
  readonly subject: string
  readonly ts: number
}

export interface GitPort {
  readonly recentCommits: (input: { sinceDays?: number; limit?: number; cwd?: string }) => Effect.Effect<readonly RecentCommit[]>
  readonly owners: (input: { path: string; cwd?: string }) => Effect.Effect<{ owner?: string; count: number }>
}

const runGit = (args: readonly string[], cwd?: string): Effect.Effect<string> =>
  Effect.callback<string>((resume) => {
    execFile(
      "git",
      [...args],
      { ...(cwd ? { cwd } : {}), timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resume(Effect.succeed(error ? "" : String(stdout))),
    )
  })

export const makeGit = (defaultCwd?: string): GitPort => {
  const owners = (input: { path: string; cwd?: string }) =>
    Effect.gen(function* () {
      const cwd = input.cwd ?? defaultCwd
      const stdout = yield* runGit(["shortlog", "-s", "-n", "--all", "--", input.path], cwd)
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0)
      if (lines.length === 0) return { owner: undefined, count: 0 }
      const match = lines[0]?.match(/^\s*(\d+)\s+(.+?)\s*$/)
      if (!match) return { owner: undefined, count: 0 }
      const count = Number.parseInt(match[1] ?? "0", 10)
      const owner = (match[2] ?? "").trim()
      return { owner: owner.length > 0 ? owner : undefined, count: Number.isFinite(count) ? count : 0 }
    })

  const recentCommits = (input: { sinceDays?: number; limit?: number; cwd?: string }) =>
    Effect.gen(function* () {
      const cwd = input.cwd ?? defaultCwd
      const limit = input.limit ?? 10
      const since = input.sinceDays ?? 30
      const stdout = yield* runGit(
        ["log", "--all", "--since", `${since} days ago`, "--pretty=format:%H%x00%s%x00%at", "-n", String(limit)],
        cwd,
      )
      if (stdout.length === 0) return [] as RecentCommit[]
      return stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const parts = line.split("\x00")
          return {
            sha: parts[0] ?? "",
            subject: parts[1] ?? "",
            ts: Number.parseInt(parts[2] ?? "0", 10) * 1000,
          }
        })
    })

  return { owners, recentCommits }
}
