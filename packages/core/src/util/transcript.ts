import { Schema } from "effect"
import { base64Decode } from "./encode"

const TranscriptTimeSchema = Schema.Struct({
  start: Schema.Number,
  end: Schema.optional(Schema.Number),
  compacted: Schema.optional(Schema.Number),
})

const TranscriptToolSchema = Schema.Struct({
  name: Schema.String,
  callID: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["pending", "running", "completed", "error"])),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  raw: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  time: Schema.optional(TranscriptTimeSchema),
})

const TranscriptPartSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
    synthetic: Schema.optional(Schema.Boolean),
    ignored: Schema.optional(Schema.Boolean),
    time: Schema.optional(TranscriptTimeSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning"),
    text: Schema.String,
    time: Schema.optional(TranscriptTimeSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    name: Schema.String,
    callID: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Literals(["pending", "running", "completed", "error"])),
    input: Schema.optional(Schema.Unknown),
    output: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    raw: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    time: Schema.optional(TranscriptTimeSchema),
  }),
])

export const TranscriptMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.String),
  role: Schema.Literals(["user", "assistant"]),
  agent: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.Number),
  text: Schema.String,
  reasoning: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(TranscriptToolSchema)),
  parts: Schema.optional(Schema.Array(TranscriptPartSchema)),
})

export const ParsedTranscriptSchema = Schema.Struct({
  version: Schema.optional(Schema.Number),
  sessionID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
  agent: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  messages: Schema.Array(TranscriptMessageSchema),
})

export type TranscriptMessage = typeof TranscriptMessageSchema.Type
export type TranscriptPart = typeof TranscriptPartSchema.Type
export type ParsedTranscript = typeof ParsedTranscriptSchema.Type

const TOOL_LINE = /^\*\*Tool:\s*(.+?)\*\*\s*$/
const INPUT_HEADING = /^\*\*Input:\*\*\s*$/
const OUTPUT_HEADING = /^\*\*Output:\*\*\s*$/
const ERROR_HEADING = /^\*\*Error:\*\*\s*$/
const FENCE_START = /^```(\w+)?\s*$/
const SECTION_RULE = /^---\s*$/
const MACHINE_METADATA = /<!--\s*banyancode-transcript:v1\s*\n([A-Za-z0-9_-]+)\s*\n\s*-->/

// Reverses `formatTranscript`. Accepts the Markdown the TUI produces via
// /export and any file produced by a third-party exporter that follows
// the same template (session metadata header at the top, alternating
// `## User` and `## Assistant (...)` sections separated by `---` rules).
// Tolerates extra whitespace, missing optional fields, and content that
// does not start with the metadata header (in which case sessionID /
// title / timestamps are left undefined and the caller picks defaults).
export function parseTranscript(input: string): ParsedTranscript {
  const normalized = input.replace(/\r\n/g, "\n")
  const machine = parseMachineMetadata(normalized)
  if (machine) return machine
  const blocks = splitOnHorizontalRule(normalized)

  let sessionID: string | undefined
  let title: string | undefined
  let createdAt: number | undefined
  let updatedAt: number | undefined
  let bodyStart = 0

  // If the first block contains an H1 followed by metadata key/value lines,
  // treat it as the header and parse it.
  if (blocks.length > 0 && /^\s*# /.test(blocks[0])) {
    const headerLines = blocks[0].split("\n")
    title = headerLines[0].replace(/^\s*#\s+/, "").trim() || undefined
    for (const line of headerLines.slice(1)) {
      const m = line.match(/^\s*\*\*([^*]+?):\*\*\s*(.+?)\s*$/)
      if (!m) continue
      const key = m[1].trim()
      const val = m[2].trim()
      if (key === "Session ID") sessionID = val
      else if (key === "Created") createdAt = parseDate(val)
      else if (key === "Updated") updatedAt = parseDate(val)
    }
    bodyStart = 1
  }

  const messages: TranscriptMessage[] = []
  for (let i = bodyStart; i < blocks.length; i++) {
    const parsed = parseMessageBlock(blocks[i])
    if (parsed) messages.push(parsed)
  }

  return {
    sessionID,
    title,
    createdAt,
    updatedAt,
    messages,
  }
}

function parseMachineMetadata(input: string): ParsedTranscript | undefined {
  const encoded = input.match(MACHINE_METADATA)?.[1]
  if (!encoded) return
  try {
    return Schema.decodeUnknownSync(ParsedTranscriptSchema)(JSON.parse(base64Decode(encoded)))
  } catch {
    return
  }
}

function splitOnHorizontalRule(input: string): string[] {
  const lines = input.split("\n")
  const blocks: string[][] = [[]]
  for (const line of lines) {
    if (SECTION_RULE.test(line)) {
      blocks.push([])
    } else {
      blocks[blocks.length - 1].push(line)
    }
  }
  return blocks.map((b) => b.join("\n"))
}

function parseMessageBlock(block: string): TranscriptMessage | null {
  const raw = block.split("\n")
  // Find the first non-empty line and require it to be a section header.
  let i = 0
  while (i < raw.length && raw[i].trim() === "") i++
  if (i >= raw.length) return null
  const header = raw[i].trim()
  i++

  if (header === "## User") {
    const text = raw.slice(i).join("\n").trim()
    if (!text) return null
    return { role: "user", text }
  }

  if (header.startsWith("## Assistant")) {
    const agent = parseAssistantAgent(header)
    const providerModel = parseAssistantModel(header)
    const body = raw.slice(i).join("\n")
    const { text, reasoning, tools } = parseAssistantBody(body)
    if (!text && !reasoning && (!tools || tools.length === 0)) return null
    return {
      role: "assistant",
      agent,
      providerID: providerModel?.providerID,
      modelID: providerModel?.modelID,
      text,
      reasoning,
      tools,
    }
  }

  return null
}

// `## Assistant (agent · model · 2.3s)` -> "agent"
function parseAssistantAgent(header: string): string | undefined {
  const inner = parens(header)
  if (!inner) return undefined
  const parts = inner.split("·").map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return undefined
  const candidate = parts[0]
  if (!candidate || candidate.toLowerCase() === "assistant") return undefined
  return candidate
}

function parseAssistantModel(header: string): { providerID: string; modelID: string } | undefined {
  const inner = parens(header)
  if (!inner) return undefined
  const parts = inner.split("·").map((s) => s.trim()).filter(Boolean)
  for (const part of parts) {
    if (/^\d+(\.\d+)?(ms|s|m|h)?\s*$/.test(part)) continue
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
  text: string
  reasoning?: string
  tools?: TranscriptMessage["tools"]
} {
  const textChunks: string[] = []
  let reasoning: string | undefined
  const tools: Array<{ name: string; input?: unknown; output?: string; error?: string }> = []

  const lines = body.split("\n")
  let inFence = false
  let fenceLang = ""
  let pendingTool: { name: string; input?: unknown; output?: string; error?: string } | null = null
  let pendingToolField: "input" | "output" | "error" | null = null
  let pendingFenceBuffer: string[] = []
  let inThinking = false
  let thinkingLines: string[] = []

  const flushTool = () => {
    if (pendingTool) tools.push(pendingTool)
    pendingTool = null
    pendingToolField = null
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Inside a fenced block, capture verbatim.
    if (inFence) {
      const close = line.match(FENCE_START)
      if (close) {
        inFence = false
        const content = pendingFenceBuffer.join("\n")
        if (pendingTool && pendingToolField === "input" && fenceLang === "json") {
          try {
            pendingTool.input = JSON.parse(content)
          } catch {
            pendingTool.input = content
          }
        } else if (pendingTool && pendingToolField === "output") {
          pendingTool.output = content
        } else if (pendingTool && pendingToolField === "error") {
          pendingTool.error = content
        } else {
          if (content.length > 0) textChunks.push("```\n" + content + "\n```")
        }
        pendingFenceBuffer = []
        fenceLang = ""
      } else {
        pendingFenceBuffer.push(line)
      }
      i++
      continue
    }
    const open = line.match(FENCE_START)
    if (open) {
      inFence = true
      fenceLang = open[1] ?? ""
      pendingFenceBuffer = []
      i++
      continue
    }

    // _Thinking:_ starts a thinking block; capture every line after it
    // until we hit a `**Tool: ...**` heading. Blank lines are preserved
    // so multi-paragraph reasoning round-trips, and leading blank lines
    // are skipped so an empty paragraph between the heading and the body
    // (the format used by formatTranscript) doesn't truncate the capture.
    if (line.trim() === "_Thinking:_") {
      inThinking = true
      thinkingLines = []
      i++
      continue
    }
    if (inThinking) {
      if (TOOL_LINE.test(line)) {
        inThinking = false
        reasoning = thinkingLines.join("\n").trim() || undefined
        thinkingLines = []
        flushTool()
        const m = line.match(TOOL_LINE)!
        pendingTool = { name: m[1].trim() }
        pendingToolField = null
        i++
        continue
      }
      // Skip the very first blank line after `_Thinking:_` so the
      // capture isn't truncated by the formatTranscript padding.
      if (line.trim() === "" && thinkingLines.length === 0) {
        i++
        continue
      }
      thinkingLines.push(line)
      i++
      continue
    }

    const toolMatch = line.match(TOOL_LINE)
    if (toolMatch) {
      flushTool()
      pendingTool = { name: toolMatch[1].trim() }
      pendingToolField = null
      i++
      continue
    }

    if (!pendingTool) {
      textChunks.push(line)
      i++
      continue
    }

    if (INPUT_HEADING.test(line)) {
      pendingToolField = "input"
      i++
      continue
    }
    if (OUTPUT_HEADING.test(line)) {
      pendingToolField = "output"
      i++
      continue
    }
    if (ERROR_HEADING.test(line)) {
      pendingToolField = "error"
      i++
      continue
    }
    textChunks.push(line)
    i++
  }
  flushTool()
  if (inThinking && thinkingLines.length > 0) {
    reasoning = thinkingLines.join("\n").trim() || undefined
  }

  const text = textChunks.join("\n").trim().replace(/\n*---\s*$/, "").trim()
  return {
    text,
    reasoning,
    tools: tools.length > 0 ? tools : undefined,
  }
}

function parseDate(input: string): number | undefined {
  if (!input) return undefined
  const direct = Date.parse(input)
  if (!Number.isNaN(direct)) return direct
  // Tolerate ordinal suffixes (1st, 2nd, 23rd) that JS Date.parse does
  // not accept.
  const cleaned = input.replace(/(\d)(st|nd|rd|th)\b/gi, "$1")
  const alt = Date.parse(cleaned)
  return Number.isNaN(alt) ? undefined : alt
}