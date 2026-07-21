import { randomUUID } from "node:crypto"
import { Cause, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { SessionImportInput, SessionImportResult } from "../groups/import"
import { InvalidRequestError } from "../errors"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID } from "@/session/schema"
import { parseTranscript, type TranscriptMessage, type TranscriptPart } from "@opencode-ai/core/util/transcript"

type ImportedTool = NonNullable<TranscriptMessage["tools"]>[number]

type ImportedPartTool = Extract<TranscriptPart, { type: "tool" }>

function validTimestamp(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

function buildImportedToolPart(
  sessionID: string,
  messageID: string,
  tool: ImportedTool | ImportedPartTool,
): SessionV1.ToolPart {
  const callID = tool.callID ?? randomUUID()
  const now = Date.now()
  const input =
    tool.input !== undefined && typeof tool.input === "object" && tool.input !== null && !Array.isArray(tool.input)
      ? (tool.input as Record<string, unknown>)
      : tool.input === undefined
        ? {}
        : { value: tool.input }
  const start = validTimestamp(tool.time?.start) ?? now
  const end = validTimestamp(tool.time?.end) ?? start
  let state: SessionV1.ToolState
  if (tool.status === "error" || tool.error !== undefined) {
    state = {
      status: "error",
      input,
      error: tool.error ?? "Imported tool call failed",
      time: { start, end },
    } as SessionV1.ToolStateError
  } else if (tool.status === "completed" || tool.output !== undefined) {
    state = {
      status: "completed",
      input,
      output: tool.output ?? "",
      title: tool.title ?? tool.name,
      metadata: {},
      time: { start, end, compacted: validTimestamp(tool.time?.compacted) },
    } as SessionV1.ToolStateCompleted
  } else if (tool.status === "running") {
    state = {
      status: "running",
      input,
      title: tool.title,
      metadata: {},
      time: { start },
    } as SessionV1.ToolStateRunning
  } else {
    state = {
      status: "pending",
      input,
      raw: tool.raw ?? "",
    } as SessionV1.ToolStatePending
  }
  return {
    id: PartID.ascending(),
    sessionID: sessionID as never,
    messageID: messageID as never,
    type: "tool",
    callID,
    tool: tool.name,
    state,
  } as SessionV1.ToolPart
}

function buildImportedPart(sessionID: string, messageID: string, part: TranscriptPart): SessionV1.Part {
  if (part.type === "tool") return buildImportedToolPart(sessionID, messageID, part)
  const now = Date.now()
  if (part.type === "reasoning") {
    const start = validTimestamp(part.time?.start) ?? now
    return {
      id: PartID.ascending(),
      sessionID: sessionID as never,
      messageID: messageID as never,
      type: "reasoning",
      text: part.text,
      time: { start, end: validTimestamp(part.time?.end) ?? start },
    } as SessionV1.ReasoningPart
  }
  return {
    id: PartID.ascending(),
    sessionID: sessionID as never,
    messageID: messageID as never,
    type: "text",
    text: part.text,
    synthetic: part.synthetic,
    ignored: part.ignored,
    time:
      part.time?.start === undefined
        ? undefined
        : { start: validTimestamp(part.time.start) ?? now, end: validTimestamp(part.time.end) },
  } as SessionV1.TextPart
}

export const importHandlers = HttpApiBuilder.group(InstanceHttpApi, "sessionImport", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const sessionImport = Effect.fn("SessionImportHttpApi.sessionImport")(function* (ctx: {
      payload: typeof SessionImportInput.Type
    }) {
      const parsed = parseTranscript(ctx.payload.content)
      if (parsed.messages.length === 0) {
        return yield* Effect.fail(
          new InvalidRequestError({
            message: "Transcript contained no user/assistant messages to import.",
          }),
        )
      }

      const title =
        ctx.payload.title?.trim() || parsed.title?.trim() || `Imported · ${new Date().toLocaleString()}`
      const agent =
        ctx.payload.agent?.trim() ||
        parsed.agent?.trim() ||
        parsed.messages.find((m) => m.role === "assistant")?.agent ||
        "build"
      const model =
        parsed.modelID && parsed.providerID
          ? {
              id: parsed.modelID as never,
              providerID: parsed.providerID as never,
              variant: parsed.variant,
            }
          : undefined
      const sessionInfo = yield* sessions.create({
        title,
        agent,
        model,
        parentID: ctx.payload.parentID,
      })

      const now = Date.now()
      const parsedCreated =
        validTimestamp(parsed.createdAt) ?? validTimestamp(parsed.updatedAt) ?? now
      const parsedUpdated = validTimestamp(parsed.updatedAt) ?? parsedCreated
      yield* sessions.patchTime({
        sessionID: sessionInfo.id,
        created: parsedCreated,
        updated: parsedUpdated,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("sessionImport: patchTime failed", {
            sessionID: sessionInfo.id,
            cause: Cause.pretty(cause),
          }),
        ),
      )

      let messageCount = 0
      let previousMsgID: MessageID | undefined
      const messageIDs = parsed.messages.map(() => MessageID.ascending())
      const messageIDMap = new Map(
        parsed.messages.flatMap((msg, index) => (msg.id ? [[msg.id, messageIDs[index]]] : [])),
      )
      for (const [index, msg] of parsed.messages.entries()) {
        const id = messageIDs[index]
        const created = validTimestamp(msg.createdAt) ?? Date.now()
        if (msg.role === "user") {
          const providerID = msg.providerID ?? parsed.providerID ?? "import"
          const modelID = msg.modelID ?? parsed.modelID ?? "import"
          yield* sessions.updateMessage({
            id,
            sessionID: sessionInfo.id,
            role: "user",
            time: { created },
            agent: msg.agent ?? agent,
            model: { providerID, modelID, variant: msg.variant ?? parsed.variant },
          } as SessionV1.User)
        } else {
          const parentID = (msg.parentID && messageIDMap.get(msg.parentID)) ?? previousMsgID ?? id
          const providerID = msg.providerID ?? parsed.providerID ?? "import"
          const modelID = msg.modelID ?? parsed.modelID ?? "import"
          const assistantAgent = msg.agent ?? agent
          yield* sessions.updateMessage({
            id,
            sessionID: sessionInfo.id,
            role: "assistant",
            parentID,
            time: { created, completed: validTimestamp(msg.completedAt) },
            agent: assistantAgent,
            mode: assistantAgent,
            modelID,
            providerID,
            path: { cwd: sessionInfo.directory, root: sessionInfo.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } as SessionV1.Assistant)
        }

        if (msg.parts) {
          for (const part of msg.parts) {
            yield* sessions.updatePart(buildImportedPart(sessionInfo.id, id, part))
          }
        } else if (msg.role === "user") {
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: sessionInfo.id,
            messageID: id,
            type: "text",
            text: msg.text,
            synthetic: true,
          } as SessionV1.TextPart)
        } else {
          if (msg.reasoning) {
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: sessionInfo.id,
              messageID: id,
              type: "reasoning",
              text: msg.reasoning,
              time: { start: created, end: validTimestamp(msg.completedAt) ?? created },
            } as SessionV1.ReasoningPart)
          }
          for (const tool of msg.tools ?? []) {
            yield* sessions.updatePart(buildImportedToolPart(sessionInfo.id, id, tool))
          }
          if (msg.text) {
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: sessionInfo.id,
              messageID: id,
              type: "text",
              text: msg.text,
            } as SessionV1.TextPart)
          }
        }
        previousMsgID = id
        messageCount++
      }

      return {
        sessionID: sessionInfo.id,
        title,
        messageCount,
        startedFromParsedSessionID: parsed.sessionID,
      } satisfies typeof SessionImportResult.Type
    })

    return handlers.handle("sessionImport", sessionImport)
  }),
)
