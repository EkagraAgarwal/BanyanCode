/**
 * BanyanCode memory EventV2 events.
 *
 * Published from MemoryService only — never from MemoryRepo. Events are picked
 * up by `banyancode-memory-bridge.ts` (mirroring the codegraph-bridge pattern)
 * and republished through the location-stamping EventV2Bridge so the TUI
 * `tab-memory` plugin receives them.
 */

import { Schema } from "effect"
import { EventV2 } from "../event"
import { MemoryStatusSchema } from "./memory-payload"

export const MemoryCommitted = EventV2.define({
  type: "banyancode.memory.committed",
  schema: {
    id: Schema.String,
    key: Schema.String,
    scope: Schema.Literals(["global", "session"]),
    kind: Schema.String,
    title: Schema.String,
    status: MemoryStatusSchema,
    version: Schema.Number,
  },
})

export const MemoryCandidateEmitted = EventV2.define({
  type: "banyancode.memory.candidate_emitted",
  schema: {
    id: Schema.String,
    key: Schema.String,
    scope: Schema.Literals(["global", "session"]),
    kind: Schema.String,
    title: Schema.String,
    sessionID: Schema.optional(Schema.String),
  },
})

export const MemoryPromoted = EventV2.define({
  type: "banyancode.memory.promoted",
  schema: {
    id: Schema.String,
    key: Schema.String,
    scope: Schema.Literals(["global", "session"]),
    supersededIds: Schema.Array(Schema.String),
  },
})

export const MemoryRejected = EventV2.define({
  type: "banyancode.memory.rejected",
  schema: {
    id: Schema.String,
    key: Schema.String,
  },
})
