import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { addActiveSnapshot } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Schema.Struct({
  // Optional because legacy/imported `summary_diffs` on disk may omit
  // file details and patch text. Required Schema rejected the whole
  // session response and broke session loading on Desktop.
  file: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "SnapshotFileDiff" })
export type FileDiff = typeof FileDiff.Type

const prune = "7.days"
const limit = 2 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

// Cooldown applied after a failed `git add` per gitdir. Settlements (step
// start/finish, tool settlement) call add() back-to-back; when a file keeps
// being rewritten mid-hash (e.g. `.ccsm/*` churn) every attempt fails, so
// without this the whole worktree gets re-hashed on every settlement.
// A failed add arms a ADD_FAIL_INTERVAL_MS window during which the heavy
// diff/ls-files + stage work is skipped; the next cycle retries.
const ADD_FAIL_INTERVAL_MS = 1000

// Retained for `Snapshot.__test` compat (its range is pinned by
// test/snapshot/throttle.test.ts). The success throttle itself was removed:
// time-throttling staging made track() return stale write-tree hashes for
// edits made inside the window, so every call now stages fresh and only the
// failure cooldown below still skips work.
const ADD_SUCCESS_INTERVAL_MS = 3000

// Rate-limit window for the unstable-source warning per gitdir. The failure
// itself is a per-cycle skip (the next cycle retries), so only surface it at
// most once per window instead of spamming on every settlement.
const WARN_INTERVAL_MS = 30_000

// Whether `lastRun` is recent enough that another run should be skipped.
// `undefined` (never run) is never throttled. Pure so it can be unit-tested.
const shouldThrottle = (lastRun: number | undefined, now: number, minIntervalMs: number) =>
  lastRun !== undefined && now - lastRun < minIntervalMs

// Cap for the advisory dirty-hint set per gitdir. Past this the set is
// dropped and the next add() falls back to the full discovery scan —
// hints only ever narrow staging, so dropping them is always safe.
const DIRTY_HINT_CAP = 5000

// Git pathspec hygiene: every candidate that reaches git (or path.join) must
// be a worktree-relative forward-slash path. Absolute paths, drive-letter
// paths (`C:/...`, `C:\...`, `D:...`), UNC roots, and `..` escapes are
// rejected so a malformed git row can never materialize as a `D/` or `C./`
// directory inside the worktree. Pure so it can be unit-tested.
const isSafePathspec = (candidate: string): boolean => {
  if (!candidate || candidate.includes("\0")) return false
  const normalized = candidate.replaceAll("\\", "/")
  if (normalized.startsWith("/") || normalized.startsWith("//")) return false
  if (/^[A-Za-z]:(\/|$)/.test(normalized) || /^[A-Za-z]:/.test(candidate)) return false
  if (path.isAbsolute(candidate)) return false
  if (normalized.split("/").includes("..")) return false
  return true
}

const toWorktreePathspec = (candidate: string): string => {
  const normalized = candidate.replaceAll("\\", "/")
  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

// BanyanCode's local DB/WAL lives under `.banyancode/` and churns during
// indexing — never stage those into the snapshot gitdir.
const isBanyancodePath = (candidate: string): boolean => {
  const normalized = candidate.replaceAll("\\", "/")
  return (
    normalized === ".banyancode" ||
    normalized.startsWith(".banyancode/") ||
    normalized.includes("/.banyancode/")
  )
}

// Normalize one dirty-hint path to a worktree-relative forward-slash
// pathspec, or undefined when it is unsafe, outside the worktree, or under
// BanyanCode's data dir (never staged). Accepts absolute or already-relative
// paths. Pure so it can be unit-tested.
const toDirtyHint = (worktree: string, file: string): string | undefined => {
  if (!file || file.includes("\0")) return
  const rel = path.isAbsolute(file) ? path.relative(worktree, file).replaceAll("\\", "/") : file
  const spec = toWorktreePathspec(rel)
  if (!isSafePathspec(spec)) return
  if (isBanyancodePath(spec)) return
  return spec
}

// Conservative detection of the "file changed while git was hashing" failure
// (`git add` exits 128 with "fatal: confused by unstable object source data"
// or an index-pack variant). Deliberately narrow: unrelated git errors still
// log through the normal warning path. Pure so it can be unit-tested.
const isUnstableSourceError = (stderr: string) =>
  /unstable object source data|index-pack failed|index-pack died/.test(stderr)

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
  // Advisory dirty set for the hint-driven add() fast path. Currently no
  // producer feeds it (the file watcher exposes no dirty set), so production
  // always falls back to the full discovery scan.
  readonly noteDirty: (files: readonly string[]) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

// Brackets a snapshot operation so InstanceStore's idle sweep never evicts
// the instance mid-run. Masked acquire + guaranteed release, so interruption
// can never leak the refcount.
const bracketSnapshot = <A, E, R>(fx: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const directory = yield* InstanceState.directory
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.acquireUseRelease(
        Effect.sync(() => addActiveSnapshot(directory, 1)),
        () => restore(fx),
        () => Effect.sync(() => addActiveSnapshot(directory, -1)),
      ),
    )
  })

export const layer: Layer.Layer<Service, never, FSUtil.Service | AppProcess.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()
    // Per-gitdir last-run timestamps: `addFailThrottle` arms the failure
    // cooldown for the heavy diff + stage work, `warnThrottle` rate-limits
    // the unstable-source warning. Keyed by gitdir (layer scope, shared
    // across instances like `locks`).
    const addFailThrottle = new Map<string, number>()
    const warnThrottle = new Map<string, number>()
    // Last successful write-tree hash per gitdir. Only a fallback for when
    // write-tree itself fails (typically mid-churn): track() must still
    // return a usable tree rather than an empty snapshot. Fresh hashes are
    // always preferred — this is never consulted on the success path.
    const lastTree = new Map<string, string>()
    // Advisory dirty-hint set per gitdir, fed by noteDirty(). Absent or
    // empty means "no information" — add() falls back to the full scan.
    const dirtyHints = new Map<string, Set<string>>()
    // Gitdirs where core.untrackedCache was ensured (pre-existing gitdirs
    // predate the init-time config below). Once per gitdir per process.
    const configEnsured = new Set<string>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        // All git invocations run with cwd=state.worktree (the canonical
        // root) and worktree-relative pathspecs. The session directory may be
        // a subdir of the worktree; scope directory-scoped listings to it via
        // an explicit pathspec so a child session rooted at a temp worktree
        // (directory == worktree) snapshots only that worktree. A directory
        // outside the worktree falls back to "." (whole worktree) rather than
        // a `..` escape.
        const scopePrefix = path.relative(state.worktree, state.directory).replaceAll("\\", "/")
        const scope =
          scopePrefix === "" || scopePrefix.startsWith("..") || path.isAbsolute(scopePrefix) ? "." : scopePrefix

        const sanitize = (list: string[]) =>
          Array.from(new Set(list.map(toWorktreePathspec).filter(isSafePathspec)))

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const feed = (list: string[]) => list.join("\0") + "\0"

        const git = Effect.fnUntraced(
          function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              { stdin: opts?.stdin },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.worktree,
              stdin: feed(files),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(check.text.split("\0").filter(Boolean))
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.worktree,
              stdin: feed(files),
            },
          )
        })

        // Runs `git add --all --sparse` for the given candidate paths.
        // Returns true when the index was staged (or there was nothing to
        // stage), false when git failed. Unstable-source failures (a file
        // rewritten mid-hash, e.g. a constantly churning scratch dir) skip the
        // cycle silently — the next cycle retries — and their warning is
        // rate-limited to once per WARN_INTERVAL_MS per gitdir. All other
        // failures keep logging on every occurrence.
        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return true
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.worktree,
              stdin: feed(files),
            },
          )
          if (result.code === 0) return true

          if (isUnstableSourceError(result.stderr)) {
            const now = Date.now()
            const lastWarn = warnThrottle.get(state.gitdir)
            if (!shouldThrottle(lastWarn, now, WARN_INTERVAL_MS)) {
              warnThrottle.set(state.gitdir, now)
              yield* Effect.logWarning("failed to add snapshot files", {
                exitCode: result.code,
                stderr: result.stderr,
              })
            }
            return false
          }

          yield* Effect.logWarning("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
          return false
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          // The snapshot gitdir is a plain directory (never a gitfile), so
          // its exclude file is always <gitdir>/info/exclude — the same path
          // sync() writes to below. No rev-parse spawn needed.
          const file = path.join(state.gitdir, "info", "exclude")
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            // Always ignore BanyanCode's local data dir — DB/WAL churn must
            // not enter the snapshot index.
            ".banyancode/",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Best-effort: a missing/incompatible index just falls back to a full add.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs.copyFile(sourceIndex, path.join(state.gitdir, "index")).pipe(Effect.catch(() => Effect.void))
          }
        })

        // Stage exactly the given candidates: resolve ignores, drop
        // newly-ignored paths from the index, skip oversized untracked files,
        // stage the rest. Shared by the full discovery scan and the
        // dirty-hint fast path so both stage identical subsets per input.
        const stageCandidates = Effect.fnUntraced(function* (all: string[], untracked: Set<string>) {
          if (!all.length) return true
          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return true

          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.worktree, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set([...untracked].filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          return yield* stage(allow.filter((item) => !block.has(item)))
        })

        // Hint-driven fast path: stage exactly the dirty set instead of
        // re-scanning the whole worktree with diff-files + ls-files. The
        // untracked subset still needs one scoped `ls-files --others` over the
        // hints so oversized untracked files are excluded exactly like the
        // full path. Hints outside the session scope are dropped to match the
        // scoped discovery scan.
        const stageHinted = Effect.fnUntraced(function* (hints: ReadonlySet<string>) {
          const scoped = sanitize([...hints]).filter(
            (item) => !isBanyancodePath(item) && (scope === "." || item === scope || item.startsWith(`${scope}/`)),
          )
          if (!scoped.length) return true
          const other = yield* git(
            [...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", ...scoped])],
            {
              cwd: state.worktree,
            },
          )
          if (other.code !== 0) return false
          return yield* stageCandidates(scoped, new Set(sanitize(other.text.split("\0").filter(Boolean))))
        })

        // Advisory dirty set for the hint-driven fast path. Paths may be
        // absolute or worktree-relative; anything unsafe, outside the
        // worktree, or under .banyancode/ is dropped — hints only ever narrow
        // staging, they can never stage a file the full scan would reject.
        const noteDirty = Effect.fnUntraced(function* (files: readonly string[]) {
          if (!files.length) return
          const seen = dirtyHints.get(state.gitdir) ?? new Set<string>()
          for (const file of files) {
            const hint = toDirtyHint(state.worktree, file)
            if (!hint) continue
            seen.add(hint)
          }
          if (seen.size > DIRTY_HINT_CAP) {
            dirtyHints.delete(state.gitdir)
            return
          }
          if (seen.size > 0) dirtyHints.set(state.gitdir, seen)
        })

        // Stages the worktree into the snapshot index. Always runs the full
        // pipeline so callers observe every edit: track() snapshots current
        // state, and patch()/diff() answer "what changed since hash". Only
        // the failure throttle still skips work (git is erroring; the next
        // cycle retries).
        const add = Effect.fnUntraced(function* () {
          yield* sync()

          // Per-gitdir cooldown: after a failed add (typically a file
          // rewritten mid-hash) skip the diff/ls-files + stage work for
          // ADD_FAIL_INTERVAL_MS so settlements stop hammering `git add
          // --all --sparse` on a worktree git can't hash. sync() above
          // always runs so excludes stay fresh. A skipped call assumes the
          // index is usable; the caller hashes/diffs against the last staged
          // state and the next cycle retries.
          const now = Date.now()
          const lastFailed = addFailThrottle.get(state.gitdir)
          if (shouldThrottle(lastFailed, now, ADD_FAIL_INTERVAL_MS)) return

          // Dirty-hint fast path (watcher-driven where reachable). No hints —
          // the common case until a producer is wired — falls back to the
          // full discovery scan below.
          const hints = dirtyHints.get(state.gitdir)
          if (hints && hints.size > 0) {
            const staged = yield* stageHinted(hints)
            if (!staged) {
              addFailThrottle.set(state.gitdir, Date.now())
              return
            }
            hints.clear()
            return
          }

          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", scope])], {
                cwd: state.worktree,
              }),
              git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", scope])], {
                cwd: state.worktree,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            addFailThrottle.set(state.gitdir, Date.now())
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return
          }

          const tracked = sanitize(diff.text.split("\0").filter(Boolean))
          const untracked = sanitize(other.text.split("\0").filter(Boolean))
          const all = Array.from(new Set([...tracked, ...untracked])).filter((item) => !isBanyancodePath(item))

          const staged = yield* stageCandidates(all, new Set(untracked))
          if (!staged) {
            addFailThrottle.set(state.gitdir, Date.now())
          }
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.worktree })
              if (result.code !== 0) {
                yield* Effect.logWarning("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              yield* Effect.logInfo("cleanup", { prune })
            }),
          )
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                // Snapshot-specific git config, written directly instead of
                // one `git config` spawn per key (eight spawns per fresh
                // gitdir). Duplicate sections merge per gitconfig rules, so
                // appending is equivalent to the individual config calls.
                // fsmonitor stays off: git/index.ts disables it repo-wide and
                // a daemon must not watch this alternate object store.
                // feature.manyFiles + index.v4 + index.threads +
                // untrackedCache keep the first add bounded on very large
                // worktrees.
                const config = path.join(state.gitdir, "config")
                const current = yield* read(config)
                yield* fs
                  .writeFileString(
                    config,
                    `${current.trimEnd()}\n[core]\n\tautocrlf = false\n\tlongpaths = true\n\tsymlinks = true\n\tfsmonitor = false\n\tuntrackedCache = true\n[feature]\n\tmanyFiles = true\n[index]\n\tversion = 4\n\tthreads = true\n`,
                  )
                  .pipe(Effect.orDie)
                yield* seed()
                yield* Effect.logInfo("initialized")
              }
              // Pre-existing snapshot gitdirs (created before untrackedCache
              // was set at init) get it here, once per gitdir per process.
              // Fresh gitdirs already carry it from the batched init config
              // above. fsmonitor stays off: git/index.ts disables it
              // repo-wide and a daemon must not watch this alternate object
              // store.
              if (!configEnsured.has(state.gitdir)) {
                configEnsured.add(state.gitdir)
                if (existed)
                  yield* git(["--git-dir", state.gitdir, "config", "core.untrackedCache", "true"]).pipe(Effect.ignore)
              }
              // Stage fresh; on a failure-throttle skip the index may be
              // untouched — hashing it anyway matches the pre-throttle
              // behavior and still yields a usable tree while the next cycle
              // retries staging.
              yield* add()
              let result = yield* git(args(["write-tree"]), { cwd: state.worktree })
              if (!result.text.trim()) {
                // A transient spawn failure under load can yield an empty
                // result; one bounded retry before falling back.
                result = yield* git(args(["write-tree"]), { cwd: state.worktree })
              }
              const hash = result.text.trim()
              if (hash) {
                lastTree.set(state.gitdir, hash)
                yield* Effect.logInfo("tracking", { hash, cwd: state.worktree, git: state.gitdir })
                return hash
              }
              // write-tree failed (file rewritten mid-hash under churn, or a
              // broken index after a failed add): fall back to the last known
              // tree rather than recording an empty snapshot.
              const previous = lastTree.get(state.gitdir)
              if (previous) return previous
              yield* Effect.logInfo("tracking", { hash, cwd: state.worktree, git: state.gitdir })
              return hash
            }),
          )
        })

        const patch = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              // Stage fresh: patch answers "what changed since hash" and must
              // see every edit, including ones made moments ago.
              yield* add()
              const result = yield* git(
                [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", scope])],
                {
                  cwd: state.worktree,
                },
              )
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = sanitize(
                result.text
                  .trim()
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean),
              )

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* Effect.logInfo("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              yield* Effect.logError("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  const rel = toWorktreePathspec(path.relative(state.worktree, file).replaceAll("\\", "/"))
                  if (!isSafePathspec(rel)) continue
                  ops.push({ hash: item.hash, file, rel })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.rel)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              // Stage fresh: same staleness reason as patch().
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", scope])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            Effect.gen(function* () {
              type Row = {
                file: string
                status: "added" | "deleted" | "modified"
                binary: boolean
                additions: number
                deletions: number
              }

              type Ref = {
                file: string
                side: "before" | "after"
                ref: string
              }

              const show = Effect.fnUntraced(function* (row: Row) {
                if (row.binary) return ["", ""]
                if (row.status === "added") {
                  return [
                    "",
                    yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ]
                }
                if (row.status === "deleted") {
                  return [
                    yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                      Effect.map((item) => item.text),
                    ),
                    "",
                  ]
                }
                return yield* Effect.all(
                  [
                    git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ],
                  { concurrency: 2 },
                )
              })

              const load = Effect.fnUntraced(
                function* (rows: Row[]) {
                  const refs = rows.flatMap((row) => {
                    if (row.binary) return []
                    if (row.status === "added")
                      return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                    if (row.status === "deleted") {
                      return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                    }
                    return [
                      { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                      { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                    ]
                  })
                  if (!refs.length) return new Map<string, { before: string; after: string }>()

                  const batch = yield* appProcess.run(
                    ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                      cwd: state.worktree,
                      extendEnv: true,
                    }),
                    { stdin: refs.map((item) => item.ref).join("\n") + "\n" },
                  )
                  if (batch.exitCode !== 0) {
                    yield* Effect.logInfo(
                      "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
                      {
                        stderr: batch.stderr.toString("utf8"),
                        refs: refs.length,
                      },
                    )
                    return
                  }
                  const out = batch.stdout

                  const fail = (msg: string, extra?: Record<string, string>) => {
                    return undefined
                  }

                  const map = new Map<string, { before: string; after: string }>()
                  const dec = new TextDecoder()
                  let i = 0
                  for (const ref of refs) {
                    let end = i
                    while (end < out.length && out[end] !== 10) end += 1
                    if (end >= out.length) {
                      return fail(
                        "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                      )
                    }

                    const head = dec.decode(out.slice(i, end))
                    i = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }

                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      return fail(
                        "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const size = Number(match[1])
                    if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                      return fail(
                        "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const text = dec.decode(out.slice(i, i + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    i += size + 1
                  }

                  if (i !== out.length) {
                    return fail(
                      "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                    )
                  }

                  return map
                },
                Effect.scoped,
                Effect.catch(() =>
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const result: FileDiff[] = []
              const status = new Map<string, "added" | "deleted" | "modified">()

              const statuses = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", scope])],
                { cwd: state.worktree },
              )

              for (const line of statuses.text.trim().split("\n")) {
                if (!line) continue
                const [code, file] = line.split("\t")
                if (!code || !file) continue
                const spec = toWorktreePathspec(file)
                if (!isSafePathspec(spec)) continue
                status.set(spec, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
              }

              const numstat = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", scope])],
                {
                  cwd: state.worktree,
                },
              )

              const rows = numstat.text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, file] = line.split("\t")
                  if (!file) return []
                  const spec = toWorktreePathspec(file)
                  if (!isSafePathspec(spec)) return []
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  return [
                    {
                      file: spec,
                      status: status.get(spec) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies Row,
                  ]
                })

              // Hide ignored-file removals from the user-facing diff output.
              const ignored = yield* ignore(rows.map((r) => r.file))
              if (ignored.size > 0) {
                const filtered = rows.filter((r) => !ignored.has(r.file))
                rows.length = 0
                rows.push(...filtered)
              }

              const step = 100
              const patch = (file: string, before: string, after: string) =>
                formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                const text = yield* load(run)

                for (const row of run) {
                  const hit = text?.get(row.file) ?? { before: "", after: "" }
                  const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
                  result.push({
                    file: row.file,
                    patch: row.binary ? "" : patch(row.file, before, after),
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              return result
            }),
          )
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, patch, restore, revert, diff, diffFull, noteDirty }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* bracketSnapshot(InstanceState.useEffect(state, (s) => s.track()))
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
        return yield* bracketSnapshot(InstanceState.useEffect(state, (s) => s.patch(hash)))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* bracketSnapshot(InstanceState.useEffect(state, (s) => s.restore(snapshot)))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* bracketSnapshot(InstanceState.useEffect(state, (s) => s.revert(patches)))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* bracketSnapshot(InstanceState.useEffect(state, (s) => s.diff(hash)))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* bracketSnapshot(InstanceState.useEffect(state, (s) => s.diffFull(from, to)))
      }),
      noteDirty: Effect.fn("Snapshot.noteDirty")(function* (files: readonly string[]) {
        // No bracketSnapshot: a synchronous layer-scoped map write, no git
        // spawn, so an idle-sweep eviction mid-call is harmless.
        return yield* InstanceState.useEffect(state, (s) => s.noteDirty(files))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export const node = LayerNode.make(layer, [FSUtil.node, AppProcess.node, Config.node])

// Test-only surface for the pure throttle/detection/pathspec helpers.
export const __test = {
  shouldThrottle,
  isUnstableSourceError,
  isSafePathspec,
  toWorktreePathspec,
  isBanyancodePath,
  toDirtyHint,
  ADD_SUCCESS_INTERVAL_MS,
  ADD_FAIL_INTERVAL_MS,
}

export * as Snapshot from "."
