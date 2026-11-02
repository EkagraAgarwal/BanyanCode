import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime, Schema } from "effect"

/**
 * The Markdown transcript format written by `/export`. A machine-readable
 * payload is embedded as base64 in an HTML comment; older or hand-written
 * files use the `## User` / `## Assistant (...)` sections instead. Both are
 * accepted, so transcripts from earlier releases still import.
 */
export interface TranscriptTime {
  readonly start: number
  readonly end?: number
  readonly compacted?: number
}

export interface TranscriptTool {
  readonly name: string
  readonly callID?: string
  readonly status?: "pending" | "running" | "completed" | "error"
  readonly input?: unknown
  readonly output?: string
  readonly error?: string
  readonly raw?: string
  readonly title?: string
  readonly time?: TranscriptTime
}

export type TranscriptPart =
  | {
      readonly type: "text"
      readonly text: string
      readonly synthetic?: boolean
      readonly ignored?: boolean
      readonly time?: TranscriptTime
    }
  | { readonly type: "reasoning"; readonly text: string; readonly time?: TranscriptTime }
  | ({ readonly type: "tool" } & TranscriptTool)

export interface TranscriptMessage {
  readonly id?: string
  readonly parentID?: string
  readonly role: "user" | "assistant"
  readonly agent?: string
  readonly modelID?: string
  readonly providerID?: string
  readonly variant?: string
  readonly createdAt?: number
  readonly completedAt?: number
  readonly text: string
  readonly reasoning?: string
  readonly tools?: readonly TranscriptTool[]
  readonly parts?: readonly TranscriptPart[]
}

export interface ParsedTranscript {
  readonly version?: number
  readonly sessionID?: string
  readonly title?: string
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly agent?: string
  readonly providerID?: string
  readonly modelID?: string
  readonly variant?: string
  readonly messages: readonly TranscriptMessage[]
}

const TOOL_LINE = /^\*\*Tool:\s*(.+?)\*\*\s*$/
const INPUT_HEADING = /^\*\*Input:\*\*\s*$/
const OUTPUT_HEADING = /^\*\*Output:\*\*\s*$/
const ERROR_HEADING = /^\*\*Error:\*\*\s*$/
const FENCE_START = /^```(\w+)?\s*$/
const SECTION_RULE = /^---\s*$/
const MACHINE_METADATA = /<!--\s*banyancode-transcript:v1\s*\n([A-Za-z0-9_-]+)\s*\n\s*-->/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

function tryJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
}
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

function parseTime(value: unknown): TranscriptTime | undefined {
  if (!isRecord(value)) return undefined
  const start = asNumber(value.start)
  if (start === undefined) return undefined
  return {
    start,
    ...(asNumber(value.end) === undefined ? {} : { end: asNumber(value.end) }),
    ...(asNumber(value.compacted) === undefined ? {} : { compacted: asNumber(value.compacted) }),
  }
}

function parseTool(value: unknown): TranscriptTool | undefined {
  if (!isRecord(value)) return undefined
  const name = asString(value.name)
  if (name === undefined) return undefined
  const rawStatus = asString(value.status)
  const status =
    rawStatus === "pending" || rawStatus === "running" || rawStatus === "completed" || rawStatus === "error"
      ? rawStatus
      : undefined
  return {
    name,
    ...(asString(value.callID) === undefined ? {} : { callID: asString(value.callID) }),
    ...(status === undefined ? {} : { status }),
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(asString(value.output) === undefined ? {} : { output: asString(value.output) }),
    ...(asString(value.error) === undefined ? {} : { error: asString(value.error) }),
    ...(asString(value.raw) === undefined ? {} : { raw: asString(value.raw) }),
    ...(asString(value.title) === undefined ? {} : { title: asString(value.title) }),
    ...(parseTime(value.time) === undefined ? {} : { time: parseTime(value.time) }),
  }
}

function parsePart(value: unknown): TranscriptPart | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === "tool") {
    const tool = parseTool(value)
    if (tool === undefined) return undefined
    return { type: "tool", ...tool }
  }
  if (value.type === "text" && typeof value.text === "string") {
    return {
      type: "text",
      text: value.text,
      ...(asBoolean(value.synthetic) === undefined ? {} : { synthetic: asBoolean(value.synthetic) }),
      ...(asBoolean(value.ignored) === undefined ? {} : { ignored: asBoolean(value.ignored) }),
      ...(parseTime(value.time) === undefined ? {} : { time: parseTime(value.time) }),
    }
  }
  if (value.type === "reasoning" && typeof value.text === "string") {
    return {
      type: "reasoning",
      text: value.text,
      ...(parseTime(value.time) === undefined ? {} : { time: parseTime(value.time) }),
    }
  }
  return undefined
}

function parseTools(value: unknown): readonly TranscriptTool[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tools = value.flatMap((entry) => {
    const tool = parseTool(entry)
    return tool === undefined ? [] : [tool]
  })
  return tools.length === 0 ? undefined : tools
}

function parseParts(value: unknown): readonly TranscriptPart[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((entry) => {
    const part = parsePart(entry)
    return part === undefined ? [] : [part]
  })
  return parts.length === 0 ? undefined : parts
}

function parseMachineMessage(value: unknown): TranscriptMessage | undefined {
  if (!isRecord(value)) return undefined
  if (value.role !== "user" && value.role !== "assistant") return undefined
  return {
    role: value.role,
    text: typeof value.text === "string" ? value.text : "",
    ...(asString(value.id) === undefined ? {} : { id: asString(value.id) }),
    ...(asString(value.parentID) === undefined ? {} : { parentID: asString(value.parentID) }),
    ...(asString(value.agent) === undefined ? {} : { agent: asString(value.agent) }),
    ...(asString(value.modelID) === undefined ? {} : { modelID: asString(value.modelID) }),
    ...(asString(value.providerID) === undefined ? {} : { providerID: asString(value.providerID) }),
    ...(asString(value.variant) === undefined ? {} : { variant: asString(value.variant) }),
    ...(asNumber(value.createdAt) === undefined ? {} : { createdAt: asNumber(value.createdAt) }),
    ...(asNumber(value.completedAt) === undefined ? {} : { completedAt: asNumber(value.completedAt) }),
    ...(asString(value.reasoning) === undefined ? {} : { reasoning: asString(value.reasoning) }),
    ...(parseTools(value.tools) === undefined ? {} : { tools: parseTools(value.tools) }),
    ...(parseParts(value.parts) === undefined ? {} : { parts: parseParts(value.parts) }),
  }
}

function parseMachineMetadata(input: string): ParsedTranscript | undefined {
  const encoded = input.match(MACHINE_METADATA)?.[1]
  if (encoded === undefined) return undefined
  const decoded = tryJson(decodeBase64(encoded))
  if (!isRecord(decoded)) return undefined
  const value = decoded
  const messages = Array.isArray(value.messages)
    ? (value.messages as unknown[]).flatMap((entry) => {
        const message = parseMachineMessage(entry)
        return message === undefined ? [] : [message]
      })
    : []
  return {
    ...(asNumber(value.version) === undefined ? {} : { version: asNumber(value.version) }),
    ...(asString(value.sessionID) === undefined ? {} : { sessionID: asString(value.sessionID) }),
    ...(asString(value.title) === undefined ? {} : { title: asString(value.title) }),
    ...(asNumber(value.createdAt) === undefined ? {} : { createdAt: asNumber(value.createdAt) }),
    ...(asNumber(value.updatedAt) === undefined ? {} : { updatedAt: asNumber(value.updatedAt) }),
    ...(asString(value.agent) === undefined ? {} : { agent: asString(value.agent) }),
    ...(asString(value.providerID) === undefined ? {} : { providerID: asString(value.providerID) }),
    ...(asString(value.modelID) === undefined ? {} : { modelID: asString(value.modelID) }),
    ...(asString(value.variant) === undefined ? {} : { variant: asString(value.variant) }),
    messages,
  }
}

function splitOnHorizontalRule(input: string): string[] {
  const lines = input.split("\n")
  const blocks: string[][] = [[]]
  for (const line of lines) {
    if (SECTION_RULE.test(line)) blocks.push([])
    else blocks[blocks.length - 1]!.push(line)
  }
  return blocks.map((block) => block.join("\n"))
}

function parseAssistantAgent(header: string): string | undefined {
  const inner = parens(header)
  if (inner === undefined) return undefined
  const candidate = inner
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean)[0]
  if (candidate === undefined || candidate.toLowerCase() === "assistant") return undefined
  return candidate
}

function parseAssistantModel(header: string): { providerID: string; modelID: string } | undefined {
  const inner = parens(header)
  if (inner === undefined) return undefined
  for (const part of inner.split("·").map((value) => value.trim())) {
    if (part === "" || /^\d+(\.\d+)?(ms|s|m|h)?\s*$/.test(part)) continue
    const slash = part.indexOf("/")
    if (slash > 0 && slash < part.length - 1) {
      return { providerID: part.slice(0, slash), modelID: part.slice(slash + 1) }
    }
  }
  return undefined
}

function parens(header: string): string | undefined {
  const open = header.indexOf("(")
  const close = header.lastIndexOf(")")
  if (open === -1 || close === -1 || close <= open) return undefined
  return header.slice(open + 1, close).trim()
}

function parseAssistantBody(body: string): {
  readonly text: string
  readonly reasoning?: string
  readonly tools?: readonly TranscriptTool[]
} {
  const textChunks: string[] = []
  let reasoning: string | undefined
  const tools: TranscriptTool[] = []
  const lines = body.split("\n")
  let inFence = false
  let fenceLang = ""
  let pendingTool: TranscriptTool | undefined
  let pendingToolField: "input" | "output" | "error" | undefined
  let pendingFenceBuffer: string[] = []
  let inThinking = false
  let thinkingLines: string[] = []

  const flushTool = () => {
    if (pendingTool !== undefined) tools.push(pendingTool)
    pendingTool = undefined
    pendingToolField = undefined
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]!

    if (inFence) {
      const close = line.match(FENCE_START)
      if (close === null) {
        pendingFenceBuffer.push(line)
        index++
        continue
      }
      inFence = false
      const content = pendingFenceBuffer.join("\n")
      if (pendingTool !== undefined && pendingToolField === "input" && fenceLang === "json") {
        pendingTool = { ...pendingTool, input: tryJson(content) ?? content }
      } else if (pendingTool !== undefined && pendingToolField === "output") {
        pendingTool = { ...pendingTool, output: content }
      } else if (pendingTool !== undefined && pendingToolField === "error") {
        pendingTool = { ...pendingTool, error: content }
      } else if (content.length > 0) {
        textChunks.push("```\n" + content + "\n```")
      }
      pendingFenceBuffer = []
      fenceLang = ""
      index++
      continue
    }

    const open = line.match(FENCE_START)
    if (open !== null) {
      inFence = true
      fenceLang = open[1] ?? ""
      pendingFenceBuffer = []
      index++
      continue
    }

    if (line.trim() === "_Thinking:_") {
      inThinking = true
      thinkingLines = []
      index++
      continue
    }
    if (inThinking) {
      const toolMatch = line.match(TOOL_LINE)
      if (toolMatch !== null) {
        inThinking = false
        reasoning = thinkingLines.join("\n").trim() || undefined
        thinkingLines = []
        flushTool()
        pendingTool = { name: toolMatch[1]!.trim() }
        pendingToolField = undefined
        index++
        continue
      }
      if (line.trim() === "" && thinkingLines.length === 0) {
        index++
        continue
      }
      thinkingLines.push(line)
      index++
      continue
    }

    const toolMatch = line.match(TOOL_LINE)
    if (toolMatch !== null) {
      flushTool()
      pendingTool = { name: toolMatch[1]!.trim() }
      pendingToolField = undefined
      index++
      continue
    }

    if (pendingTool === undefined) {
      textChunks.push(line)
      index++
      continue
    }

    if (INPUT_HEADING.test(line)) {
      pendingToolField = "input"
      index++
      continue
    }
    if (OUTPUT_HEADING.test(line)) {
      pendingToolField = "output"
      index++
      continue
    }
    if (ERROR_HEADING.test(line)) {
      pendingToolField = "error"
      index++
      continue
    }
    textChunks.push(line)
    index++
  }

  flushTool()
  if (inThinking && thinkingLines.length > 0) reasoning = thinkingLines.join("\n").trim() || undefined

  return {
    text: textChunks.join("\n").trim().replace(/\n*---\s*$/, "").trim(),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(tools.length === 0 ? {} : { tools }),
  }
}

function parseMessageBlock(block: string): TranscriptMessage | undefined {
  const raw = block.split("\n")
  let index = 0
  while (index < raw.length && raw[index]!.trim() === "") index++
  if (index >= raw.length) return undefined
  const header = raw[index]!.trim()
  index++

  if (header === "## User") {
    const text = raw.slice(index).join("\n").trim()
    return text === "" ? undefined : { role: "user", text }
  }

  if (!header.startsWith("## Assistant")) return undefined
  const agent = parseAssistantAgent(header)
  const model = parseAssistantModel(header)
  const body = parseAssistantBody(raw.slice(index).join("\n"))
  if (body.text === "" && body.reasoning === undefined && body.tools === undefined) return undefined
  return {
    role: "assistant",
    text: body.text,
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { providerID: model.providerID, modelID: model.modelID }),
    ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
    ...(body.tools === undefined ? {} : { tools: body.tools }),
  }
}

function parseDate(input: string): number | undefined {
  if (input === "") return undefined
  const direct = Date.parse(input)
  if (!Number.isNaN(direct)) return direct
  const cleaned = input.replace(/(\d)(st|nd|rd|th)\b/gi, "$1")
  const alternate = Date.parse(cleaned)
  return Number.isNaN(alternate) ? undefined : alternate
}

export function parseTranscript(input: string): ParsedTranscript {
  const normalized = input.replace(/\r\n/g, "\n")
  const machine = parseMachineMetadata(normalized)
  if (machine !== undefined) return machine
  const blocks = splitOnHorizontalRule(normalized)

  let sessionID: string | undefined
  let title: string | undefined
  let createdAt: number | undefined
  let updatedAt: number | undefined
  let bodyStart = 0

  if (blocks.length > 0 && /^\s*# /.test(blocks[0]!)) {
    const headerLines = blocks[0]!.split("\n")
    title = headerLines[0]!.replace(/^\s*#\s+/, "").trim() || undefined
    for (const line of headerLines.slice(1)) {
      const match = line.match(/^\s*\*\*([^*]+?):\*\*\s*(.+?)\s*$/)
      if (match === null) continue
      const key = match[1]!.trim()
      const value = match[2]!.trim()
      if (key === "Session ID") sessionID = value
      else if (key === "Created") createdAt = parseDate(value)
      else if (key === "Updated") updatedAt = parseDate(value)
    }
    bodyStart = 1
  }

  const messages = blocks.slice(bodyStart).flatMap((block) => {
    const message = parseMessageBlock(block)
    return message === undefined ? [] : [message]
  })
  return {
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(title === undefined ? {} : { title }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    messages,
  }
}

export interface SessionImport {
  readonly info: Session.Info
  readonly messages: readonly SessionMessage.Info[]
}

const importedModel = (providerID: string | undefined, modelID: string | undefined) => ({
  providerID: Provider.ID.make(providerID ?? "import"),
  id: Model.ID.make(modelID ?? "import"),
})

/**
 * Converts a parsed Markdown transcript into the JSON payload accepted by
 * `POST /api/experimental/session/import`. The import endpoint takes full
 * session and message documents, so the Markdown-only fields (tools, text,
 * reasoning) are rebuilt into that shape here.
 */
export function transcriptToImport(
  parsed: ParsedTranscript,
  input: { readonly directory: string; readonly now?: number },
): SessionImport {
  const now = input.now ?? Date.now()
  const created = parsed.createdAt ?? now
  const updated = parsed.updatedAt ?? created
  const agent = parsed.agent ?? parsed.messages.find((message) => message.role === "assistant")?.agent ?? "build"
  const model = importedModel(parsed.providerID, parsed.modelID)
  const info: Session.Info = {
    id: Session.ID.create(),
    projectID: Project.ID.global,
    agent: Agent.ID.make(agent),
    model: {
      ...model,
      ...(parsed.variant === undefined ? {} : { variant: Model.VariantID.make(parsed.variant) }),
    },
    cost: Money.USD.make(0),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(created), updated: DateTime.makeUnsafe(updated) },
    title: parsed.title ?? `Imported · ${new Date(created).toLocaleString()}`,
    location: { directory: AbsolutePath.make(input.directory) },
  }

  const messages = parsed.messages.map((message): SessionMessage.Info => {
    const createdAt = message.createdAt ?? created
    if (message.role === "user") {
      return {
        id: SessionMessage.ID.create(),
        type: "user",
        text: message.text,
        time: { created: DateTime.makeUnsafe(createdAt) },
      }
    }
    const content: SessionMessage.AssistantContent[] = [
      ...(message.reasoning === undefined
        ? []
        : [
            {
              type: "reasoning" as const,
              text: message.reasoning,
              time: {
                created: DateTime.makeUnsafe(createdAt),
                ...(message.completedAt === undefined ? {} : { completed: DateTime.makeUnsafe(message.completedAt) }),
              },
            },
          ]),
      ...(message.tools ?? []).map((tool, index) => {
        const start = tool.time?.start ?? createdAt
        const end = tool.time?.end ?? start
        const toolInput = isRecord(tool.input) ? tool.input : tool.input === undefined ? {} : { value: tool.input }
        const state: SessionMessage.ToolState =
          tool.status === "error" || tool.error !== undefined
            ? {
                status: "error",
                input: toolInput,
                error: { type: "imported", message: tool.error ?? "Imported tool call failed" },
              }
            : tool.status === "completed" || tool.output !== undefined
              ? {
                  status: "completed",
                  input: toolInput,
                  content: [{ type: "text", text: tool.output ?? "" }],
                }
              : tool.status === "running"
                ? { status: "running", input: toolInput, metadata: {} }
                : { status: "streaming", input: tool.raw ?? "" }
        return {
          type: "tool" as const,
          id: tool.callID ?? `tool_${index}`,
          name: tool.name,
          executed: true,
          state,
          time: {
            created: DateTime.makeUnsafe(start),
            ...(end === start ? {} : { completed: DateTime.makeUnsafe(end) }),
          },
        }
      }),
      ...(message.text === "" ? [] : [{ type: "text" as const, text: message.text }]),
    ]
    const messageModel = importedModel(message.providerID ?? model.providerID, message.modelID ?? model.id)
    const variant = message.variant ?? parsed.variant
    return {
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.ID.make(message.agent ?? agent),
      model: { ...messageModel, ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }) },
      content,
      // The import endpoint only persists settled assistant messages; a legacy
      // transcript has no completedAt, so treat its recorded time as complete.
      time: {
        created: DateTime.makeUnsafe(createdAt),
        completed: DateTime.makeUnsafe(message.completedAt ?? createdAt),
      },
    }
  })

  return { info, messages }
}

/** JSON-safe form for the HTTP client (DateTime encodes to epoch millis). */
export function encodeSessionImport(data: SessionImport) {
  return {
    info: Schema.encodeSync(Session.Info)(data.info),
    messages: data.messages.map((message) => Schema.encodeSync(SessionMessage.Info)(message)),
  }
}
