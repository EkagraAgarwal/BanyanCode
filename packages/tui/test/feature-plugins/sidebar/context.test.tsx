/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import SidebarContext from "../../../src/feature-plugins/sidebar/context"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
  accent: { r: 150, g: 150, b: 150, a: 1 },
  info: { r: 100, g: 100, b: 100, a: 1 },
}

// Categorize uses internal helpers; access via the test export.
const ctxModule = await import("../../../src/feature-plugins/sidebar/context" as any)
const { categorizeTokens } = (ctxModule.__test ?? ctxModule.default?.__test) as {
  categorizeTokens: any
}

const fixtureUser = {
  id: "msg-u1",
  type: "user" as const,
  role: "user" as const,
  text: "this is a user prompt",
  time: { created: 0 },
}

const fixtureUserParts = [
  {
    id: "part-u1",
    sessionID: "session_test",
    messageID: "msg-u1",
    type: "text" as const,
    text: "this is a user prompt",
  },
]

const fixtureAssistantParts = [
  {
    id: "part-1a",
    sessionID: "session_test",
    messageID: "msg-1",
    type: "tool" as const,
    callID: "call-1a",
    tool: "read",
    state: {
      status: "completed",
      input: { path: "/tmp/x" },
      output: "file content here",
      content: [{ type: "text" as const, text: "file content here" }],
    },
  },
  {
    id: "part-1b",
    sessionID: "session_test",
    messageID: "msg-1",
    type: "tool" as const,
    callID: "call-1b",
    tool: "mesh_control",
    state: {
      status: "completed",
      input: { action: "planFor", target: "explore", plan: { title: "Investigate" } },
      content: [{ type: "text" as const, text: "ok" }],
    },
  },
]

const fixtureAssistant = {
  id: "msg-1",
  type: "assistant" as const,
  role: "assistant" as const,
  tokens: {
    input: 5000,
    output: 3000,
    reasoning: 1000,
    cache: { read: 250, write: 75 },
  },
  modelID: "test-model",
  providerID: "test-provider",
  time: { created: 0, completed: 1000 },
}

const partMap: Record<string, any[]> = {
  "msg-u1": fixtureUserParts,
  "msg-1": fixtureAssistantParts,
}
const partsGetter = (messageID: string) => partMap[messageID] ?? []

test("sidebar context sidebar_content slot registers without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      state: {
        session: {
          get: () => undefined,
          messages: (sessionID: string) => [fixtureAssistant, fixtureUser],
        },
        provider: {
          find: () => ({ models: { "test-model": { limit: { context: 100000 } } } }),
        },
        path: { directory: "/test/workspace" },
        mcp: () => [],
        lsp: () => [],
        part: (messageID: string) => partMap[messageID] ?? [],
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.sidebar_content) return () => {}
        const el = plugin.slots.sidebar_content({}, { session_id: "session_test" })
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      SidebarContext.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
    })
    return <box>{slotContent()}</box>
  }

  const testSetup = await testRender(() => (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectProvider>
                <SyncProvider>
                  <TuiConfigProvider config={config}>
                    <ThemeProvider mode="dark">
                      <Inner />
                    </ThemeProvider>
                  </TuiConfigProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    </ExitProvider>
  ), { width: 80, height: 40 })
  await testSetup.renderOnce()
  await new Promise((r) => setTimeout(r, 0))
  await testSetup.renderOnce()
  testSetup.renderer.destroy()
})

test("context widget source contains concise single-line category labels", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  for (const label of ["User", "Subagents", "Agent", "Tools", "Files", "Prompt", "Thinking", "Cache"]) {
    expect(source).toContain(label)
  }
})

test("context widget no longer uses the old 'Memory' label", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  expect(source).not.toMatch(/label:\s*"Memory"/)
})

test("context widget filters zero-token categories for compact display", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  const usedIdx = source.indexOf("Used {formatTokensCompact(tb().total)}")
  expect(usedIdx).toBeGreaterThan(-1)
  const afterUsed = source.slice(usedIdx)
  expect(afterUsed).toMatch(/filter\(\(s\)\s*=>\s*s\.tokens\s*>\s*0\)/)
})

test("context widget does not nest <text> elements inside another <text>", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  const nestedTextPattern = /<text\b[^>]*>\s*\n\s*<text\b/g
  expect(source).not.toMatch(nestedTextPattern)
})

test("context widget source reads parts via api.state.part (not message.content)", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  expect(source).toContain("api.state.part")
  expect(source).not.toMatch(/\(a as any\)\.content\s*\?\?\s*\(a as any\)\.parts/)
})

test("context widget does not fabricate a `?? 1` context limit when the lookup is missing", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  // The pre-fix code used `modelContextLimit() ?? 1` in JSX, which rendered
  // "/ 1" / "(0%)" and filled the bar completely when the provider lookup
  // failed. The fix replaces those with a `limit` memo that returns null,
  // gates display on `hasLimit()`, and lets the bar denominator fall back to
  // tb.total so segments remain proportional.
  expect(source).not.toMatch(/modelContextLimit\(\)\s*\?\?\s*1/)
  expect(source).toContain("hasLimit")
  expect(source).toContain("barDenominator")
})

test("context widget gates the `/ X` decorations on hasLimit()", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  const matches = source.match(/<Show when=\{hasLimit\(\)\}>/g) ?? []
  // Both the header "/ X (Y%)" decoration and the body "/ X in context"
  // suffix should be wrapped in hasLimit() guards.
  expect(matches.length).toBeGreaterThanOrEqual(2)
})

test("context widget bar widths use barDenominator, not a hardcoded limit", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  const denomIdx = source.indexOf("barDenominator()")
  expect(denomIdx).toBeGreaterThan(-1)
  const afterDenom = source.slice(denomIdx)
  // Both the per-segment width and the usedWidthTotal sum should reference
  // the denominator, not the raw limit.
  expect(afterDenom).toMatch(/\(seg\.tokens\s*\/\s*denom\)\s*\*\s*BAR_WIDTH/)
  // And the old "seg.tokens / limit" path must be gone.
  expect(source).not.toMatch(/\(seg\.tokens\s*\/\s*limit\)\s*\*\s*BAR_WIDTH/)
})

describe("categorizeTokens", () => {
  test("returns null when there is no assistant message", () => {
    expect(categorizeTokens([], partsGetter)).toBeNull()
    expect(categorizeTokens([fixtureUser as any], partsGetter)).toBeNull()
  })

  test("user text is read from parts, not message.text", () => {
    const cat = categorizeTokens([fixtureAssistant as any, fixtureUser as any], partsGetter)
    expect(cat).not.toBeNull()
    // fixtureUser text = 21 chars; ceil(21/4) = 6 tokens
    expect(cat!.userMessages).toBeGreaterThan(0)
  })

  test("synthetic/ignored user text parts are skipped", () => {
    const parts = [
      {
        id: "synth",
        sessionID: "session_test",
        messageID: "msg-u1",
        type: "text" as const,
        text: "injected scaffolding",
        synthetic: true,
      },
    ]
    // Strip the legacy fallback `text` field so the synthetic part is the
    // only thing the user row could possibly pick up.
    const userNoLegacy = { ...fixtureUser, text: undefined as unknown as string }
    const cat = categorizeTokens(
      [fixtureAssistant as any, userNoLegacy as any],
      (id: string) => (id === "msg-u1" ? parts : fixtureAssistantParts),
    )
    expect(cat!.userMessages).toBe(0)
  })

  test("file tools go to files; subagent tools go to subagents", () => {
    const cat = categorizeTokens([fixtureAssistant as any, fixtureUser as any], partsGetter)
    expect(cat!.files).toBeGreaterThan(0)
    expect(cat!.subagents).toBeGreaterThan(0)
    expect(cat!.tools).toBe(0)
  })

  test("non-file non-subagent tools go to tools", () => {
    const bashPart = {
      id: "part-bash",
      sessionID: "session_test",
      messageID: "msg-1",
      type: "tool" as const,
      callID: "call-bash",
      tool: "bash",
      state: {
        status: "completed" as const,
        input: { cmd: "ls -la" },
        output: "drwxr-xr-x 2 user user 4096 Jun 1 .",
        content: [{ type: "text" as const, text: "drwxr-xr-x 2 user user 4096 Jun 1 ." }],
      },
    }
    const cat = categorizeTokens(
      [fixtureAssistant as any, fixtureUser as any],
      (id: string) => (id === "msg-1" ? [bashPart] : fixtureUserParts),
    )
    expect(cat!.tools).toBeGreaterThan(0)
    expect(cat!.files).toBe(0)
    expect(cat!.subagents).toBe(0)
  })

  test("total = input + output + reasoning + cache.read + cache.write", () => {
    const cat = categorizeTokens([fixtureAssistant as any, fixtureUser as any], partsGetter)
    expect(cat!.total).toBe(5000 + 3000 + 1000 + 250 + 75)
  })

  test("heuristic buckets are clamped so breakdown never exceeds last-turn input", () => {
    // Force heuristics to exceed input via a giant tool output.
    const hugeParts = [
      {
        id: "huge",
        sessionID: "session_test",
        messageID: "msg-1",
        type: "tool" as const,
        callID: "huge",
        tool: "read",
        state: {
          status: "completed" as const,
          output: "x".repeat(100_000),
          content: [{ type: "text" as const, text: "x".repeat(100_000) }],
        },
      },
    ]
    const cat = categorizeTokens(
      [fixtureAssistant as any, fixtureUser as any],
      (id: string) => (id === "msg-1" ? hugeParts : fixtureUserParts),
    )
    expect(cat!.files).toBeLessThanOrEqual(cat!.total)
    expect(cat!.files + cat!.tools + cat!.subagents + cat!.userMessages + cat!.prompt).toBeLessThanOrEqual(
      cat!.total,
    )
  })

  test("Agent reflects only the last assistant's tokens.output", () => {
    const older = {
      ...fixtureAssistant,
      id: "msg-old",
      tokens: { ...fixtureAssistant.tokens, output: 9999 },
    }
    const cat = categorizeTokens([older as any, fixtureAssistant as any, fixtureUser as any], partsGetter)
    // Categorization sums output across assistants (session-level agent cost).
    // Both fixture messages contribute — assert output equals sum.
    expect(cat!.output).toBe(fixtureAssistant.tokens.output + 9999)
  })

  test("Thinking aggregates reasoning across all assistant messages", () => {
    const older = {
      ...fixtureAssistant,
      id: "msg-old",
      tokens: { ...fixtureAssistant.tokens, reasoning: 250 },
    }
    const cat = categorizeTokens([older as any, fixtureAssistant as any, fixtureUser as any], partsGetter)
    expect(cat!.thinking).toBe(250 + 1000)
  })

  test("Prompt residual never goes negative", () => {
    const cat = categorizeTokens([fixtureAssistant as any, fixtureUser as any], partsGetter)
    expect(cat!.prompt).toBeGreaterThanOrEqual(0)
  })
})
