import type { AssistantMessage, Part, Provider, UserMessage } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Locale } from "./locale"
import * as Model from "./model"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  providers?: Provider[]
}

export type SessionInfo = {
  id: string
  title: string
  agent?: string
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  const providers = Model.index(options.providers)
  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  transcript += `<!-- banyancode-transcript:v1\n${base64Encode(
    JSON.stringify({
      version: 1,
      sessionID: session.id,
      title: session.title,
      createdAt: session.time.created,
      updatedAt: session.time.updated,
      agent: session.agent,
      providerID: session.model?.providerID,
      modelID: session.model?.id,
      variant: session.model?.variant,
      messages: messages.map((msg) => formatMachineMessage(msg.info, msg.parts)),
    }),
  )}\n-->\n\n`
  transcript += `---\n\n`

  for (const msg of messages) {
    transcript += formatMessage(msg.info, msg.parts, options, providers)
    transcript += `---\n\n`
  }

  return transcript
}

type MachinePart =
  | {
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
      time?: { start: number; end?: number }
    }
  | {
      type: "reasoning"
      text: string
      time: { start: number; end?: number }
    }
  | {
      type: "tool"
      name: string
      callID: string
      status: string
      input: Record<string, unknown>
      output?: string
      error?: string
      raw?: string
      title?: string
      time?: { start: number; end?: number; compacted?: number }
    }

function formatMachineMessage(msg: UserMessage | AssistantMessage, parts: Part[]) {
  const machineParts: MachinePart[] = parts.flatMap<MachinePart>((part) => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text, synthetic: part.synthetic, ignored: part.ignored, time: part.time }]
    }
    if (part.type === "reasoning") return [{ type: "reasoning", text: part.text, time: part.time }]
    if (part.type !== "tool") return []
    return [
      {
        type: "tool",
        name: part.tool,
        callID: part.callID,
        status: part.state.status,
        input: part.state.input,
        output: part.state.status === "completed" ? part.state.output : undefined,
        error: part.state.status === "error" ? part.state.error : undefined,
        raw: part.state.status === "pending" ? part.state.raw : undefined,
        title: "title" in part.state ? part.state.title : undefined,
        time: "time" in part.state ? part.state.time : undefined,
      },
    ]
  })
  const text = machineParts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  const reasoning = machineParts.filter((part) => part.type === "reasoning").map((part) => part.text).join("\n")
  const tools = machineParts
    .filter((part) => part.type === "tool")
    .map((part) => ({
      name: part.name,
      callID: part.callID,
      status: part.status,
      input: part.input,
      output: part.output,
      error: part.error,
      raw: part.raw,
      title: part.title,
      time: part.time,
    }))

  return {
    id: msg.id,
    role: msg.role,
    parentID: msg.role === "assistant" ? msg.parentID : undefined,
    createdAt: msg.time.created,
    completedAt: msg.role === "assistant" ? msg.time.completed : undefined,
    agent: msg.agent,
    providerID: msg.role === "assistant" ? msg.providerID : msg.model.providerID,
    modelID: msg.role === "assistant" ? msg.modelID : msg.model.modelID,
    variant: msg.role === "user" ? msg.model.variant : msg.variant,
    text,
    reasoning: reasoning || undefined,
    tools: tools.length > 0 ? tools : undefined,
    parts: machineParts,
  }
}

export function formatMessage(
  msg: UserMessage | AssistantMessage,
  parts: Part[],
  options: TranscriptOptions,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  let result = ""

  if (msg.role === "user") {
    result += `## User\n\n`
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata, providers ?? options.providers)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(
  msg: AssistantMessage,
  includeMetadata: boolean,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  const modelName = Model.name(providers, msg.providerID, msg.modelID)

  return `## Assistant (${Locale.titlecase(msg.agent)} · ${modelName}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    let text = part.text
    if (text.trim().startsWith("</think>")) {
      text = text.trim().slice(8).trim()
    }
    return `${text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `**Tool: ${part.tool}**\n`
    if (options.toolDetails && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`
    }
    result += `\n`
    return result
  }

  return ""
}
