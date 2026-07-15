export * as CodegraphBuildService from "./codegraph-build-service"

import { Cause, Context, Effect, Fiber, Layer, Queue, Ref, Schema } from "effect"
import { CodegraphIndexer } from "./codegraph-indexer"
import { CodegraphRepo } from "./codegraph-repo"
import { EventV2 } from "../event"

export const State = Schema.Struct({
  status: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  root: Schema.optional(Schema.String),
  dbPath: Schema.optional(Schema.String),
  done: Schema.Number,
  total: Schema.Number,
  currentFile: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  lastProgressAt: Schema.optional(Schema.Number),
  lastCompletedFile: Schema.optional(Schema.String),
  lastCompletedPath: Schema.optional(Schema.String),
  currentlyParsing: Schema.optional(Schema.String),
  graphVersion: Schema.optional(Schema.Number),
  graphCoverage: Schema.optional(Schema.Number),
  result: Schema.optional(
    Schema.Struct({
      indexed: Schema.Number,
      skipped: Schema.Number,
      duration_ms: Schema.Number,
      symbolsIndexed: Schema.Number,
      skippedByReason: Schema.Struct({
        gitignored: Schema.Number,
        banyanignored: Schema.Number,
        artifact: Schema.Number,
        tooLarge: Schema.Number,
        minified: Schema.Number,
        tooLargeParse: Schema.Number,
        cached: Schema.Number,
        readError: Schema.Number,
        parseFailure: Schema.Number,
      }),
    }),
  ),
  parseErrors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        cause: Schema.String,
        indexedAt: Schema.Number,
      }),
    ),
  ),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/CodegraphBuildState" })

export type State = typeof State.Type

export const BuildEvent = EventV2.define({
  type: "banyancode.codegraph.build",
  schema: State.fields,
})

export interface Interface {
  readonly status: () => Effect.Effect<State, never, never>
  readonly start: (input: { root: string; force?: boolean; dbPath?: string; excludePatterns?: readonly string[] }) => Effect.Effect<void, never, never>
  readonly cancel: () => Effect.Effect<void, never, never>
  readonly forceKill: () => Effect.Effect<{ ok: boolean; message: string }, never, never>
  readonly events: () => Queue.Dequeue<{ type: "banyancode.codegraph.build"; properties: State }>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBuildService") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      const state = yield* Ref.make<State>({ status: "idle", done: 0, total: 0 })
      const events = yield* Queue.bounded<{ type: "banyancode.codegraph.build"; properties: State }>(64).pipe(Effect.orDie)
      yield* Effect.addFinalizer(() => Queue.shutdown(events))
      return Service.of({
        status: () => Ref.get(state),
        start: () => Effect.void,
        cancel: () => Effect.void,
        forceKill: () => Effect.succeed({ ok: true, message: "force-kill: banyancode disabled" }),
        events: () => events,
      })
    }

    const indexer = yield* CodegraphIndexer.Service
    const repo = yield* CodegraphRepo.Service
    const state = yield* Ref.make<State>({ status: "idle", done: 0, total: 0 })
    const inFlight = yield* Ref.make<Fiber.Fiber<unknown, unknown> | undefined>(undefined)
    // Phase 2: dropping strategy so Queue.offer never suspends the producer.
    // The events queue is drained by the bridge; if it falls behind, new
    // events are dropped rather than blocking the worker. Per AGENTS.md,
    // do not raise capacity or switch to unbounded — bounded with drop is
    // the correct back-pressure shape for a progress-event stream.
    const events = yield* Queue.dropping<{ type: "banyancode.codegraph.build"; properties: State }>(64).pipe(Effect.orDie)
    yield* Effect.addFinalizer(() => Queue.shutdown(events))

    const publish = (s: State) => Queue.offer(events, { type: "banyancode.codegraph.build", properties: s }).pipe(Effect.ignore)

    // The events queue is drained by the build bridge in
    // packages/opencode/src/effect/banyancode-codegraph-bridge.ts, which
    // republishes through EventV2Bridge (and therefore stamps the
    // instance/workspace location). Do not add a second consumer here — that
    // would race the bridge and the TUI would lose roughly half of the
    // progress events, leaving the progress widget stuck at 0/0.

    const start: Interface["start"] = (input) =>
      Effect.gen(function* () {
        const currentFiber = yield* Ref.get(inFlight)
        if (currentFiber) yield* Fiber.interrupt(currentFiber).pipe(Effect.ignore)

        yield* indexer.cancel()
        const initial: State = {
          status: "running",
          root: input.root,
          dbPath: input.dbPath,
          done: 0,
          total: 0,
          startedAt: Date.now(),
          lastProgressAt: Date.now(),
        }
        yield* Ref.set(state, initial)
        yield* publish(initial)

        const startTime = Date.now()

        // Phase 2: terminal state-write lives in a sequencing fiber that
        // JOINS the worker. If the terminal state were written inside the
        // worker, the worker's final `publish` call could block on a full
        // events queue and the build would never reach a terminal state.
        const worker = Effect.gen(function* () {
          const result = yield* indexer.index({
            root: input.root,
            force: input.force ?? false,
            ...(input.excludePatterns ? { excludePatterns: input.excludePatterns } : {}),
            onProgress: Effect.fn("CodegraphBuildService.onProgress")(function* ({ file, done, total, currentFile }) {
              const basename = file.split("/").pop() ?? file.split("\\").pop() ?? file
              const next: State = {
                ...initial,
                done,
                total,
                currentFile: file,
                lastProgressAt: Date.now(),
                lastCompletedFile: basename,
                lastCompletedPath: file,
                currentlyParsing: currentFile,
              }
              yield* Ref.set(state, next)
              yield* publish(next)
            }),
          })

          // Only bump version on successful completion
          const { graphVersion, coverage } = yield* repo.bumpVersion({
            scannedFiles: result.scannedFiles,
            indexedFiles: result.indexed,
            totalFiles: result.indexed + result.skipped,
            totalNodes: result.indexed + result.skipped,
            totalEdges: 0,
            indexedRoot: input.root,
          })

          return { result, graphVersion, coverage }
        })

        // Fork into the runtime's global scope (not the request scope). The fork
        // must outlive the originating request because the build runs for
        // minutes, but an HTTP handler completes in milliseconds. `cancel()`
        // interrupts the fiber directly, not by closing any scope.
        const workerFiber = yield* Effect.forkDetach(worker)
        yield* Ref.set(inFlight, workerFiber)

        // Sequencing fiber: joins the worker and writes the terminal state.
        // Detached from the request scope (AppRuntime global scope) so it
        // outlives the originating call. Per AGENTS.md use forkDetach, not
        // forkScoped — the latter requires Scope in the fiber context which
        // we don't have here.
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const outcome = yield* Fiber.join(workerFiber).pipe(
              Effect.map((r) => ({ kind: "completed" as const, ...r })),
              Effect.catchCause((cause) => {
                const err = Cause.squash(cause)
                const errorMsg = err instanceof Error ? err.message : String(err)
                return Effect.succeed({ kind: "failed" as const, error: errorMsg } as const)
              }),
            )

            // Don't overwrite a state set by cancel/forceKill, and don't
            // overwrite a state set by a NEWER start. If inFlight no longer
            // points at our workerFiber, a newer start has taken over.
            const liveFiber = yield* Ref.get(inFlight)
            if (liveFiber !== workerFiber) return
            const current = yield* Ref.get(state)
            if (current.status !== "running") return

            // Read state from Ref to preserve lastCompletedFile / currentlyParsing /
            // lastProgressAt set by the last onProgress callback. Spreading
            // `current` first means those fields survive into the terminal state.
            const terminal: State = outcome.kind === "completed"
              ? {
                  ...current,
                  status: "completed",
                  done: outcome.result.indexed + outcome.result.skipped,
                  total: outcome.result.indexed + outcome.result.skipped,
                  graphVersion: outcome.graphVersion,
                  graphCoverage: outcome.coverage,
                  result: {
                    indexed: outcome.result.indexed,
                    skipped: outcome.result.skipped,
                    duration_ms: Date.now() - startTime,
                    symbolsIndexed: outcome.result.symbolsIndexed,
                    skippedByReason: outcome.result.skippedByReason,
                  },
                  parseErrors: outcome.result.parseErrors,
                }
              : {
                  ...current,
                  status: "failed",
                  lastProgressAt: Date.now(),
                  error: outcome.error,
                }

            yield* Ref.set(state, terminal)
            yield* publish(terminal)
          }),
        )
      }) as unknown as Effect.Effect<void, never, never>

    const cancel: Interface["cancel"] = () =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(inFlight)
        if (fiber) {
          yield* Fiber.interrupt(fiber).pipe(
            Effect.timeout("2 seconds"),
            Effect.ignore,
          )
          yield* Ref.set(inFlight, undefined)
          const current = yield* Ref.get(state)
          if (current.status === "running") {
            const next: State = { ...current, status: "cancelled" }
            yield* Ref.set(state, next)
            yield* publish(next)
          }
        }
        yield* indexer.cancel()
      })

    const forceKill: Interface["forceKill"] = () =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(inFlight)
        // First try a normal cancel via Fiber.interrupt — works most of the time.
        if (fiber) {
          yield* Fiber.interrupt(fiber).pipe(
            Effect.timeout("2 seconds"),
            Effect.ignore,
          )
          yield* Ref.set(inFlight, undefined)
        }
        yield* indexer.cancel()
        const current = yield* Ref.get(state)
        if (current.status === "running") {
          const next: State = { ...current, status: "cancelled", error: "force-killed" }
          yield* Ref.set(state, next)
          yield* publish(next)
        }

        // If the indexer fiber was wedged in a CPU-bound loop without yield
        // points, the normal cancel couldn't unstick it. Last-resort escape
        // hatch on Windows: spawn an elevated `taskkill /F` against the
        // opencode server PID. Kills the whole bun process — user will have
        // to restart. UAC prompt is shown.
        if (process.platform !== "win32") {
          return { ok: true, message: "force-kill: not on Windows, interrupt alone is enough" }
        }
        if (process.pid <= 0) {
          return { ok: false, message: "force-kill: invalid process.pid" }
        }
        const psScript =
          `$ErrorActionPreference='Stop'; ` +
          `try { ` +
          `  Start-Process -FilePath 'taskkill.exe' -ArgumentList '/F','/PID','${process.pid}','/T' -Verb RunAs -WindowStyle Hidden -Wait -PassThru | Out-Null; ` +
          `  exit 0 ` +
          `} catch { ` +
          `  Write-Host "FORCE_KILL_FAILED: $($_.Exception.Message)"; exit 1 ` +
          `}`
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<{ ok: boolean; message: string }>((resolve) => {
              const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", psScript], {
                stdout: "pipe",
                stderr: "pipe",
              })
              child.exited.then((code) => {
                if (code === 0) resolve({ ok: true, message: "taskkill /F dispatched (UAC prompt shown)" })
                else resolve({ ok: false, message: "taskkill /F failed (user denied UAC or taskkill not available)" })
              })
            }),
          catch: (err) => ({ ok: false, message: `force-kill spawn failed: ${err instanceof Error ? err.message : String(err)}` }),
        }).pipe(
          Effect.catchCause(() =>
            Effect.succeed({ ok: false, message: "force-kill: unexpected error in spawn path" } as const),
          ),
        )
      })

    const status: Interface["status"] = () => Ref.get(state)
    const eventsDequeue: Interface["events"] = () => events

    return Service.of({ status, start, cancel, forceKill, events: eventsDequeue })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CodegraphIndexer.defaultLayer), Layer.provide(CodegraphRepo.defaultLayer))
