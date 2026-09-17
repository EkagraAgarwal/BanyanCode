/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { readFileSync } from "fs"
import { resolve } from "path"
import SidebarProviderUsage, {
  PROVIDER_USAGE_ORDER,
  PROVIDER_USAGE_POLL_MS,
  asciiBar,
  formatBalance,
  formatCountdown,
  orderSnapshots,
  remainderText,
  statusLine,
  windowPercent,
  windowRowText,
  View,
  type ProviderUsageSnapshot,
} from "../../../src/feature-plugins/sidebar/provider-usage"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"

function readPlugin(): string {
  return readFileSync(resolve(__dirname, "../../../src/feature-plugins/sidebar/provider-usage.tsx"), "utf8")
}

function snap(overrides: Partial<ProviderUsageSnapshot> & { providerID: string }): ProviderUsageSnapshot {
  return {
    displayName: overrides.providerID,
    status: "available",
    confidence: "exact",
    windows: [],
    fetchedAt: Date.now(),
    ...overrides,
  }
}

// Exact windows: remaining percent + reset countdown.
test("exact window renders percent bar and countdown", () => {
  const w = { id: "w", label: "5h", kind: "quota" as const, remainingPercent: 68, resetsAt: 2 * 3600_000 + 14 * 60_000 }
  expect(windowPercent(w)).toBe(68)
  expect(remainderText(w)).toBe("68%")
  expect(asciiBar(68)).toBe("██████░░░")
  expect(windowRowText(w, 0)).toBe("5h  ██████░░░  68%  2h14m")
})

// Reported windows: count-based rate limits show remaining/limit.
test("reported count-based window renders remaining/limit", () => {
  const w = { id: "r", label: "req", kind: "rate_limit" as const, remaining: 42, limit: 60 }
  expect(windowPercent(w)).toBe(70)
  expect(remainderText(w)).toBe("42/60")
  expect(windowRowText(w, 0)).toBe("req  ██████░░░  42/60")
})

// Derived percent from usedPercent; clamping of malformed values.
test("usedPercent derives remaining and clamps malformed input", () => {
  expect(windowPercent({ id: "a", label: "x", kind: "quota", usedPercent: 25 })).toBe(75)
  expect(windowPercent({ id: "b", label: "x", kind: "quota", usedPercent: 140 })).toBe(0)
  expect(windowPercent({ id: "c", label: "x", kind: "quota", remainingPercent: -5 })).toBe(0)
  expect(windowPercent({ id: "d", label: "x", kind: "quota" })).toBeUndefined()
  expect(remainderText({ id: "e", label: "x", kind: "quota" })).toBeUndefined()
  expect(asciiBar(0)).toBe("░".repeat(9))
  expect(asciiBar(100)).toBe("█".repeat(9))
})

// Unknown windows keep the provider-supplied label.
test("unknown windows preserve provider-supplied label", () => {
  const w = { id: "spark", label: "spark-extra", kind: "quota" as const, remainingPercent: 50 }
  expect(windowRowText(w, 0)).toContain("spark-extra")
})

test("formatCountdown covers seconds/minutes/hours/day spans", () => {
  expect(formatCountdown(45_000)).toBe("45s")
  expect(formatCountdown(5 * 60_000)).toBe("5m")
  expect(formatCountdown((3 * 3600 + 42 * 60) * 1000)).toBe("3h42m")
  expect(formatCountdown(3 * 3600_000)).toBe("3h")
  expect(formatCountdown((4 * 24 * 3600 + 8 * 3600) * 1000)).toBe("4d8h")
  expect(formatCountdown(18 * 24 * 3600_000)).toBe("18d")
  expect(formatCountdown(-1000)).toBe("now")
})

// Unauthenticated / unsupported / error states.
test("statusLine renders Not connected / Usage unavailable / concise error", () => {
  expect(statusLine(snap({ providerID: "a", status: "unauthenticated" }))).toBe("Not connected")
  expect(statusLine(snap({ providerID: "b", status: "unsupported" }))).toBe("Usage unavailable")
  expect(statusLine(snap({ providerID: "c", status: "error" }))).toBe("Couldn't load usage")
  const long = `x`.repeat(200)
  const line = statusLine(snap({ providerID: "d", status: "error", message: long }))
  expect(line.length).toBeLessThanOrEqual(80)
  expect(statusLine(snap({ providerID: "e", status: "available" }))).toBe("")
})

test("formatBalance includes currency when present", () => {
  expect(formatBalance({ remaining: 12.5, currency: "USD" })).toBe("12.5 USD")
  expect(formatBalance({ remaining: 3 })).toBe("3")
})

// Ordering: active provider first, then status rank, then name.
test("orderSnapshots puts active first, then available, then unavailable", () => {
  const list = [
    snap({ providerID: "gemini", displayName: "Gemini", status: "unsupported" }),
    snap({ providerID: "openai", displayName: "OpenAI", status: "unauthenticated" }),
    snap({ providerID: "chatgpt", displayName: "ChatGPT", status: "available" }),
    snap({ providerID: "go", displayName: "OpenCode Go", status: "stale" }),
  ]
  expect(orderSnapshots(list, "go").map((s) => s.providerID)).toEqual(["go", "chatgpt", "openai", "gemini"])
  expect(orderSnapshots(list).map((s) => s.providerID)).toEqual(["chatgpt", "go", "openai", "gemini"])
})

test("order constant is 135 (directly after System Resources at 130)", () => {
  expect(PROVIDER_USAGE_ORDER).toBe(135)
  expect(PROVIDER_USAGE_POLL_MS).toBe(60_000)
  const source = readPlugin()
  expect(source).toContain("order: PROVIDER_USAGE_ORDER")
})

test("widget is registered in builtins directly after System Resources", () => {
  const source = readFileSync(resolve(__dirname, "../../../src/feature-plugins/builtins.ts"), "utf8")
  expect(source).toContain('import SidebarProviderUsage from "./sidebar/provider-usage"')
  const sysIdx = source.indexOf("SidebarSystemStatus,")
  const usageIdx = source.indexOf("SidebarProviderUsage,")
  expect(sysIdx).toBeGreaterThanOrEqual(0)
  expect(usageIdx).toBeGreaterThan(sysIdx)
})

// Spacing contract: root gap=0, no leading margin, one-row bars.
test("provider-usage honors the compact spacing contract", () => {
  const source = readPlugin()
  expect(source).toContain("gap={0}")
  expect(source).not.toMatch(/marginTop=\{1\}/)
  expect(source).not.toContain("paddingTop={1}")
  expect(source).not.toContain("paddingBottom={1}")
})

// Lifecycle: fetch on mount, 60s poll, event refresh, full cleanup.
test("widget fetches on mount, polls, subscribes, and cleans up", () => {
  const source = readPlugin()
  expect(source).toContain("onMount(() => void fetchList())")
  expect(source).toContain("setInterval(() => void fetchList(), PROVIDER_USAGE_POLL_MS)")
  for (const evt of ["session.idle", "session.updated", "account.added", "account.removed", "account.switched", "server.connected"]) {
    expect(source).toContain(`"${evt}"`)
  }
  expect(source).toContain("onCleanup(() => {")
  expect(source).toContain("clearInterval(poll)")
  expect(source).toContain("clearInterval(tick)")
  expect(source).toContain("for (const unsub of unsubs) unsub()")
})

test("widget uses the generated provider usage SDK namespace", () => {
  const source = readPlugin()
  expect(source).toContain("sdk.client.global.providerUsage.list()")
  expect(source).toContain("sdk.client.global.providerUsage.refresh()")
  expect(source).not.toContain("TEMP-SDK")
  expect(source).not.toContain("ProviderUsageGlobalEndpoints")
  expect(source).not.toMatch(/as any/)
})

async function renderView(opts: { snapshots?: ProviderUsageSnapshot[]; width?: number }) {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/global/provider-usage") return json({ snapshots: opts.snapshots ?? [] })
    if (url.pathname === "/global/provider-usage/refresh") return json({ snapshots: opts.snapshots ?? [] })
    return undefined
  })
  const config = createTuiResolvedConfig()
  const api = createTuiPluginApi({})
  const setup = await testRender(() => (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectProvider>
                <SyncProvider>
                  <TuiConfigProvider config={config}>
                    <ThemeProvider mode="dark">
                      <View api={api} session_id="ses_test" />
                    </ThemeProvider>
                  </TuiConfigProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    </ExitProvider>
  ), { width: opts.width ?? 80, height: 40 })
  await setup.renderOnce()
  await new Promise((r) => setTimeout(r, 150))
  await setup.renderOnce()
  await new Promise((r) => setTimeout(r, 50))
  await setup.renderOnce()
  return { frame: setup.captureCharFrame(), destroy: () => setup.renderer.destroy(), events }
}

const MULTI: ProviderUsageSnapshot[] = [
  snap({
    providerID: "chatgpt",
    displayName: "ChatGPT",
    status: "available",
    confidence: "exact",
    fetchedAt: Date.now(),
    windows: [{ id: "w", label: "5h", kind: "quota", remainingPercent: 68, resetsAt: Date.now() + 2 * 3600_000 }],
  }),
  snap({ providerID: "gemini", displayName: "Gemini", status: "unsupported", confidence: "exact", fetchedAt: Date.now() }),
  snap({ providerID: "custom", displayName: "Custom", status: "unauthenticated", confidence: "exact", fetchedAt: Date.now() }),
]

test("renders multiple providers with exact, unavailable, and unauthenticated states", async () => {
  const { frame, destroy } = await renderView({ snapshots: MULTI })
  try {
    expect(frame).toContain("USAGE")
    expect(frame).toContain("ChatGPT")
    expect(frame).toContain("Gemini")
    expect(frame).toContain("Usage unavailable")
    expect(frame).toContain("Not connected")
  } finally {
    destroy()
  }
})

test("stale snapshot is preserved and labelled", async () => {
  const { frame, destroy } = await renderView({
    snapshots: [
      snap({
        providerID: "go",
        displayName: "OpenCode Go",
        status: "stale",
        confidence: "exact",
        fetchedAt: Date.now() - 120_000,
        windows: [{ id: "w", label: "1w", kind: "quota", remainingPercent: 57 }],
      }),
    ],
  })
  try {
    expect(frame).toContain("OpenCode Go")
    expect(frame).toContain("stale")
    expect(frame).toContain("57%")
  } finally {
    destroy()
  }
})

test("orderSnapshots backfills the active provider when the server omits it", () => {
  const list = [snap({ providerID: "go", displayName: "OpenCode Go", status: "available" })]
  const ordered = orderSnapshots(list, "openai")
  expect(ordered.map((s) => s.providerID)).toEqual(["openai", "go"])
  expect(ordered[0]?.status).toBe("unsupported")
})

test("mounts at narrow width 32 without throwing", async () => {
  const { frame, destroy } = await renderView({ snapshots: MULTI, width: 32 })
  try {
    expect(typeof frame).toBe("string")
  } finally {
    destroy()
  }
})

test("empty snapshots render nothing and fail silently", async () => {
  const { frame, destroy } = await renderView({ snapshots: [] })
  try {
    expect(frame).not.toContain("USAGE")
  } finally {
    destroy()
  }
})

test("slot plugin registers order 135 via sidebar_content", async () => {
  let order = -1
  let hasSlot = false
  await (SidebarProviderUsage.tui as any)(
    {
      slots: {
        register: (def: any) => {
          order = def.order
          hasSlot = typeof def.slots?.sidebar_content === "function"
          return () => {}
        },
      },
    },
    undefined,
    { id: "test" },
  )
  expect(order).toBe(135)
  expect(hasSlot).toBe(true)
})
