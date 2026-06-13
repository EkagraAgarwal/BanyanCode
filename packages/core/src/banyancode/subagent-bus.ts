export * as SubagentBus from "./subagent-bus"

import { Context, Effect, Layer, Queue } from "effect"
import { SubagentMessagesRepo } from "./subagent-messages-repo"
import type { PeerInfo, SubagentMessage } from "./types"

export interface Interface {
  readonly publish: (msg: SubagentMessage) => Effect.Effect<void>
  readonly subscribe: (sessionID: string) => Effect.Effect<Queue.Dequeue<SubagentMessage>>
  readonly peers: (parentSessionID: string) => Effect.Effect<PeerInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SubagentBus") {}

const PEER_WINDOW_MS = 5 * 60 * 1000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* SubagentMessagesRepo.Service

    const publish = Effect.fn("SubagentBus.publish")(function* (msg: SubagentMessage) {
      yield* repo.put(msg)
    })

    const subscribe = Effect.fn("SubagentBus.subscribe")(function* (sessionID: string) {
      const pending = yield* repo.listByParent(sessionID, false)
      const queue = yield* Queue.unbounded<SubagentMessage>()
      for (const msg of pending) {
        yield* Queue.offer(queue, msg)
      }
      return queue
    })

    const peers = Effect.fn("SubagentBus.peers")(function* (parentSessionID: string) {
      const cutoff = Date.now() - PEER_WINDOW_MS
      const messages = yield* repo.listByParent(parentSessionID, true)
      const recent = messages.filter((m) => m.createdAt >= cutoff)
      const seen = new Map<string, PeerInfo>()
      for (const msg of recent) {
        if (!msg.fromSession) continue
        const existing = seen.get(msg.fromSession)
        if (!existing || msg.createdAt > existing.lastSeenAt) {
          seen.set(msg.fromSession, {
            sessionID: msg.fromSession,
            agent: msg.fromAgent,
            status: "active",
            lastSeenAt: msg.createdAt,
          })
        }
      }
      return Array.from(seen.values())
    })

    return Service.of({ publish, subscribe, peers })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SubagentMessagesRepo.defaultLayer))
