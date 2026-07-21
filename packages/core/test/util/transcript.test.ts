import { describe, expect, test } from "bun:test"
import { parseTranscript } from "../../src/util/transcript"

const SAMPLE = `# Available tools overview

**Session ID:** ses_abc123
**Created:** 7/19/2026, 4:30:00 PM
**Updated:** 7/19/2026, 4:32:11 PM

---

## User

audit the banyancode install for security issues

---

## Assistant (coder · anthropic/claude-sonnet-4-6 · 2.1s)

_Thinking:_

I should grep for shell-out helpers and review the install scripts.

**Tool: bash**

**Input:**
\`\`\`json
{
  "command": "ls packages/opencode/src/installation",
  "timeout": 5000
}
\`\`\`

**Output:**
\`\`\`
probe.ts
index.ts
\`\`\`

**Tool: read**

**Input:**
\`\`\`json
{
  "file": "packages/opencode/src/installation/probe.ts"
}
\`\`\`

**Output:**
\`\`\`
export async function findAllBanyanCodeInstalls() {
  const result: BanyanInstall[] = []
  ...
}
\`\`\`

Findings:
- one path-traversal in curl uninstall when dir has spaces
- npm hook runs with root privileges

---

## User

can you fix the curl one?

---

## Assistant (coder · anthropic/claude-sonnet-4-6 · 0.6s)

Yes, here is the patch.

**Tool: edit**

**Input:**
\`\`\`json
{
  "file": "packages/opencode/src/installation/probe.ts",
  "edits": [{ "oldText": "x", "newText": "y" }]
}
\`\`\`

**Error:**
\`\`\`
ENOENT: no such file or directory
\`\`\`

The fix is at packages/opencode/src/installation/probe.ts:42.
`

describe("parseTranscript", () => {
  test("extracts session metadata", () => {
    const parsed = parseTranscript(SAMPLE)
    expect(parsed.title).toBe("Available tools overview")
    expect(parsed.sessionID).toBe("ses_abc123")
    expect(typeof parsed.createdAt).toBe("number")
    expect(typeof parsed.updatedAt).toBe("number")
  })

  test("parses user and assistant message alternation", () => {
    const parsed = parseTranscript(SAMPLE)
    expect(parsed.messages.length).toBe(4)
    expect(parsed.messages[0].role).toBe("user")
    expect(parsed.messages[0].text).toBe("audit the banyancode install for security issues")
    expect(parsed.messages[1].role).toBe("assistant")
    expect(parsed.messages[2].role).toBe("user")
    expect(parsed.messages[3].role).toBe("assistant")
  })

  test("captures assistant agent and model from header", () => {
    const parsed = parseTranscript(SAMPLE)
    expect(parsed.messages[1].agent).toBe("coder")
    expect(parsed.messages[1].providerID).toBe("anthropic")
    expect(parsed.messages[1].modelID).toBe("claude-sonnet-4-6")
  })

  test("captures thinking block", () => {
    const parsed = parseTranscript(SAMPLE)
    expect(parsed.messages[1].reasoning).toContain("shell-out helpers")
  })

  test("captures tool calls with input, output, and error", () => {
    const parsed = parseTranscript(SAMPLE)
    const tools = parsed.messages[1].tools
    expect(tools).toBeDefined()
    expect(tools!.length).toBe(2)
    expect(tools![0].name).toBe("bash")
    expect(tools![0].input).toEqual({
      command: "ls packages/opencode/src/installation",
      timeout: 5000,
    })
    expect(tools![0].output).toContain("probe.ts")
    expect(tools![1].name).toBe("read")
    expect(tools![1].output).toContain("findAllBanyanCodeInstalls")
  })

  test("captures tool error in a follow-up assistant turn", () => {
    const parsed = parseTranscript(SAMPLE)
    const editTool = parsed.messages[3].tools!.find((t) => t.name === "edit")
    expect(editTool).toBeDefined()
    expect(editTool!.error).toContain("ENOENT")
  })

  test("returns no metadata when file starts mid-document", () => {
    const parsed = parseTranscript("## User\n\nhello\n")
    expect(parsed.sessionID).toBeUndefined()
    expect(parsed.title).toBeUndefined()
    expect(parsed.messages.length).toBe(1)
    expect(parsed.messages[0].role).toBe("user")
    expect(parsed.messages[0].text).toBe("hello")
  })

  test("handles CRLF line endings", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n")
    const parsed = parseTranscript(crlf)
    expect(parsed.messages.length).toBe(4)
    expect(parsed.messages[1].tools?.length).toBe(2)
  })

  test("parses legacy assistant-only exports", () => {
    const parsed = parseTranscript(`# Available tools overview

**Session ID:** ses_legacy

---

## Assistant (Build · MiniMax-M3 · 8.2s)

**Tool: bash**

**Input:**
\`\`\`json
{ "command": "pwd" }
\`\`\`

**Output:**
\`\`\`
D:\\OpenCode
\`\`\`
`)

    expect(parsed.sessionID).toBe("ses_legacy")
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0].role).toBe("assistant")
    expect(parsed.messages[0].tools?.[0]).toMatchObject({ name: "bash", input: { command: "pwd" } })
  })

  test("treats tool input that is not valid JSON as a string", () => {
    const body = `## Assistant (coder · anthropic/claude-sonnet-4-6 · 0.1s)

**Tool: bash**

**Input:**
\`\`\`json
{not valid json
\`\`\`
`
    const parsed = parseTranscript(body)
    expect(parsed.messages[0].tools?.[0].input).toBe("{not valid json")
  })
})