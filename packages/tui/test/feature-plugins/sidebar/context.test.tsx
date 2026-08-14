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

const ctxModule = await import("../../../src/feature-plugins/sidebar/context" as any)
const {
  categorizeTokens,
  sumToolTokens,
  allocateBarWidths,
  taskSpawnPromptTokens,
  estimateTokens,
  mergeBreakdown,
  withResidual,
  buildSegments,
} = (ctxModule.__test ?? ctxModule.default?.__test) as {
  categorizeTokens: any
  sumToolTokens: any
  allocateBarWidths: any
  taskSpawnPromptTokens: any
  estimateTokens: any
  mergeBreakdown: any
  withResidual: any
  buildSegments: any
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

const fixtureTaskPart = {
  id: "part-task",
  sessionID: "session_test",
  messageID: "msg-1",
  type: "tool" as const,
  callID: "call-task",
  tool: "task",
  state: {
    status: "completed",
    input: { prompt: "investigate the auth module", subagent_type: "explore" },
    output: "<task_result>" + "x".repeat(10_000) + "</task_result>",
    content: [{ type: "text" as const, text: "<task_result>" + "x".repeat(10_000) + "</task_result>" }],
  },
}

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
  fixtureTaskPart,
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

const fixtureBreakdown = { base: 100, agent: 50, codegraph: 200, tools: 300 }

const breakdownAssistantParts = [
  ...fixtureAssistantParts,
  {
    id: "part-finish",
    sessionID: "session_test",
    messageID: "msg-1",
    type: "step-finish" as const,
    tokens: { breakdown: fixtureBreakdown },
  },
]

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
  for (const label of [
    "System",
    "Codegraph & Orchestration",
    "Tool Definitions",
    "Tool Calls",
    "Files",
    "Conversation",
    "Subagents",
    "Cache",
    "Output",
    "Other",
  ]) {
    expect(source).toContain(label)
  }
  expect(source).not.toMatch(/label:\s*"Agent"/)
})

test("context widget folds provider breakdown keys into consolidated rows", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  for (const label of ["System", "Codegraph & Orchestration", "Tool Definitions"]) {
    expect(source).toContain(label)
  }
  // Per-key rows are gone: base/agent/etc. fold into System, codegraph and
  // orchestration into one row, and the residual is named "Other".
  expect(source).not.toMatch(/label:\s*"Base"/)
  expect(source).not.toMatch(/label:\s*"Agent"/)
  expect(source).not.toContain("Overhead")
})

test("cache is a bar segment with its own row, never a percentage chip", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  // Design B: cache is a first-class non-overlapping segment (own bar slice
  // and legend row), so heuristic buckets never double-count it.
  expect(source).toMatch(/key:\s*"cache"/)
  expect(source).toMatch(/label:\s*"Cache"/)
  // The old "cached · included in input" chip is gone — cache has a row.
  expect(source).not.toContain("cached · included in input")
  expect(source).not.toMatch(/tb\(\)\.cache\s*>\s*0/)
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
  // The segments list filters out zero-token categories so the per-line
  // breakdown stays compact even when several buckets are empty.
  expect(source).toMatch(/filter\(\(s\)\s*=>\s*s\.tokens\s*>\s*0\)/)
  // The header row (above the bar) is the single source of truth for the
  // context total — there is no longer a redundant "Used ... in context"
  // line below the bar.
  expect(source).not.toContain("Used {formatTokensCompact(tb().total)}")
  expect(source).not.toContain("in context")
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
  expect(matches.length).toBeGreaterThanOrEqual(1)
})

test("context widget bar layout uses reactive barDenominator via createMemo", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  expect(source).toContain("const barLayout = createMemo")
  expect(source).toContain("allocateBarWidths(active, tb.total, barDenominator()")
  expect(source).not.toMatch(/const denom = barDenominator\(\)/)
})

test("context widget bar segments use flexShrink={0}", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/context.tsx"),
    "utf8",
  )
  expect(source).toContain("flexShrink={0}")
})

describe("allocateBarWidths", () => {
  test("segment widths plus empty always equal BAR_WIDTH", () => {
    const BAR_WIDTH = 24
    const denom = 1_000_000
    const cases = [
      [{ tokens: 7600 }],
      [
        { tokens: 1100 },
        { tokens: 8800 },
        { tokens: 43900 },
      ],
      [
        { tokens: 117 },
        { tokens: 29700 },
        { tokens: 455900 },
      ],
    ]
    for (const segs of cases) {
      const total = segs.reduce((sum: number, s) => sum + s.tokens, 0)
      const widths = allocateBarWidths(segs, total, denom, BAR_WIDTH)
      const used = widths.reduce((sum: number, w: number) => sum + w, 0)
      expect(used + Math.max(0, BAR_WIDTH - used)).toBe(BAR_WIDTH)
      expect(used).toBeLessThanOrEqual(BAR_WIDTH)
    }
  })

  test("low usage yields zero-width colored segments", () => {
    const widths = allocateBarWidths([{ tokens: 7600 }], 7600, 1_000_000, 24)
    expect(widths.reduce((sum: number, w: number) => sum + w, 0)).toBe(0)
  })
})

describe("categorizeTokens", () => {
  test("returns null when there is no assistant message", () => {
    expect(categorizeTokens([], partsGetter)).toBeNull()
    expect(categorizeTokens([fixtureUser as any], partsGetter)).toBeNull()
  })

  test("user text is read from parts, not message.text", () => {
    const cat = categorizeTokens([fixtureUser as any, fixtureAssistant as any], partsGetter)
    expect(cat).not.toBeNull()
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
    const userNoLegacy = { ...fixtureUser, text: undefined as unknown as string }
    const cat = categorizeTokens(
      [userNoLegacy as any, fixtureAssistant as any],
      (id: string) => (id === "msg-u1" ? parts : fixtureAssistantParts),
    )
    expect(cat!.userMessages).toBe(0)
  })

  test("file tools go to files; task spawn prompt goes to subagents; mesh tools go to tools", () => {
    const cat = categorizeTokens([fixtureUser as any, fixtureAssistant as any], partsGetter)
    expect(cat!.files).toBeGreaterThan(0)
    expect(cat!.subagents).toBeGreaterThan(0)
    expect(cat!.tools).toBeGreaterThan(0)
    expect(cat!.subagents).toBe(estimateTokens("investigate the auth module"))
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
      [fixtureUser as any, fixtureAssistant as any],
      (id: string) => (id === "msg-1" ? [bashPart] : fixtureUserParts),
    )
    expect(cat!.tools).toBeGreaterThan(0)
    expect(cat!.files).toBe(0)
    expect(cat!.subagents).toBe(0)
  })

  test("task output does not inflate subagents bucket", () => {
    const cat = categorizeTokens([fixtureUser as any, fixtureAssistant as any], partsGetter)
    expect(cat!.subagents).toBeLessThan(100)
    expect(taskSpawnPromptTokens(fixtureTaskPart)).toBe(estimateTokens("investigate the auth module"))
  })

  test("sumToolTokens does not double-count identical output and content text", () => {
    const tool = {
      state: {
        status: "completed",
        input: { cmd: "ls" },
        output: "hello world",
        content: [{ type: "text", text: "hello world" }],
      },
    }
    expect(sumToolTokens(tool)).toBe(estimateTokens(JSON.stringify({ cmd: "ls" })) + estimateTokens("hello world"))
  })

  test("total = input + cache + output + reasoning (full context used)", () => {
    const cat = categorizeTokens([fixtureUser as any, fixtureAssistant as any], partsGetter)
    expect(cat!.total).toBe(5000 + 250 + 75 + 3000 + 1000)
  })

  test("categorizeTokens returns raw heuristic estimates; buildSegments clamps them", () => {
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
      [fixtureUser as any, fixtureAssistant as any],
      (id: string) => (id === "msg-1" ? hugeParts : fixtureUserParts),
    )!
    // Raw estimate preserved in categorizeTokens (100_000 chars / 4).
    expect(cat.files).toBe(25_000)
    // buildSegments clamps the file row to the un-attributed non-cached
    // input: inputTotal (5000) - breakdown (0) - userMessages - cache (325).
    const segs = buildSegments(cat)
    const filesRow = segs.find((s: any) => s.key === "files")
    expect(filesRow.tokens).toBeLessThanOrEqual(5000 - 325)
    // Rows never exceed the total context; percentages can never pass 100%.
    const accounted = segs.reduce((sum: number, s: any) => sum + s.tokens, 0)
    expect(accounted).toBeLessThanOrEqual(cat.total)
    for (const s of segs) {
      expect(s.tokens / cat.total).toBeLessThanOrEqual(1)
    }
    // cacheRead/cacheWrite are zeroed in the return; cache rides its own row.
    expect(cat.cacheRead).toBe(0)
    expect(cat.cacheWrite).toBe(0)
    expect(segs.find((s: any) => s.key === "cache").tokens).toBe(325)
  })

  test("Output sums tokens.output across all assistant messages", () => {
    const older = {
      ...fixtureAssistant,
      id: "msg-old",
      tokens: { ...fixtureAssistant.tokens, output: 9999 },
    }
    const cat = categorizeTokens([fixtureUser as any, older as any, fixtureAssistant as any], partsGetter)
    expect(cat!.output).toBe(fixtureAssistant.tokens.output + 9999)
  })

  test("Thinking aggregates reasoning across all assistant messages", () => {
    const older = {
      ...fixtureAssistant,
      id: "msg-old",
      tokens: { ...fixtureAssistant.tokens, reasoning: 250 },
    }
    const cat = categorizeTokens([fixtureUser as any, older as any, fixtureAssistant as any], partsGetter)
    expect(cat!.thinking).toBe(250 + 1000)
  })

  test("streaming assistant with zero input keeps prior turn input breakdown", () => {
    const streaming = {
      ...fixtureAssistant,
      id: "msg-stream",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 2000 },
    }
    const cat = categorizeTokens(
      [fixtureUser as any, fixtureAssistant as any, streaming as any],
      (id: string) => partMap[id] ?? [],
    )
    expect(cat!.files).toBeGreaterThan(0)
    // cacheRead/cacheWrite are zeroed in the return; cache is implicit in basis.
    expect(cat!.cacheRead).toBe(0)
    expect(cat!.cacheWrite).toBe(0)
    expect(cat!.output).toBe(3000)
  })

  test("step-finish breakdown feeds the consolidated System row", () => {
    const cat = categorizeTokens(
      [fixtureUser as any, fixtureAssistant as any],
      (id: string) => (id === "msg-1" ? breakdownAssistantParts : fixtureUserParts),
    )!
    expect(cat.breakdown).toEqual(fixtureBreakdown)
    expect(cat.breakdown!.tools).toBe(300)
    // basis = input (5000) + cache (250 + 75) = 5325.
    expect(cat.basis).toBe(5000 + 250 + 75)
    // total = full context used, cache included.
    expect(cat.total).toBe(5000 + 250 + 75 + 3000 + 1000)
    const segs = buildSegments(cat)
    const byKey = Object.fromEntries(segs.map((s: any) => [s.key, s.tokens]))
    expect(byKey.system).toBe(150) // base 100 + agent 50
    expect(byKey.codegraphOrchestration).toBe(200)
    expect(byKey.toolDefinitions).toBe(300)
    expect(byKey.cache).toBe(325)
    expect(byKey.output).toBe(4000) // output 3000 + reasoning 1000
  })

  test("cache tokens are reported as a dedicated Cache row while cacheRead/cacheWrite stay zeroed", () => {
    const cat = categorizeTokens([fixtureUser as any, fixtureAssistant as any], partsGetter)!
    expect(cat.cache).toBe(250 + 75)
    expect(cat.cacheRead).toBe(0)
    expect(cat.cacheWrite).toBe(0)
    const segs = buildSegments(cat)
    expect(segs.find((s: any) => s.key === "cache").tokens).toBe(325)
  })

  test("cache-heavy sessions clamp heuristic rows to zero and show Cache as the truth", () => {
    const cacheHeavyAssistant = {
      id: "msg-1",
      type: "assistant" as const,
      role: "assistant" as const,
      tokens: {
        input: 100,
        output: 200,
        reasoning: 0,
        cache: { read: 5000, write: 0 },
      },
      modelID: "test-model",
      providerID: "test-provider",
      time: { created: 0, completed: 1000 },
    }
    // 20_000 chars / 4 chars-per-token = 5000 estimated tokens for the file bucket.
    const fileHeavyParts = [
      {
        id: "file-heavy",
        sessionID: "session_test",
        messageID: "msg-1",
        type: "tool" as const,
        callID: "file-heavy",
        tool: "read",
        state: {
          status: "completed" as const,
          output: "x".repeat(20_000),
          content: [{ type: "text" as const, text: "x".repeat(20_000) }],
        },
      },
    ]
    const cat = categorizeTokens(
      [fixtureUser as any, cacheHeavyAssistant as any],
      (id: string) => (id === "msg-1" ? fileHeavyParts : fixtureUserParts),
    )!
    // Raw estimate preserved (the estimate itself is not clamped).
    expect(cat.files).toBe(5000)
    expect(cat.cache).toBe(5000)
    expect(cat.total).toBe(100 + 5000 + 200)
    // Design B: the file row clamps to the un-attributed NON-cached input
    // (100 - 0 - userMessages - 5000 = 0); cache owns the bar.
    const segs = buildSegments(cat)
    const byKey = Object.fromEntries(segs.map((s: any) => [s.key, s.tokens]))
    expect(byKey.files).toBe(0)
    expect(byKey.cache).toBe(5000)
    const accounted = segs.reduce((sum: number, s: any) => sum + s.tokens, 0)
    expect(accounted).toBeLessThanOrEqual(cat.total)
    for (const s of segs) {
      expect(s.tokens / cat.total).toBeLessThanOrEqual(1)
    }
  })

  test("real-world cache-heavy session: percentages stay sane and header shows total context used", () => {
    // Reproduction of the reported bug: CONTEXT 67.3k / 1M (7%) with a 346.6k
    // cache and nonsense percentages (>100%). Under Design B the header and
    // every row use the FULL context (input + cache + output + reasoning).
    const assistant = {
      id: "msg-1",
      type: "assistant" as const,
      role: "assistant" as const,
      tokens: {
        input: 67_300,
        output: 300,
        reasoning: 100,
        cache: { read: 346_000, write: 600 },
      },
      modelID: "test-model",
      providerID: "test-provider",
      time: { created: 0, completed: 1000 },
    }
    const toolParts = [
      {
        id: "part-read",
        sessionID: "session_test",
        messageID: "msg-1",
        type: "tool" as const,
        callID: "read",
        tool: "read",
        state: {
          status: "completed" as const,
          output: "y".repeat(80_000),
          content: [{ type: "text" as const, text: "y".repeat(80_000) }],
        },
      },
    ]
    const userParts = [
      {
        id: "part-u1",
        sessionID: "session_test",
        messageID: "msg-u1",
        type: "text" as const,
        text: "z".repeat(4_000),
      },
    ]
    const cat = categorizeTokens(
      [fixtureUser as any, assistant as any],
      (id: string) => (id === "msg-1" ? toolParts : userParts),
    )!
    const totalContext = 67_300 + 346_600 + 300 + 100
    expect(cat.total).toBe(totalContext)
    // The file estimate (80_000/4 = 20_000) exceeds the un-attributed
    // non-cached input (67_300 - 20_000 user chars/4 - 346_600 = 0), so the
    // file row clamps to zero and cache tells the truth.
    const segs = buildSegments(cat)
    const byKey = Object.fromEntries(segs.map((s: any) => [s.key, s.tokens]))
    expect(byKey.files).toBe(0)
    expect(byKey.cache).toBe(346_600)
    let accounted = 0
    for (const s of segs) {
      accounted += s.tokens
      expect(s.tokens / cat.total).toBeLessThanOrEqual(1)
    }
    expect(accounted).toBeLessThanOrEqual(cat.total)
    // The header percentage (contextPercent) is total/limit — same total.
    expect(cat.total / 1_000_000).toBeLessThan(0.5)
  })
})

describe("mergeBreakdown", () => {
  test("folds system-ish keys into System and codegraph/orchestration into one row", () => {
    const merged = mergeBreakdown({
      base: 100,
      agent: 50,
      user: 25,
      environment: 10,
      instructions: 5,
      skills: 5,
      structuredOutput: 5,
      codegraph: 200,
      orchestration: 50,
      tools: 300,
    })
    expect(merged.system).toBe(200)
    expect(merged.codegraphOrchestration).toBe(250)
    expect(merged.toolDefinitions).toBe(300)
  })

  test("skips unknown and non-positive keys", () => {
    const merged = mergeBreakdown({ base: 0, unknown: 100 })
    expect(merged.system).toBeUndefined()
  })

  test("returns an empty map when there is no breakdown", () => {
    expect(mergeBreakdown(undefined)).toEqual({})
  })
})

describe("withResidual", () => {
  const seg = (tokens: number) => ({ key: "files", label: "Files", tokens, color: "success" as const })

  test("shows Other when unaccounted tokens exceed 5% of basis", () => {
    const out = withResidual([seg(100)], 1000)
    expect(out).toHaveLength(2)
    expect(out[out.length - 1]).toMatchObject({ label: "Other", tokens: 900 })
  })

  test("hides Other when unaccounted tokens are at most 5% of basis", () => {
    expect(withResidual([seg(960)], 1000)).toHaveLength(1)
    expect(withResidual([seg(950)], 1000)).toHaveLength(1)
  })

  test("never goes negative", () => {
    expect(withResidual([seg(2000)], 1000)).toHaveLength(1)
  })
})
