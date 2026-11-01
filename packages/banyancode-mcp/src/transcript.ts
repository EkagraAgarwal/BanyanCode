// v2 durable event persistence is OPTIONAL on this host (`Bus.configured({
// persist: true })` is only used by benchmarks and tests; the default server
// runs with `persist: false`, so `session.log` replays only the `log.synced`
// marker). This module rebuilds digest-shaped events from the session
// transcript, which is always persisted.
//
// Synthetic events use the message ordinal as their `seq`, and callers encode
// that ordinal as a NEGATIVE cursor value so it can never be confused with a
// real durable sequence.

import type { DurableEvent } from "./digest"

/** Marks digest events synthesized from the transcript (no durable log). */
export const SYNTHETIC_AGGREGATE = "transcript" as const

export type TranscriptMessage = {
  type: string
  created: number
  text?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cacheRead?: number; cacheWrite?: number }
  tools?: Array<{ name: string; input: Record<string, unknown> }>
}

export function transcriptEvents(messages: readonly TranscriptMessage[], afterOrdinal: number): DurableEvent[] {
  const out: DurableEvent[] = []
  messages.forEach((message, index) => {
    const ordinal = index + 1
    if (ordinal <= afterOrdinal) return
    if (message.type !== "assistant") return
    const durable = { aggregateID: SYNTHETIC_AGGREGATE, seq: ordinal, version: 0 }
    out.push({ type: "session.step.started", created: message.created, durable, data: {} })
    for (const tool of message.tools ?? []) {
      out.push({
        type: "session.tool.called",
        created: message.created,
        durable,
        data: { name: tool.name, input: tool.input },
      })
    }
    if (message.text !== undefined && message.text.trim() !== "") {
      out.push({ type: "session.text.ended", created: message.created, durable, data: { text: message.text } })
    }
    out.push({
      type: "session.step.ended",
      created: message.created,
      durable,
      data: {
        cost: message.cost ?? 0,
        tokens: {
          input: message.tokens?.input ?? 0,
          output: message.tokens?.output ?? 0,
          reasoning: message.tokens?.reasoning ?? 0,
          cache: { read: message.tokens?.cacheRead ?? 0, write: message.tokens?.cacheWrite ?? 0 },
        },
        files: [],
      },
    })
  })
  return out
}

export const transcriptOrdinal = (messages: readonly TranscriptMessage[]): number => messages.length

export * as Transcript from "./transcript"
