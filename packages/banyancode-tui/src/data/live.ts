import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createRoot, createSignal, on, type Accessor } from "solid-js"
import {
  availabilityOf,
  attempt,
  createRpcLayer,
  type Availability,
  type Attempt,
} from "./rpc"
import type {
  AgentOverrideInput,
  AgentPromptInput,
  AgentSaveInput,
  AutoUpdateState,
  BanyanConfig,
  BuildState,
  CodegraphEdge,
  CodegraphFile,
  CodegraphNode,
  CoreConfigOutput,
  GraphMeta,
  MeshLimits,
  MeshNode,
  ProviderUsageSnapshot,
  ReadinessResult,
  SystemStatus,
  ToolUsageRow,
  YoloStatus,
} from "./pending-rpc"

export interface CodegraphGraph {
  readonly nodes: readonly CodegraphNode[]
  readonly edges: readonly CodegraphEdge[]
}

export interface CodegraphLive {
  readonly availability: Accessor<Availability>
  readonly error: Accessor<string | undefined>
  readonly build: Accessor<BuildState | undefined>
  readonly readiness: Accessor<ReadinessResult | undefined>
  readonly autoUpdate: Accessor<AutoUpdateState | undefined>
  readonly meta: Accessor<GraphMeta | undefined>
  readonly graph: Accessor<CodegraphGraph | undefined>
  readonly graphAvailability: Accessor<Availability>
  readonly graphLoading: Accessor<boolean>
  readonly files: Accessor<readonly CodegraphFile[] | undefined>
  readonly filesAvailability: Accessor<Availability>
  refresh(): Promise<void>
  ensureGraph(force?: boolean): Promise<void>
  ensureFiles(): Promise<void>
  start(options?: { readonly force?: boolean }): Promise<Attempt<BuildState>>
  cancel(): Promise<Attempt<BuildState>>
  remove(dropFile?: boolean): Promise<Attempt<unknown>>
  forceKill(): Promise<Attempt<{ ok: boolean; message: string }>>
}

export interface MeshLive {
  readonly availability: Accessor<Availability>
  readonly error: Accessor<string | undefined>
  root(rootSessionID: string): MeshNode | undefined
  ensure(rootSessionID: string): Promise<void>
  readonly limits: Accessor<MeshLimits | undefined>
  readonly swarmMode: Accessor<boolean | undefined>
  /** Sessions killed through mesh.kill, so every tree can mark them finished. */
  readonly killed: Accessor<ReadonlySet<string>>
  refreshLimits(): Promise<void>
  setLimits(input: { readonly maxSubagents?: number; readonly swarmMode?: boolean }): Promise<Attempt<MeshLimits>>
  steer(input: {
    readonly parentSessionID: string
    readonly targetAgent: string
    readonly instruction: string
    readonly priority?: "low" | "normal" | "high"
  }): Promise<Attempt<{ readonly delivered: number }>>
  kill(input: {
    readonly parentSessionID: string
    readonly targetAgent?: string
    readonly targetSessionID?: string
    readonly reason: string
  }): Promise<Attempt<{ readonly killed: number }>>
}

export interface LspServerStatus {
  readonly id: string
  readonly name?: string
  readonly root?: string
  readonly status: "configured" | "connected" | "error"
  readonly languages: readonly string[]
  readonly inert: boolean
  readonly disabled: boolean
  readonly disabledReason?: string
}

export interface LspStatus {
  readonly enabled: boolean
  readonly servers: readonly LspServerStatus[]
}

export interface SystemLive {
  readonly availability: Accessor<Availability>
  readonly status: Accessor<SystemStatus | undefined>
  readonly lsp: Accessor<LspStatus | undefined>
  readonly lspAvailability: Accessor<Availability>
  readonly yolo: Accessor<boolean | undefined>
  readonly yoloAvailability: Accessor<Availability>
  refresh(): Promise<void>
  refreshLsp(): Promise<void>
  refreshYolo(): Promise<void>
  setYolo(enabled: boolean): Promise<Attempt<YoloStatus>>
  agentOverride(input: AgentOverrideInput): Promise<Attempt<BanyanConfig>>
  agentPrompt(input: AgentPromptInput): Promise<Attempt<BanyanConfig>>
  agentSave(input: AgentSaveInput): Promise<Attempt<{ readonly ok: true; readonly filePath: string }>>
}

export interface UsageLive {
  readonly toolsAvailability: Accessor<Availability>
  readonly providersAvailability: Accessor<Availability>
  readonly error: Accessor<string | undefined>
  tools(sessionID?: string): readonly ToolUsageRow[] | undefined
  providers(): readonly ProviderUsageSnapshot[] | undefined
  refreshTools(sessionID?: string): Promise<void>
  refreshProviders(force?: boolean): Promise<void>
}

export interface IntelEntry {
  readonly id: string
  readonly kind: "search" | "subsystem" | "routes" | "trace"
  readonly query: string
  readonly summary: string
}

export interface IntelLive {
  readonly entries: Accessor<readonly IntelEntry[]>
  push(entry: Omit<IntelEntry, "id">): void
}

export interface CoreLive {
  readonly availability: Accessor<Availability>
  readonly status: Accessor<CoreConfigOutput | undefined>
  readonly config: Accessor<BanyanConfig | undefined>
  refresh(): Promise<void>
  update(config: Readonly<Record<string, unknown>>): Promise<Attempt<unknown>>
}

export interface Live {
  readonly core: CoreLive
  readonly codegraph: CodegraphLive
  readonly mesh: MeshLive
  readonly system: SystemLive
  readonly usage: UsageLive
  readonly intel: IntelLive
  dispose(): void
}

const GRAPH_NODE_LIMIT = 2000
const GRAPH_EDGE_LIMIT = 8000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** v1 sent `banyancode_yolo_mode`; the v2 RPC may wrap it. Accept every shape. */
export function normalizeYolo(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (!isRecord(value)) return undefined
  for (const key of ["enabled", "yoloMode", "yolo_mode", "banyancode_yolo_mode", "value"]) {
    const candidate = value[key]
    if (typeof candidate === "boolean") return candidate
  }
  return undefined
}

/** Normalize the v1 LSP entry list plus the v2 status envelope. */
export function normalizeLsp(value: unknown): LspStatus | undefined {
  const servers = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.servers)
      ? value.servers
      : undefined
  if (servers === undefined) return undefined
  const enabled = isRecord(value) && typeof value.enabled === "boolean" ? value.enabled : true
  return { enabled, servers: servers.flatMap((entry) => normalizeLspEntry(entry)) }
}

function normalizeLspEntry(value: unknown): LspServerStatus[] {
  if (!isRecord(value) || typeof value.id !== "string") return []
  const status = value.status
  return [
    {
      id: value.id,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.root === "string" ? { root: value.root } : {}),
      status: status === "connected" || status === "error" ? status : "configured",
      languages: Array.isArray(value.languages)
        ? value.languages.filter((language): language is string => typeof language === "string")
        : [],
      inert: value.inert === true,
      disabled: value.disabled === true,
      ...(typeof value.disabledReason === "string" ? { disabledReason: value.disabledReason } : {}),
    },
  ]
}

/** Fall back to `banyancode_lsp` in the Banyan config when `lsp.status` is absent. */
export function lspFromConfig(config: BanyanConfig | undefined): LspStatus | undefined {
  const raw = config?.banyancode_lsp
  if (raw === true) return { enabled: true, servers: [] }
  if (raw === false) return { enabled: false, servers: [] }
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return undefined
  const servers = Object.entries(raw).map(([id, entry]): LspServerStatus => {
    const detail = entry as Record<string, unknown>
    const extensions = isRecord(entry) && Array.isArray(detail.extensions) ? detail.extensions : []
    return {
      id,
      status: "configured",
      languages: extensions.filter((extension): extension is string => typeof extension === "string"),
      inert: false,
      disabled: isRecord(entry) && entry.disabled === true,
    }
  })
  return { enabled: true, servers }
}

/**
 * Shared reactive state for every BanyanCode surface. Created once per plugin
 * instance in `setup`, which owns the event subscriptions and disposes them on
 * deactivate. Every RPC is best-effort: an unregistered namespace leaves the
 * surface in its "not available" state instead of throwing.
 */
export function createLive(context: Context): Live {
  const rpc = createRpcLayer(context.client, () => context.location)
  const root = () => context.location?.directory
  const disposers: Array<() => void> = []
  let disposed = false

  // --- core ---------------------------------------------------------------
  const [coreAvailability, setCoreAvailability] = createSignal<Availability>("unknown")
  const [coreStatus, setCoreStatus] = createSignal<CoreConfigOutput | undefined>(undefined)

  const refreshCore = async () => {
    const result = await attempt(() => rpc.core["config.get"]({}))
    if (disposed) return
    setCoreAvailability(availabilityOf(result))
    if (result.ok) setCoreStatus(result.value)
  }

  // --- codegraph ----------------------------------------------------------
  const [cgAvailability, setCgAvailability] = createSignal<Availability>("unknown")
  const [cgError, setCgError] = createSignal<string | undefined>(undefined)
  const [build, setBuild] = createSignal<BuildState | undefined>(undefined)
  const [readiness, setReadiness] = createSignal<ReadinessResult | undefined>(undefined)
  const [autoUpdate, setAutoUpdate] = createSignal<AutoUpdateState | undefined>(undefined)
  const [meta, setMeta] = createSignal<GraphMeta | undefined>(undefined)
  const [graph, setGraph] = createSignal<CodegraphGraph | undefined>(undefined)
  const [graphAvailability, setGraphAvailability] = createSignal<Availability>("unknown")
  const [graphLoading, setGraphLoading] = createSignal(false)
  const [files, setFiles] = createSignal<readonly CodegraphFile[] | undefined>(undefined)
  const [filesAvailability, setFilesAvailability] = createSignal<Availability>("unknown")

  let graphEpoch = 0
  let graphRequest: Promise<void> | undefined
  let filesRequest: Promise<void> | undefined

  const refreshCodegraph = async () => {
    const result = await attempt(() => rpc.codegraph.status({ root: root() }))
    if (disposed) return
    setCgAvailability(availabilityOf(result))
    if (!result.ok) {
      setCgError(result.unavailable ? undefined : result.message)
      return
    }
    setCgError(undefined)
    setBuild(result.value.build)
    setReadiness(result.value.readiness)
    setAutoUpdate(result.value.autoUpdate)
    setMeta(result.value.meta)
  }

  // A panel asks once on mount, so a rebuild has to fetch again for it.
  let filesWanted = false
  let graphWanted = false
  const invalidateGraph = () => {
    graphEpoch += 1
    setGraph(undefined)
    setFiles(undefined)
    if (filesWanted) void ensureFiles()
    if (graphWanted) void ensureGraph()
  }

  const ensureGraph = async (force = false) => {
    graphWanted = true
    if (graphRequest) return graphRequest
    if (!force && graph() !== undefined) return
    const epoch = graphEpoch
    graphRequest = (async () => {
      setGraphLoading(true)
      const [nodes, edges] = await Promise.all([
        attempt(() => rpc.codegraph.nodes({ limit: GRAPH_NODE_LIMIT })),
        attempt(() => rpc.codegraph.edges({ limit: GRAPH_EDGE_LIMIT })),
      ])
      if (disposed || epoch !== graphEpoch) return
      const failure = !nodes.ok ? nodes : !edges.ok ? edges : undefined
      setGraphAvailability(failure ? availabilityOf(failure) : "available")
      if (nodes.ok && edges.ok) setGraph({ nodes: nodes.value.nodes, edges: edges.value.edges })
      else if (failure && !failure.unavailable) setCgError(failure.message)
    })().finally(() => {
      graphRequest = undefined
      setGraphLoading(false)
    })
    return graphRequest
  }

  const ensureFiles = async () => {
    filesWanted = true
    if (filesRequest) return filesRequest
    if (files() !== undefined) return
    filesRequest = (async () => {
      const result = await attempt(() => rpc.codegraph.files({ limit: GRAPH_NODE_LIMIT }))
      if (disposed) return
      setFilesAvailability(availabilityOf(result))
      if (result.ok) setFiles(result.value.files)
    })().finally(() => {
      filesRequest = undefined
    })
    return filesRequest
  }

  // These publish no build event when nothing was running, and the panels mustn't keep the old numbers.
  const afterGraphChange = async <T,>(result: T) => {
    await refreshCodegraph()
    invalidateGraph()
    return result
  }

  const onBuild = rpc.codegraph.events.on("build", (event) => {
    const next = event.data
    setBuild(next)
    setCgAvailability("available")
    setCgError(next.status === "failed" ? next.error : undefined)
    if (next.status === "completed") void refreshCodegraph()
    if (next.status === "completed" || next.status === "failed" || next.status === "cancelled") invalidateGraph()
  })
  disposers.push(onBuild)

  const onAutoUpdate = rpc.codegraph.events.on("autoUpdate", (event) => {
    setAutoUpdate(event.data)
    setCgAvailability("available")
  })
  disposers.push(onAutoUpdate)

  // --- mesh ---------------------------------------------------------------
  const [meshAvailability, setMeshAvailability] = createSignal<Availability>("unknown")
  const [meshError, setMeshError] = createSignal<string | undefined>(undefined)
  const [meshRoots, setMeshRoots] = createSignal<ReadonlyMap<string, MeshNode>>(new Map())
  const [meshKilled, setMeshKilled] = createSignal<ReadonlyMap<string, readonly string[]>>(new Map())
  const [limits, setLimitsValue] = createSignal<MeshLimits | undefined>(undefined)

  const storeRoots = (roots: readonly MeshNode[], killed: readonly string[] | undefined) => {
    const next = new Map(meshRoots())
    const nextKilled = new Map(meshKilled())
    for (const node of roots) {
      next.set(node.sessionID, node)
      nextKilled.set(node.sessionID, killed ?? [])
    }
    setMeshRoots(next)
    setMeshKilled(nextKilled)
  }

  const ensureMesh = async (rootSessionID: string) => {
    const result = await attempt(() => rpc.mesh.sessionStatus({ sessionID: rootSessionID }))
    if (disposed) return
    setMeshAvailability(availabilityOf(result))
    if (!result.ok) {
      if (!result.unavailable) setMeshError(result.message)
      return
    }
    setMeshError(undefined)
    storeRoots(result.value.roots, result.value.killed)
  }

  const refreshLimits = async () => {
    const result = await attempt(() => rpc.mesh["limits.get"]({}))
    if (disposed) return
    setMeshAvailability(availabilityOf(result))
    if (result.ok) setLimitsValue(result.value)
  }

  const setLimits = async (input: {
    readonly maxSubagents?: number
    readonly swarmMode?: boolean
  }): Promise<Attempt<MeshLimits>> => {
    const result = await attempt(() => rpc.mesh["limits.set"](input))
    if (disposed) return result.ok ? { ok: true, value: result.value.limits } : result
    if (!result.ok) {
      if (!result.unavailable) setMeshError(result.message)
      return result
    }
    setLimitsValue(result.value.limits)
    setMeshAvailability("available")
    if (!result.value.ok) {
      const message = result.value.error ?? "Limits were not saved"
      setMeshError(message)
      return { ok: false, unavailable: false, message }
    }
    setMeshError(undefined)
    return { ok: true, value: result.value.limits }
  }

  const steer = async (input: {
    readonly parentSessionID: string
    readonly targetAgent: string
    readonly instruction: string
    readonly priority?: "low" | "normal" | "high"
  }) => {
    const result = await attempt(() => rpc.mesh.steer(input))
    if (!disposed && result.ok) setMeshAvailability("available")
    return result
  }

  const kill = async (input: {
    readonly parentSessionID: string
    readonly targetAgent?: string
    readonly targetSessionID?: string
    readonly reason: string
  }) => {
    const result = await attempt(() => rpc.mesh.kill(input))
    if (disposed) return result
    if (result.ok) {
      setMeshAvailability("available")
      await ensureMesh(input.parentSessionID)
    }
    return result
  }

  const killedSessions = () => new Set([...meshKilled().values()].flat())

  const onMesh = rpc.mesh.events.on("status.updated", (event) => {
    const next = new Map(meshRoots())
    next.set(event.data.rootSessionID, event.data.tree)
    setMeshRoots(next)
    if (event.data.killed !== undefined) {
      const nextKilled = new Map(meshKilled())
      nextKilled.set(event.data.rootSessionID, event.data.killed)
      setMeshKilled(nextKilled)
    }
    setMeshAvailability("available")
  })
  disposers.push(onMesh)

  // --- system -------------------------------------------------------------
  const [sysAvailability, setSysAvailability] = createSignal<Availability>("unknown")
  const [sysStatus, setSysStatus] = createSignal<SystemStatus | undefined>(undefined)
  const [lspStatus, setLspStatus] = createSignal<LspStatus | undefined>(undefined)
  const [lspAvailability, setLspAvailability] = createSignal<Availability>("unknown")
  const [yoloValue, setYoloValue] = createSignal<boolean | undefined>(undefined)
  const [yoloAvailability, setYoloAvailability] = createSignal<Availability>("unknown")

  const refreshSystem = async () => {
    const result = await attempt(() => rpc.system.status({}))
    if (disposed) return
    setSysAvailability(availabilityOf(result))
    if (result.ok) setSysStatus(result.value)
  }

  const refreshLsp = async () => {
    const result = await attempt(() => rpc.system["lsp.status"]({}))
    if (disposed) return
    setLspAvailability(availabilityOf(result))
    if (!result.ok) return
    const normalized = normalizeLsp(result.value)
    if (normalized) setLspStatus(normalized)
  }

  const refreshYolo = async () => {
    const result = await attempt(() => rpc.system["yolo.get"]({}))
    if (disposed) return
    setYoloAvailability(availabilityOf(result))
    if (!result.ok) return
    const normalized = normalizeYolo(result.value)
    if (normalized !== undefined) setYoloValue(normalized)
  }

  const onSystem = rpc.system.events.on("updated", (event) => {
    setSysStatus(event.data)
    setSysAvailability("available")
  })
  disposers.push(onSystem)

  const afterConfigWrite = async () => {
    await refreshCore()
    await context.data.location.agent.sync(context.location)
    await refreshLsp()
    await refreshYolo()
  }

  const setYolo = (enabled: boolean) =>
    attempt(() => rpc.system["yolo.set"]({ enabled })).then(async (result) => {
      if (result.ok) {
        setYoloValue(enabled)
        await afterConfigWrite()
      }
      return result
    })

  const agentOverride = (input: AgentOverrideInput) =>
    attempt(() => rpc.system["config.agentOverride"](input)).then(async (result) => {
      if (result.ok) await afterConfigWrite()
      return result
    })

  const agentPrompt = (input: AgentPromptInput) =>
    attempt(() => rpc.system["config.agentPrompt"](input)).then(async (result) => {
      if (result.ok) await afterConfigWrite()
      return result
    })

  const agentSave = (input: AgentSaveInput) =>
    attempt(() => rpc.system["config.agentSave"](input)).then(async (result) => {
      if (result.ok) await afterConfigWrite()
      return result
    })

  // --- usage --------------------------------------------------------------
  const [toolsAvailability, setToolsAvailability] = createSignal<Availability>("unknown")
  const [providersAvailability, setProvidersAvailability] = createSignal<Availability>("unknown")
  const [usageError, setUsageError] = createSignal<string | undefined>(undefined)
  const [toolRows, setToolRows] = createSignal<ReadonlyMap<string, readonly ToolUsageRow[]>>(new Map())
  const [providerRows, setProviderRows] = createSignal<readonly ProviderUsageSnapshot[] | undefined>(undefined)

  const refreshTools = async (sessionID?: string) => {
    const result = await attempt(() => rpc.usage.toolUsage(sessionID === undefined ? {} : { session: sessionID }))
    if (disposed) return
    setToolsAvailability(availabilityOf(result))
    if (!result.ok) {
      if (!result.unavailable) setUsageError(result.message)
      return
    }
    const key = sessionID ?? "*"
    const next = new Map(toolRows())
    next.set(key, result.value.tools)
    setToolRows(next)
  }

  const refreshProviders = async (force = false) => {
    // v1 route names (`providerList` / `providerRefresh`) are the server's
    // shipped methods now; the old `providers`/`providersRefresh` aliases were
    // a placeholder while the namespace did not exist.
    const result = await attempt(() => (force ? rpc.usage.providerRefresh({}) : rpc.usage.providerList({})))
    if (disposed) return
    setProvidersAvailability(availabilityOf(result))
    if (!result.ok) {
      if (!result.unavailable) setUsageError(result.message)
      return
    }
    setProviderRows(result.value.snapshots)
  }

  // --- intel --------------------------------------------------------------
  const [intelEntries, setIntelEntries] = createSignal<readonly IntelEntry[]>([])
  let intelSequence = 0

  const pushIntel = (entry: Omit<IntelEntry, "id">) => {
    intelSequence += 1
    setIntelEntries((previous) => [{ id: `intel_${intelSequence}`, ...entry }, ...previous].slice(0, 8))
  }

  // Hydration is lazy: each surface refreshes when it mounts (and the RPC
  // event subscriptions keep it live afterwards). Firing every namespace from
  // `setup` made the plugin issue eight RPC calls before the first frame, which
  // stalls startup and floods hosts that do not implement BanyanCode yet.

  // A surface can mount before the location is known, and /cd changes it. Refresh what has already been asked for.
  const stopLocationWatch = createRoot((stop) => {
    createEffect(
      on(
        () => context.location?.directory,
        () => {
          if (cgAvailability() !== "unknown") void refreshCodegraph()
          if (coreAvailability() !== "unknown") void refreshCore()
        },
        { defer: true },
      ),
    )
    return stop
  })

  const dispose = () => {
    disposed = true
    stopLocationWatch()
    for (const off of disposers) off()
    disposers.length = 0
  }

  const config = () => coreStatus()?.config

  return {
    core: {
      availability: coreAvailability,
      status: coreStatus,
      config,
      refresh: refreshCore,
      update: (config: Readonly<Record<string, unknown>>) =>
        attempt(() => rpc.core["config.update"]({ config })).then(async (result) => {
          await refreshCore()
          return result
        }),
    },
    codegraph: {
      availability: cgAvailability,
      error: cgError,
      build,
      readiness,
      autoUpdate,
      meta,
      graph,
      graphAvailability,
      graphLoading,
      files,
      filesAvailability,
      refresh: refreshCodegraph,
      ensureGraph,
      ensureFiles,
      start: (options) => attempt(() => rpc.codegraph.build({ root: root(), ...options })),
      cancel: () => attempt(() => rpc.codegraph.cancel({})).then(afterGraphChange),
      remove: (dropFile) =>
        attempt(() => rpc.codegraph.remove(dropFile === undefined ? {} : { dropFile })).then(afterGraphChange),
      forceKill: () => attempt(() => rpc.codegraph.forceKill({})).then(afterGraphChange),
    },
    mesh: {
      availability: meshAvailability,
      error: meshError,
      root: (rootSessionID) => meshRoots().get(rootSessionID),
      ensure: ensureMesh,
      limits,
      swarmMode: () => limits()?.swarmMode,
      killed: killedSessions,
      refreshLimits,
      setLimits,
      steer,
      kill,
    },
    system: {
      availability: sysAvailability,
      status: sysStatus,
      lsp: () => lspStatus() ?? lspFromConfig(config()),
      lspAvailability,
      yolo: () => yoloValue() ?? (config()?.banyancode_yolo_mode === true ? true : undefined),
      yoloAvailability,
      refresh: refreshSystem,
      refreshLsp,
      refreshYolo,
      setYolo,
      agentOverride,
      agentPrompt,
      agentSave,
    },
    usage: {
      toolsAvailability,
      providersAvailability,
      error: usageError,
      tools: (sessionID) => toolRows().get(sessionID ?? "*"),
      providers: providerRows,
      refreshTools,
      refreshProviders,
    },
    intel: {
      entries: intelEntries,
      push: pushIntel,
    },
    dispose,
  }
}
