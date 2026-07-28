import { Effect, Layer, Queue, Scope } from "effect"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import type { PeerInfo, SubagentMessage } from "../../src/banyancode/types"

/**
 * Build a `SubagentBus` mock layer that returns the supplied queue from both
 * `subscribe` and `subscribeAll`, treats every parent session as existing, and
 * leaves `publish` / `publishOrFetch` / `peers` as permissive defaults.
 *
 * Centralizes the casts required to satisfy the `Interface` after the
 * `SubagentSessionNotFoundError` change (E channel: `SubagentSessionNotFoundError`,
 * R channel: `Scope.Scope`).
 */
export const makeSubagentBusMockLayer = (
  queue: Queue.Dequeue<SubagentMessage>,
  opts: { readonly peers?: ReadonlyArray<PeerInfo> } = {},
) =>
  Layer.succeed(
    SubagentBus.Service,
    SubagentBus.Service.of({
      publish: () => Effect.void,
      publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
      parentSessionExists: () => Effect.succeed(true),
      subscribe: () =>
        Effect.succeed(queue) as Effect.Effect<
          Queue.Dequeue<SubagentMessage>,
          SubagentBus.SubagentSessionNotFoundError,
          Scope.Scope
        >,
      subscribeAll: () =>
        Effect.succeed(queue) as Effect.Effect<
          Queue.Dequeue<SubagentMessage>,
          never,
          Scope.Scope
        >,
      peers: () => Effect.succeed([...(opts.peers ?? [])]),
    }),
  )
