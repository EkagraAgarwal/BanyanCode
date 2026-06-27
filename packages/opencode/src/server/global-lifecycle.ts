import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { Event } from "./event"

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })))
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

export * as GlobalLifecycle from "./global-lifecycle"

import { AppRuntime } from "@/effect/app-runtime"

let shuttingDown = false
const handleShutdown = () => {
  if (shuttingDown) return
  shuttingDown = true

  AppRuntime.runPromise(
    Effect.gen(function* () {
      yield* Effect.logInfo("Graceful shutdown initiated...")
      yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
    }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(Effect.promise(() => AppRuntime.dispose()))
    )
  ).then(
    () => {
      process.exit(0)
    },
    () => {
      process.exit(1)
    }
  )
}

process.on("SIGTERM", handleShutdown)
process.on("SIGINT", handleShutdown)
