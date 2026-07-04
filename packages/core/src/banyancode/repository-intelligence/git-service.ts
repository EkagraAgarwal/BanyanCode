import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly owners: (input: { path: string }) => Effect.Effect<{ owner?: string; count: number }, never, never>
  readonly recentCommits: (input: { sinceDays?: number; limit?: number }) => Effect.Effect<readonly { sha: string; subject: string; ts: number }[], never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/Git") {}

export { Service as Git }

const runGit = (args: readonly string[]): Effect.Effect<string, never, never> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.$`git ${args}`.quiet()
        return await proc.text()
      },
      catch: () => "",
    }).pipe(Effect.orElseSucceed(() => ""))
    return result
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const owners = (input: { path: string }): Effect.Effect<{ owner?: string; count: number }, never, never> =>
      Effect.gen(function* () {
        const stdout = yield* runGit(["shortlog", "-s", "-n", "--all", "--", input.path])
        const lines = stdout.split("\n").filter((l) => l.trim().length > 0)
        if (lines.length === 0) return { owner: undefined, count: 0 }
        const first = lines[0] ?? ""
        const match = first.match(/^\s*(\d+)\s+(.+?)\s*$/)
        if (!match) return { owner: undefined, count: 0 }
        const count = Number.parseInt(match[1] ?? "0", 10)
        const owner = (match[2] ?? "").trim()
        return { owner: owner.length > 0 ? owner : undefined, count: Number.isFinite(count) ? count : 0 }
      })

    const recentCommits = (input: { sinceDays?: number; limit?: number }): Effect.Effect<readonly { sha: string; subject: string; ts: number }[], never, never> =>
      Effect.gen(function* () {
        const limit = input.limit ?? 10
        const since = input.sinceDays ?? 30
        const stdout = yield* runGit([
          "log",
          "--all",
          "--since",
          `${since} days ago`,
          "--pretty=format:%H%x00%s%x00%at",
          "-n",
          String(limit),
        ])
        if (stdout.length === 0) return []
        const lines = stdout.split("\n").filter((l) => l.length > 0)
        return lines.map((line) => {
          const parts = line.split("\x00")
          return {
            sha: parts[0] ?? "",
            subject: parts[1] ?? "",
            ts: Number.parseInt(parts[2] ?? "0", 10) * 1000,
          }
        })
      })

    return Service.of({ owners, recentCommits })
  }),
)

export const defaultLayer = layer