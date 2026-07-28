import { Effect, Layer, Queue } from "effect"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import type { PeerInfo, SubagentMessage } from "../../src/banyancode/types"

/**
 * Build a `SubagentBus` mock layer that returns the supplied queue from both
 * `subscribe` and `subscribeAll`, treats every parent session as existing, and
 * leaves `publish` / `publishOrFetch` / `peers` as permissive defaults.
 *
 * The Interface signatures dropped the Scope requirement for subscribe (R=never)
 * after the per-session queue lifetime moved to the caller scope, so no
 * type-casts are needed here.
 */
export const makeSubagentBusMockLayer = (
  queue: Queue.Queue<SubagentMessage>,
  opts: { readonly peers?: ReadonlyArray<PeerInfo> } = {},
) =>
  Layer.succeed(
    SubagentBus.Service,
    SubagentBus.Service.of({
      publish: () => Effect.void,
      publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
      parentSessionExists: () => Effect.succeed(true),
      subscribe: () => Effect.succeed(queue),
      subscribeAll: () => Effect.succeed(queue),
      peers: () => Effect.succeed([...(opts.peers ?? [])]),
    }),
  )
