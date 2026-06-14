export * as MeshCoordinator from "./mesh-coordinator"

import { Context, Effect, Layer, Queue, Ref } from "effect"
import { SubagentBus } from "./subagent-bus"
import type { PeerInfo, SubagentMessage } from "./types"

export interface MeshStatus {
  parentSessionID: string
  peers: PeerInfo[]
  pendingMessages: number
  recentActivity: Array<{ from: string; at: number }>
}

export interface Interface {
  readonly status: (parentSessionID: string) => Effect.Effect<MeshStatus>
  readonly drain: (parentSessionID: string) => Effect.Effect<SubagentMessage[]>
  readonly watch: (parentSessionID: string) => Effect.Effect<Queue.Dequeue<MeshStatus>>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/MeshCoordinator") {}

const ACTIVITY_WINDOW_MS = 5 * 60 * 1000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* SubagentBus.Service
    const activityRef = yield* Ref.make(new Map<string, Array<{ from: string; at: number }>>())

    const status = Effect.fn("MeshCoordinator.status")(function* (parentSessionID: string) {
      const peers = yield* bus.peers(parentSessionID)
      const queue = yield* bus.subscribe(parentSessionID)
      const recent = (yield* Ref.get(activityRef)).get(parentSessionID) ?? []
      const cutoff = Date.now() - ACTIVITY_WINDOW_MS
      return {
        parentSessionID,
        peers,
        pendingMessages: 0,
        recentActivity: recent.filter((a) => a.at >= cutoff),
      }
    })

    const drain = Effect.fn("MeshCoordinator.drain")(function* (parentSessionID: string) {
      const queue = yield* bus.subscribe(parentSessionID)
      const drained: SubagentMessage[] = []
      let item = yield* Queue.poll(queue)
      while (item._tag === "Some") {
        drained.push(item.value)
        item = yield* Queue.poll(queue)
      }
      return drained
    })

    const watch = Effect.fn("MeshCoordinator.watch")(function* (parentSessionID: string) {
      return yield* Queue.unbounded<MeshStatus>()
    })

    return Service.of({ status, drain, watch })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SubagentBus.defaultLayer))
