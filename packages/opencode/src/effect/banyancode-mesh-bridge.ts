import { Effect, Option } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Banyan } from "@opencode-ai/core/banyancode"
import { MeshCoordinator } from "@opencode-ai/core/banyancode/mesh-coordinator"
import { RuntimeFlags } from "@/effect/runtime-flags"

const REPUBLISH_INTERVAL_MS = 2000

export const applyMeshBridge = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) return

  const meshOpt = yield* Effect.serviceOption(Banyan.meshCoordinatorLayer as never)
  yield* Effect.logDebug("mesh-bridge: layer opt", { present: Option.isSome(meshOpt) })
  const serviceOpt = yield* Effect.serviceOption(MeshCoordinator.Service as never)
  const eventsOpt = yield* Effect.serviceOption(EventV2Bridge.Service)
  if (Option.isNone(serviceOpt) || Option.isNone(eventsOpt)) return

  const mesh: any = (serviceOpt as any).value
  const events = (eventsOpt as any).value
  const StatusUpdated = MeshCoordinator.StatusUpdated

  const work = Effect.gen(function* () {
    while (true) {
      const parents: ReadonlyArray<any> = yield* mesh.listTrackedParents()
      if (parents.length === 0) {
        yield* Effect.sleep(`${REPUBLISH_INTERVAL_MS} millis`)
        continue
      }
      for (const parent of parents) {
        const next = yield* mesh.status(parent).pipe(Effect.option)
        if (Option.isSome(next)) {
          yield* events.publish(StatusUpdated, next.value).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("mesh-bridge: publish failed", { parent, cause }),
            ),
          )
        }
      }
      yield* Effect.sleep(`${REPUBLISH_INTERVAL_MS} millis`)
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("mesh-bridge: drain loop failed; stopping", { cause }),
    ),
  )

  yield* Effect.forkDetach(work)
})
