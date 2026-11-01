// Map the v2 event stream onto the engine's small event vocabulary. The
// engine never sees the raw event union, which keeps the fake event source in
// the tests trivial and the mapping testable against recorded fixtures.

export type EngineEvent =
  | { type: "session.status"; sessionID: string; status: "idle" | "busy" | "retry" }
  | { type: "session.idle"; sessionID: string }
  | {
      type: "permission.asked"
      sessionID: string
      ask: { id: string; action: string; resources: string[]; title: string; message?: string }
    }
  | { type: "permission.replied"; sessionID: string; requestID: string }
  | { type: "form.created"; sessionID: string; form: { id: string; title: string; kind?: string } }
  | { type: "form.closed"; sessionID: string; formID: string }
  /** A digest-relevant durable session event, passed through for folding. */
  | { type: "durable"; sessionID: string; event: { type: string; created?: number; durable?: { seq?: number }; data?: unknown } }

export type RawEvent = { type: string; created?: number; durable?: { seq?: number }; data?: unknown }

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export function describeAsk(action: string, resources: readonly string[]): string {
  const tail = resources.join(" ")
  return clip(tail === "" ? action : `${action} ${tail}`, 200)
}

// Durable events that feed the checkup digest. Anything else on the stream
// (delta/streamed frames, project/config churn) is dropped at the edge.
const DIGEST_EVENT_TYPES = new Set([
  "session.step.started",
  "session.step.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.text.ended",
  "session.retry.scheduled",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.usage.recorded",
])

export function mapEvent(raw: RawEvent): EngineEvent | undefined {
  const data = asRecord(raw.data)
  if (DIGEST_EVENT_TYPES.has(raw.type)) {
    const sessionID = asString(data["sessionID"])
    if (sessionID === undefined) return undefined
    return {
      type: "durable",
      sessionID,
      event: {
        type: raw.type,
        ...(raw.created !== undefined ? { created: raw.created } : {}),
        ...(raw.durable !== undefined ? { durable: raw.durable } : {}),
        ...(raw.data !== undefined ? { data: raw.data } : {}),
      },
    }
  }
  switch (raw.type) {
    case "session.status": {
      const sessionID = asString(data["sessionID"])
      const status = asRecord(data["status"])["type"]
      if (sessionID === undefined) return undefined
      if (status !== "idle" && status !== "busy" && status !== "retry") return undefined
      return { type: "session.status", sessionID, status }
    }
    case "session.idle": {
      const sessionID = asString(data["sessionID"])
      return sessionID === undefined ? undefined : { type: "session.idle", sessionID }
    }
    case "permission.asked": {
      const sessionID = asString(data["sessionID"])
      const id = asString(data["id"])
      const action = asString(data["action"])
      if (sessionID === undefined || id === undefined || action === undefined) return undefined
      const resources = Array.isArray(data["resources"])
        ? data["resources"].filter((item): item is string => typeof item === "string")
        : []
      const message = asString(data["message"])
      return {
        type: "permission.asked",
        sessionID,
        ask: {
          id,
          action,
          resources,
          title: describeAsk(action, resources),
          ...(message !== undefined ? { message } : {}),
        },
      }
    }
    case "permission.replied": {
      const sessionID = asString(data["sessionID"])
      const requestID = asString(data["requestID"])
      if (sessionID === undefined || requestID === undefined) return undefined
      return { type: "permission.replied", sessionID, requestID }
    }
    case "form.created": {
      const form = asRecord(data["form"])
      const id = asString(form["id"])
      const sessionID = asString(form["sessionID"])
      if (id === undefined || sessionID === undefined) return undefined
      const fields = Array.isArray(form["fields"]) ? form["fields"] : []
      const first = asRecord(fields[0])
      const metadata = asRecord(form["metadata"])
      const title =
        asString(first["title"]) ?? asString(form["title"]) ?? clip(asString(first["key"]) ?? "question", 80)
      const kind = asString(metadata["kind"])
      return { type: "form.created", sessionID, form: { id, title, ...(kind !== undefined ? { kind } : {}) } }
    }
    case "form.replied":
    case "form.cancelled": {
      const id = asString(data["id"])
      const sessionID = asString(data["sessionID"])
      if (id === undefined || sessionID === undefined) return undefined
      return { type: "form.closed", sessionID, formID: id }
    }
    default:
      return undefined
  }
}

export * as Events from "./events"
