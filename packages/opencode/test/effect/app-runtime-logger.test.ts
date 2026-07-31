import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Logger, Ref } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppLayer } from "../../src/effect/app-runtime"
import { EffectBridge } from "@/effect/bridge"
import { InstanceRef } from "../../src/effect/instance-ref"
import * as Observability from "@opencode-ai/core/observability"
import { Logging } from "@opencode-ai/core/observability/logging"
import { attach } from "../../src/effect/run-service"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

function check(loggers: ReadonlySet<Logger.Logger<unknown, any>>) {
  return {
    tracerLogger: loggers.has(Logger.tracerLogger),
    size: loggers.size,
  }
}

it.live("makeRuntime installs the observability logger", () =>
  Effect.gen(function* () {
    class Dummy extends Context.Service<Dummy, { readonly current: () => Effect.Effect<ReturnType<typeof check>> }>()(
      "@test/Dummy",
    ) {}

    const layer = Layer.effect(
      Dummy,
      Effect.gen(function* () {
        return Dummy.of({
          current: () => Effect.map(Effect.service(Logger.CurrentLoggers), check),
        })
      }),
    )

    const current = yield* Dummy.use((svc) => svc.current()).pipe(
      Effect.provide(Layer.provideMerge(layer, Observability.layer)),
    )

    expect(current.size).toBeGreaterThan(0)
  }),
)

it.live("AppLayer also installs the observability logger", () =>
  Effect.gen(function* () {
    const current = yield* Effect.map(Effect.service(Logger.CurrentLoggers), check).pipe(
      Effect.provide(AppLayer as unknown as Layer.Layer<never, never, never>),
    )

    expect(current.size).toBeGreaterThan(0)
  }),
)

// Pin the AppLayer ordering invariant: Observability MUST be the outermost
// dependency. If a future change appends a `Layer.provideMerge` AFTER it
// instead of before, BanyanCode layers get constructed without
// Logger.CurrentLoggers in context and silently fall back to
// Effect.defaultLogger (which writes to console and corrupts the TUI frame).
//
// We build a probe layer that captures the Logger.CurrentLoggers set into a
// Ref, then run two chains shaped like AppLayer. In the correct shape, the
// probe is the inner dependency (`probe.pipe(Layer.provideMerge(Observability.layer))`)
// so Observability is built first and CurrentLoggers is in the outer context.
// In the broken shape, the probe is the outer dependency
// (`Observability.layer.pipe(Layer.provideMerge(probe))`), mirroring the
// pre-fix AppLayer and confirming that any layer appended after Observability
// ends up on Effect.defaultLogger.
it.live(
  "probe layer placed after Observability sees the custom loggers, not defaultLogger",
  () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlySet<Logger.Logger<unknown, any>> | "unbuilt">(
        "unbuilt",
      )

      const probe = Layer.effectDiscard(
        Effect.gen(function* () {
          const loggers = yield* Effect.service(Logger.CurrentLoggers)
          yield* Ref.set(captured, loggers)
        }),
      )

      yield* Effect.void.pipe(Effect.provide(Layer.provideMerge(probe, Observability.layer)))

      const observed = yield* Ref.get(captured)
      if (observed === "unbuilt") {
        return yield* Effect.die(new Error("probe layer never executed"))
      }
      if (observed.has(Logger.defaultLogger)) {
        return yield* Effect.die(
          new Error(
            `probe layer constructed under Logger.defaultLogger (size=${observed.size}); Observability must be the outermost provideMerge`,
          ),
        )
      }
      if (observed.size !== Logging.loggers().length) {
        return yield* Effect.die(
          new Error(
            `probe layer saw ${observed.size} loggers but Logging.loggers() returned ${Logging.loggers().length}`,
          ),
        )
      }
    }),
)

it.live(
  "probe layer placed BEFORE Observability sees defaultLogger (documents the old bug)",
  () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make<ReadonlySet<Logger.Logger<unknown, any>> | "unbuilt">(
        "unbuilt",
      )

      const probe = Layer.effectDiscard(
        Effect.gen(function* () {
          const loggers = yield* Effect.service(Logger.CurrentLoggers)
          yield* Ref.set(captured, loggers)
        }),
      )

      // Intentionally mirrored the pre-fix AppLayer shape: Observability is the
      // inner dep, so it is built AFTER probe and CurrentLoggers is missing
      // when probe runs.
      const broken = Observability.layer.pipe(Layer.provideMerge(probe))
      yield* Effect.void.pipe(Effect.provide(broken))

      const observed = yield* Ref.get(captured)
      if (observed === "unbuilt") {
        return yield* Effect.die(new Error("probe layer never executed"))
      }
      // Pre-fix shape: CurrentLoggers either contains Logger.defaultLogger
      // or is empty (depending on whether Effect fell through to default).
      const bugReproduced = observed.size === 0 || observed.has(Logger.defaultLogger)
      if (!bugReproduced) {
        return yield* Effect.die(
          new Error(
            `expected probe under broken shape to see defaultLogger or empty set; got size=${observed.size}`,
          ),
        )
      }
    }),
)

it.instance(
  "attach preserves InstanceRef from the current fiber context",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const current = yield* attach(
        Effect.gen(function* () {
          return (yield* InstanceRef)?.directory
        }),
      )

      expect(current).toBe(test.directory)
    }),
  { git: true },
)

it.instance(
  "EffectBridge preserves logger and instance context across async boundaries",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const bridge = yield* EffectBridge.make()
      const started = yield* Deferred.make<void>()

      const fiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.promise(() =>
          Promise.resolve().then(() =>
            bridge.promise(
              Effect.gen(function* () {
                return {
                  directory: (yield* InstanceRef)?.directory,
                  ...check(yield* Effect.service(Logger.CurrentLoggers)),
                }
              }),
            ),
          ),
        )
      }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)
      const result = yield* Fiber.join(fiber)

      expect(result.directory).toBe(test.directory)
      expect(result.size).toBeGreaterThan(0)
    }).pipe(Effect.provide(Observability.layer)),
  { git: true },
)
