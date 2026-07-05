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
        cached: Schema.Number,
        parseFailure: Schema.Number,
      }),
    }),
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
  readonly start: (input: { root: string; force?: boolean; dbPath?: string }) => Effect.Effect<void, never, never>
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
    const inFlight = yield* Ref.make<Fiber.Fiber<void, CodegraphIndexer.CodegraphError> | undefined>(undefined)
    const events = yield* Queue.bounded<{ type: "banyancode.codegraph.build"; properties: State }>(64).pipe(Effect.orDie)
    yield* Effect.addFinalizer(() => Queue.shutdown(events))

    const publish = (s: State) => Queue.offer(events, { type: "banyancode.codegraph.build", properties: s }).pipe(Effect.orDie)

    // The events queue is drained by the build bridge in
    // packages/opencode/src/effect/banyancode-codegraph-bridge.ts, which
    // republishes through EventV2Bridge (and therefore stamps the
    // instance/workspace location). Do not add a second consumer here — that
    // would race the bridge and the TUI would lose roughly half of the
    // progress events, leaving the progress widget stuck at 0/0.

    const start: Interface["start"] = (input) =>
      Effect.gen(function* () {
        const currentFiber = yield* Ref.get(inFlight)
        if (currentFiber) yield* Fiber.interrupt(currentFiber)

        yield* indexer.cancel()
        const initial: State = { status: "running", root: input.root, dbPath: input.dbPath, done: 0, total: 0, startedAt: Date.now() }
        yield* Ref.set(state, initial)
        yield* publish(initial)

        const work = Effect.gen(function* () {
          const startTime = Date.now()
          const result = yield* indexer.index({
            root: input.root,
            force: input.force ?? false,
            onProgress: Effect.fn("CodegraphBuildService.onProgress")(function* ({ file, done, total }) {
              const next: State = { ...initial, done, total, currentFile: file }
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
          })

          const doneState: State = {
            status: "completed",
            root: initial.root,
            dbPath: initial.dbPath,
            done: result.indexed + result.skipped,
            total: result.indexed + result.skipped,
            startedAt: initial.startedAt,
            graphVersion,
            graphCoverage: coverage,
            result: {
              indexed: result.indexed,
              skipped: result.skipped,
              duration_ms: Date.now() - startTime,
              symbolsIndexed: result.symbolsIndexed,
              skippedByReason: result.skippedByReason,
            },
          }
          yield* Ref.set(state, doneState)
          yield* publish(doneState)
        })

        const forkWork = work.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(state)
              if (current.status === "running") {
                const err = Cause.squash(cause)
                const errorMsg = err instanceof Error ? err.message : String(err)
                const next: State = { ...initial, status: "failed", error: errorMsg }
                yield* Ref.set(state, next)
                yield* publish(next)
              }
            }),
          ),
        )

        // Fork into the runtime's global scope (not the request scope). The fork
        // must outlive the originating request because the build runs for
        // minutes, but an HTTP handler completes in milliseconds. `cancel()`
        // interrupts the fiber directly, not by closing any scope.
        const fiber = yield* Effect.forkDetach(forkWork)
        yield* Ref.set(inFlight, fiber)
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
