import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { expect, test } from "bun:test"
import { Schema } from "effect"
import { normalizeImportPath } from "../src/data/import-path"
import { encodeSessionImport, parseTranscript, transcriptToImport } from "../src/data/transcript"

const legacyMarkdown = `# Available tools overview

**Session ID:** ses_legacy01abc234de56fg78hi90
**Created:** 2026-01-15T10:30:00.000Z
**Updated:** 2026-01-15T11:45:00.000Z

---

## User

Please list every tool the agent has.

---

## Assistant (Build · minimax-coding-plan/MiniMax-M3 · 1.2s)

Here is the list:

- bash
- read
- write

**Tool: bash**

**Input:**
\`\`\`json
{
  "command": "ls -1"
}
\`\`\`

**Output:**
\`\`\`
file1
file2
\`\`\`

---

## User

Thanks.
`

function machineTranscript(value: unknown) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
  return `<!-- banyancode-transcript:v1\n${encoded}\n-->\n`
}

test("parses the Markdown transcript written by /export", () => {
  const parsed = parseTranscript(legacyMarkdown)
  expect(parsed.sessionID).toBe("ses_legacy01abc234de56fg78hi90")
  expect(parsed.title).toBe("Available tools overview")
  expect(parsed.createdAt).toBe(Date.parse("2026-01-15T10:30:00.000Z"))
  expect(parsed.updatedAt).toBe(Date.parse("2026-01-15T11:45:00.000Z"))
  expect(parsed.messages).toHaveLength(3)
  expect(parsed.messages[0]).toEqual({ role: "user", text: "Please list every tool the agent has." })
  const assistant = parsed.messages[1]!
  expect(assistant.role).toBe("assistant")
  expect(assistant.agent).toBe("Build")
  expect(assistant.providerID).toBe("minimax-coding-plan")
  expect(assistant.modelID).toBe("MiniMax-M3")
  expect(assistant.text).toContain("Here is the list:")
  expect(assistant.tools).toHaveLength(1)
  expect(assistant.tools?.[0]).toMatchObject({
    name: "bash",
    input: { command: "ls -1" },
    output: "file1\nfile2",
  })
  expect(parsed.messages[2]).toEqual({ role: "user", text: "Thanks." })
})

test("reads the machine metadata block when a transcript has one", () => {
  const parsed = parseTranscript(
    machineTranscript({
      version: 1,
      sessionID: "ses_machine",
      title: "Machine metadata test",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_300_000,
      agent: "build",
      providerID: "provider",
      modelID: "model",
      variant: "thinking",
      messages: [
        { id: "msg_user", role: "user", text: "Hello", createdAt: 1_700_000_000_000 },
        {
          id: "msg_assistant",
          role: "assistant",
          agent: "build",
          providerID: "provider",
          modelID: "model",
          text: "Hi there!",
          reasoning: "A thinking block.",
          createdAt: 1_700_000_100_000,
          completedAt: 1_700_000_200_000,
          tools: [
            {
              name: "bash",
              callID: "call_1",
              status: "completed",
              input: { command: "echo hello" },
              output: "hello\n",
              title: "bash",
            },
          ],
        },
      ],
    }),
  )
  expect(parsed.sessionID).toBe("ses_machine")
  expect(parsed.title).toBe("Machine metadata test")
  expect(parsed.variant).toBe("thinking")
  expect(parsed.messages).toHaveLength(2)
  expect(parsed.messages[1]?.reasoning).toBe("A thinking block.")
  expect(parsed.messages[1]?.tools?.[0]?.output).toBe("hello\n")
})

test("converts a transcript to the session.import JSON document", () => {
  const parsed = parseTranscript(legacyMarkdown)
  const data = transcriptToImport(parsed, { directory: "D:/workspace", now: 1_700_000_000_000 })
  expect(data.info.id.startsWith("ses_")).toBe(true)
  expect(data.info.title).toBe("Available tools overview")
  expect(String(data.info.agent)).toBe("Build")
  expect(data.messages).toHaveLength(3)
  expect(data.messages[0]).toMatchObject({ type: "user", text: "Please list every tool the agent has." })
  const assistant = data.messages[1]!
  expect(assistant.type).toBe("assistant")
  if (assistant.type !== "assistant") throw new Error("expected assistant")
  expect(String(assistant.agent)).toBe(parsed.messages[1]?.agent ?? "build")
  expect(assistant.content.map((part) => part.type)).toEqual(["tool", "text"])
  const tool = assistant.content[0]!
  expect(tool.type).toBe("tool")
  if (tool.type !== "tool") throw new Error("expected tool")
  expect(tool.state).toMatchObject({ status: "completed", content: [{ type: "text", text: "file1\nfile2" }] })
  const textPart = assistant.content[1]!
  expect(textPart.type).toBe("text")
  if (textPart.type !== "text") throw new Error("expected text")
  expect(textPart.text).toContain("Here is the list:")

  const encoded = encodeSessionImport(data)
  expect(typeof encoded.info.time.created).toBe("number")
  expect(encoded.info.time.created).toBe(Date.parse("2026-01-15T10:30:00.000Z"))
  expect(encoded.messages).toHaveLength(3)
  const encodedAssistant = encoded.messages[1] as { time: { completed?: number } }
  expect(encodedAssistant.time.completed).toBe(Date.parse("2026-01-15T10:30:00.000Z"))
  expect(() => Schema.decodeUnknownSync(Session.Info)(encoded.info)).not.toThrow()
  for (const message of encoded.messages) {
    expect(() => Schema.decodeUnknownSync(SessionMessage.Info)(message)).not.toThrow()
  }
})

test("converts a machine transcript's reasoning and model", () => {
  const parsed = parseTranscript(
    machineTranscript({
      version: 1,
      title: "Machine",
      agent: "build",
      providerID: "provider",
      modelID: "model",
      messages: [
        {
          role: "assistant",
          text: "Answer",
          reasoning: "Think",
          createdAt: 1_700_000_000_000,
          completedAt: 1_700_000_050_000,
        },
      ],
    }),
  )
  const data = transcriptToImport(parsed, { directory: "D:/workspace", now: 1_700_000_000_000 })
  const assistant = data.messages[0]!
  if (assistant.type !== "assistant") throw new Error("expected assistant")
  expect(assistant.content.map((part) => part.type)).toEqual(["reasoning", "text"])
  expect(String(assistant.model.id)).toBe("model")
  expect(String(assistant.model.providerID)).toBe("provider")
})

test("an empty transcript yields no messages for the command to reject", () => {
  expect(parseTranscript("# Nothing here\n").messages).toEqual([])
})

test("import path normalization accepts quoted paths", () => {
  expect(normalizeImportPath("  'C:\\tmp\\session.md'  ", "win32")).toBe("C:\\tmp\\session.md")
  expect(normalizeImportPath('"/tmp/session.md"', "linux")).toBe("/tmp/session.md")
  expect(normalizeImportPath("/tmp/a\\ b.md", "linux")).toBe("/tmp/a b.md")
})
