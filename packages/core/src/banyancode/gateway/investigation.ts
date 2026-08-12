export * as InvestigationState from "./investigation"

import { Context, Effect, Layer, Ref } from "effect"
import { AgentV2 } from "../../agent"
import { SessionSchema } from "../../session/schema"
import type { InvestigationState as InvestigationStateShape } from "./types"

// Per-(session, agent) repository investigation state (plan §2.2, spec §22 /
// §96-98). A lightweight in-memory keyed Ref: one subagent's active symbol
// investigation never distorts another's routing. `get` returns the current
// state (empty when absent); `note` merges a partial update — tracked
// entities/files/concepts are unioned, recent queries are appended.

export interface Interface {
  readonly get: (
    sessionID: SessionSchema.ID,
    agent: AgentV2.ID,
  ) => Effect.Effect<InvestigationStateShape, never, never>
  readonly note: (
    sessionID: SessionSchema.ID,
    agent: AgentV2.ID,
    update: Partial<InvestigationStateShape>,
  ) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/InvestigationState") {}

const empty = (): InvestigationStateShape => ({
  entities: new Set(),
  files: new Set(),
  concepts: new Set(),
  recentQueries: [],
})

const key = (sessionID: SessionSchema.ID, agent: AgentV2.ID) => `${sessionID}:${agent}`

const merge = (current: InvestigationStateShape, update: Partial<InvestigationStateShape>): InvestigationStateShape => ({
  entities: new Set([...current.entities, ...(update.entities ?? [])]),
  files: new Set([...current.files, ...(update.files ?? [])]),
  concepts: new Set([...current.concepts, ...(update.concepts ?? [])]),
  recentQueries: [...current.recentQueries, ...(update.recentQueries ?? [])],
})

// Derive the investigation note for a conventional repository tool call:
// read -> file; grep with an identifier-like pattern -> entity; anything else
// (phrases, regex) -> concept. Fail-open by contract: unrecognized tools or
// missing arguments produce an empty update.
export const deriveNote = (tool: string, args: Record<string, unknown>): Partial<InvestigationStateShape> => {
  if (tool === "read") {
    const filePath = typeof args.path === "string" ? args.path : undefined
    return filePath === undefined ? {} : { files: new Set([filePath]) }
  }
  if (tool === "grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : undefined
    if (pattern === undefined) return {}
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(pattern)
      ? { entities: new Set([pattern]) }
      : { concepts: new Set([pattern]) }
  }
  return {}
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const states = yield* Ref.make(new Map<string, InvestigationStateShape>())

    const get: Interface["get"] = (sessionID, agent) =>
      Ref.get(states).pipe(Effect.map((map) => map.get(key(sessionID, agent)) ?? empty()))

    const note: Interface["note"] = (sessionID, agent, update) =>
      Ref.update(states, (map) => {
        const next = new Map(map)
        next.set(key(sessionID, agent), merge(map.get(key(sessionID, agent)) ?? empty(), update))
        return next
      })

    return Service.of({ get, note })
  }),
)

export const defaultLayer = layer
