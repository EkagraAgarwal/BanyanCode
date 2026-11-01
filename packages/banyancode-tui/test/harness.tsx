/** @jsxImportSource @opentui/solid */
import type { AgentInfo, ModelInfo, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import type {
  CodegraphLive,
  CodegraphGraph,
  IntelEntry,
  IntelLive,
  Live,
  MeshLive,
  SystemLive,
  UsageLive,
} from "../src/data/live"
import type {
  BanyanConfig,
  BuildState,
  CodegraphFile,
  CoreConfigOutput,
  GraphMeta,
  MeshNode,
  ProviderUsageSnapshot,
  ReadinessResult,
  SystemStatus,
  ToolUsageRow,
  YoloStatus,
} from "../src/data/pending-rpc"

const COLOR = RGBA.fromInts(200, 200, 200)

export const theme = {
  text: {
    base: COLOR,
    muted: COLOR,
    faint: COLOR,
    feedback: {
      error: { base: COLOR, muted: COLOR },
      warning: { base: COLOR, muted: COLOR },
      success: { base: COLOR, muted: COLOR },
      info: { base: COLOR, muted: COLOR },
    },
  },
  hue: {
    interactive: { 100: COLOR, 200: COLOR, 300: COLOR, 400: COLOR, 500: COLOR, 600: COLOR, 700: COLOR, 800: COLOR, 900: COLOR },
    accent: { 100: COLOR, 200: COLOR, 300: COLOR, 400: COLOR, 500: COLOR, 600: COLOR, 700: COLOR, 800: COLOR, 900: COLOR },
    neutral: { 100: COLOR, 200: COLOR, 300: COLOR, 400: COLOR, 500: COLOR, 600: COLOR, 700: COLOR, 800: COLOR, 900: COLOR },
  },
  border: { base: COLOR },
  background: { base: COLOR, raised: { base: COLOR, high: COLOR, max: COLOR } },
} as unknown as ResolvedTheme

let ids = 0

export function session(input: Partial<SessionInfo> & { readonly id?: string } = {}): SessionInfo {
  ids += 1
  return {
    id: input.id ?? `ses_test${ids}`,
    projectID: "prj_test",
    agent: "build",
    title: `session ${ids}`,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, updated: 2_000 },
    location: { directory: "D:/workspace" },
    ...input,
  } as SessionInfo
}

export function assistant(messages: ReadonlyArray<{ readonly name: string }> = []): SessionMessageInfo {
  return {
    id: "msg_test",
    type: "assistant",
    time: { created: 1_000, completed: 2_000 },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    content: messages.map((message, index) => ({
      type: "tool" as const,
      id: `tool_${index}`,
      name: message.name,
      state: { status: "completed" as const, input: {}, output: "", metadata: {} },
      time: { created: 1_000 },
    })),
  } as unknown as SessionMessageInfo
}

export function context(input: {
  readonly sessions?: readonly SessionInfo[]
  readonly messages?: Readonly<Record<string, readonly SessionMessageInfo[]>>
  readonly running?: ReadonlySet<string>
  readonly directory?: string
  readonly agents?: readonly AgentInfo[]
  readonly models?: readonly ModelInfo[]
} = {}): Context {
  const sessions = input.sessions ?? []
  const running = input.running ?? new Set<string>()
  const messages = input.messages ?? {}
  const find = (id: string) => sessions.find((item) => item.id === id)
  const root = (id: string) => {
    let current = id
    const seen = new Set<string>()
    while (!seen.has(current)) {
      seen.add(current)
      const parent = find(current)?.parentID
      if (!parent) break
      current = parent
    }
    return current
  }
  return {
    theme,
    app: { version: "0.0.0", channel: "test" },
    location: { directory: input.directory ?? "D:/workspace" },
    options: {},
    renderer: {},
    client: {},
    data: {
      on: () => () => {},
      listen: () => () => {},
      session: {
        list: () => [...sessions],
        get: (id: string) => find(id),
        root,
        family: (id: string) => {
          const base = root(id)
          return [base, ...sessions.filter((item) => item.parentID === base).map((item) => item.id)]
        },
        cost: (id: string) => find(id)?.cost ?? 0,
        status: (id: string) => (running.has(id) ? "running" : "idle"),
        sync: async () => {},
        invalidate: () => {},
        pending: { list: () => [], sync: async () => {}, invalidate: () => {} },
        message: {
          list: (id: string) => [...(messages[id] ?? [])],
          get: (id: string, messageID: string) => (messages[id] ?? []).find((item) => item.id === messageID),
          sync: async () => {},
          invalidate: () => {},
        },
        permission: { list: () => [], sync: async () => {}, invalidate: () => {} },
        form: {
          list: () => [],
          sync: async () => {},
          invalidate: () => {},
          reply: async () => {},
          cancel: async () => {},
        },
      },
      project: { list: () => [], get: () => undefined, sync: async () => {}, invalidate: () => {}, permission: { list: () => [], sync: async () => {}, invalidate: () => {} } },
      shell: { list: () => [], get: () => undefined, sync: async () => {}, invalidate: () => {} },
      location: {
        default: () => ({ directory: input.directory ?? "D:/workspace" }),
        sync: async () => {},
        invalidate: () => {},
        vcs: { info: () => ({ branch: { current: "v2-base" } }), sync: async () => {}, invalidate: () => {} },
        agent: { list: () => [...(input.agents ?? [])], sync: async () => {}, invalidate: () => {} },
        command: { list: () => [], sync: async () => {}, invalidate: () => {} },
        integration: { list: () => [], sync: async () => {}, invalidate: () => {} },
        mcp: { server: { list: () => [], sync: async () => {}, invalidate: () => {} }, resource: { list: () => [], sync: async () => {}, invalidate: () => {} } },
        model: { list: () => [...(input.models ?? [])], sync: async () => {}, invalidate: () => {} },
        provider: { list: () => [], sync: async () => {}, invalidate: () => {} },
        reference: { list: () => [], sync: async () => {}, invalidate: () => {} },
        skill: { list: () => [], sync: async () => {}, invalidate: () => {} },
      },
    },
    attention: { notify: async () => ({ ok: true, notification: false, sound: false }) },
    keymap: {
      layer: () => {},
      dispatch: () => {},
      shortcuts: () => [],
      commands: () => [],
      pending: () => [],
      active: () => [],
      mode: { current: () => "base", push: () => () => {} },
    },
    storage: {
      store: (_key: string, options: { readonly initial: object }) => [options.initial, async () => {}],
      memory: (_key: string, options: { readonly initial: object }) => [options.initial, () => {}],
    },
    ui: {
      slot: () => () => {},
      router: { register: () => () => {}, navigate: () => {}, current: () => ({ type: "home" }) },
      panel: { open: () => true, close: () => {}, current: () => undefined },
      tabs: { enabled: () => false, list: () => [], open: () => false, focus: () => false, move: () => false, close: () => false },
      dialog: { show: () => {}, set: () => {}, clear: () => {}, alert: async () => {}, confirm: async () => false, prompt: async () => undefined, select: async () => undefined },
      toast: { show: () => {} },
      format: { path: (value: string) => value },
      model: { current: () => undefined, variant: { list: () => [], set: () => false } },
    },
    markdown: { registerCodeBlockRenderer: () => () => {} },
    themeMode: "dark",
  } as unknown as Context
}

function accessor<T>(value: T) {
  return () => value
}

const noop = async () => {}

export function codegraphLive(input: {
  readonly availability?: "unknown" | "available" | "unavailable"
  readonly build?: BuildState
  readonly readiness?: ReadinessResult
  readonly meta?: GraphMeta
  readonly graph?: CodegraphGraph
  readonly graphLoading?: boolean
  readonly files?: readonly CodegraphFile[]
} = {}): CodegraphLive {
  return {
    availability: accessor(input.availability ?? "available"),
    error: accessor(undefined),
    build: accessor(input.build),
    readiness: accessor(input.readiness),
    autoUpdate: accessor(undefined),
    meta: accessor(input.meta),
    graph: accessor(input.graph),
    graphAvailability: accessor("available"),
    graphLoading: accessor(input.graphLoading ?? false),
    files: accessor(input.files),
    filesAvailability: accessor("available"),
    refresh: noop,
    ensureGraph: noop,
    ensureFiles: noop,
    start: async () => ({ ok: true, value: {} as BuildState }),
    cancel: async () => ({ ok: true, value: {} as BuildState }),
    remove: async () => ({ ok: true, value: {} }),
    forceKill: async () => ({ ok: true, value: { ok: true, message: "killed" } }),
  }
}

export function meshNode(input: Partial<MeshNode> & { readonly sessionID: string }): MeshNode {
  return {
    state: "idle",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    createdAt: 1_000,
    updatedAt: 2_000,
    children: [],
    ...input,
  } as MeshNode
}

export function meshLive(input: {
  readonly availability?: "unknown" | "available" | "unavailable"
  readonly root?: MeshNode
  readonly maxSubagents?: number
  readonly swarmMode?: boolean
} = {}): MeshLive {
  const limits =
    input.maxSubagents === undefined && input.swarmMode === undefined
      ? undefined
      : {
          maxSubagents: input.maxSubagents ?? 5,
          backgroundSubagents: true,
          swarmMode: input.swarmMode ?? false,
          maxSubagentsLimit: 20,
          maxSubagentsDefault: 5,
        }
  return {
    availability: accessor(input.availability ?? "available"),
    error: accessor(undefined),
    root: () => input.root,
    ensure: noop,
    limits: accessor(limits),
    swarmMode: accessor(input.swarmMode),
    refreshLimits: noop,
    setLimits: async (next) => ({
      ok: true,
      value: {
        maxSubagents: next.maxSubagents ?? limits?.maxSubagents ?? 5,
        backgroundSubagents: true,
        swarmMode: next.swarmMode ?? limits?.swarmMode ?? false,
        maxSubagentsLimit: 20,
        maxSubagentsDefault: 5,
      },
    }),
    steer: async () => ({ ok: true, value: { delivered: 1 } }),
    kill: async () => ({ ok: true, value: { killed: 1 } }),
  }
}

export function systemLive(
  input: {
    readonly status?: SystemStatus
    readonly availability?: "unknown" | "available" | "unavailable"
    readonly lsp?: { readonly enabled: boolean; readonly servers: ReadonlyArray<{ readonly id: string; readonly status: "configured" | "connected" | "error"; readonly languages: readonly string[]; readonly inert: boolean; readonly disabled: boolean }> }
    readonly yolo?: boolean
  } = {},
): SystemLive {
  return {
    availability: accessor(input.availability ?? "available"),
    status: accessor(input.status),
    lsp: accessor(input.lsp),
    lspAvailability: accessor(input.lsp === undefined ? "unavailable" : "available"),
    yolo: accessor(input.yolo),
    yoloAvailability: accessor(input.yolo === undefined ? "unavailable" : "available"),
    refresh: noop,
    refreshLsp: noop,
    refreshYolo: noop,
    setYolo: async () => ({ ok: true, value: { enabled: false, env: false, config: false } as YoloStatus }),
    agentOverride: async () => ({ ok: true, value: {} as BanyanConfig }),
    agentPrompt: async () => ({ ok: true, value: {} as BanyanConfig }),
    agentSave: async () => ({ ok: true, value: { ok: true, filePath: "" } }),
  }
}

export function usageLive(input: {
  readonly tools?: readonly ToolUsageRow[]
  readonly providers?: readonly ProviderUsageSnapshot[]
  readonly availability?: "unknown" | "available" | "unavailable"
} = {}): UsageLive {
  return {
    toolsAvailability: accessor(input.availability ?? "available"),
    providersAvailability: accessor(input.availability ?? "available"),
    error: accessor(undefined),
    tools: () => input.tools,
    providers: () => input.providers,
    refreshTools: noop,
    refreshProviders: noop,
  }
}

export function intelLive(input: { readonly entries?: readonly IntelEntry[] } = {}): IntelLive {
  return {
    entries: accessor(input.entries ?? []),
    push: () => {},
  }
}

export function live(input: {
  readonly codegraph?: CodegraphLive
  readonly mesh?: MeshLive
  readonly system?: SystemLive
  readonly usage?: UsageLive
  readonly intel?: IntelLive
  readonly core?: {
    readonly status?: CoreConfigOutput
    readonly config?: BanyanConfig
    readonly availability?: "unknown" | "available" | "unavailable"
  }
} = {}): Live {
  const config = input.core?.config
  return {
    core: {
      availability: accessor(input.core?.availability ?? "available"),
      status: accessor(input.core?.status),
      config: accessor(config),
      refresh: noop,
    },
    codegraph: input.codegraph ?? codegraphLive(),
    mesh: input.mesh ?? meshLive(),
    system: input.system ?? systemLive(),
    usage: input.usage ?? usageLive(),
    intel: input.intel ?? intelLive(),
    dispose: () => {},
  }
}

export async function mount(element: () => JSX.Element, options: { readonly width?: number; readonly height?: number } = {}) {
  const app = await testRender(element, { width: options.width ?? 60, height: options.height ?? 24 })
  await app.renderOnce()
  return app
}
