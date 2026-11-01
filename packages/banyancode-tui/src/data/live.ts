import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, type Accessor } from "solid-js"
import {
  availabilityOf,
  attempt,
  createRpcLayer,
  type Availability,
  type Attempt,
} from "./rpc"
import type {
  AutoUpdateState,
  BuildState,
  CodegraphEdge,
  CodegraphFile,
  CodegraphNode,
  GraphMeta,
  MeshNode,
  ProviderUsageSnapshot,
  ReadinessResult,
  SystemStatus,
  ToolUsageRow,
  TraceRow,
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
  readonly limits: Accessor<{ maxSubagents: number } | undefined>
  refreshLimits(): Promise<void>
}

export interface SystemLive {
  readonly availability: Accessor<Availability>
  readonly status: Accessor<SystemStatus | undefined>
  refresh(): Promise<void>
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
  readonly traceAvailability: Accessor<Availability>
  push(entry: Omit<IntelEntry, "id">): void
  trace(sessionID: string): Promise<readonly TraceRow[] | undefined>
}

export interface CoreLive {
  readonly availability: Accessor<Availability>
  readonly status: Accessor<
    | {
        readonly version: string
        readonly host: { readonly name: string; readonly version: string; readonly channel: string }
        readonly config: { readonly summary: Record<string, unknown> }
      }
    | undefined
  >
  refresh(): Promise<void>
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

/**
 * Shared reactive state for every BanyanCode surface. Created once per plugin
 * instance in `setup`, which owns the event subscriptions and disposes them on
 * deactivate. Every RPC is best-effort: an unregistered namespace leaves the
 * surface in its "not available" state instead of throwing.
 */
export function createLive(context: Context): Live {
  const rpc = createRpcLayer(context.client)
  const root = () => context.location?.directory
  const disposers: Array<() => void> = []
  let disposed = false

  // --- core ---------------------------------------------------------------
  const [coreAvailability, setCoreAvailability] = createSignal<Availability>("unknown")
  const [coreStatus, setCoreStatus] = createSignal<CoreLive["status"] extends Accessor<infer T> ? T : never>(undefined)

  const refreshCore = async () => {
    const result = await attempt(() => rpc.core.status({}))
    if (disposed) return
    setCoreAvailability(availabilityOf(result))
    if (result.ok) setCoreStatus(result.value as NonNullable<ReturnType<CoreLive["status"]>>)
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

  const invalidateGraph = () => {
    graphEpoch += 1
    setGraph(undefined)
    setFiles(undefined)
  }

  const ensureGraph = async (force = false) => {
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
  const [limits, setLimits] = createSignal<{ maxSubagents: number } | undefined>(undefined)

  const storeRoots = (roots: readonly MeshNode[]) => {
    const next = new Map(meshRoots())
    for (const node of roots) next.set(node.sessionID, node)
    setMeshRoots(next)
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
    storeRoots(result.value.roots)
  }

  const refreshLimits = async () => {
    const result = await attempt(() => rpc.mesh["limits.get"]({}))
    if (disposed) return
    setMeshAvailability(availabilityOf(result))
    if (result.ok) setLimits({ maxSubagents: result.value.maxSubagents })
  }

  const onMesh = rpc.mesh.events.on("status.updated", (event) => {
    const next = new Map(meshRoots())
    next.set(event.data.rootSessionID, event.data.tree)
    setMeshRoots(next)
    setMeshAvailability("available")
  })
  disposers.push(onMesh)

  // --- system -------------------------------------------------------------
  const [sysAvailability, setSysAvailability] = createSignal<Availability>("unknown")
  const [sysStatus, setSysStatus] = createSignal<SystemStatus | undefined>(undefined)

  const refreshSystem = async () => {
    const result = await attempt(() => rpc.system.status({}))
    if (disposed) return
    setSysAvailability(availabilityOf(result))
    if (result.ok) setSysStatus(result.value)
  }

  const onSystem = rpc.system.events.on("updated", (event) => {
    setSysStatus(event.data)
    setSysAvailability("available")
  })
  disposers.push(onSystem)

  // --- usage --------------------------------------------------------------
  const [toolsAvailability, setToolsAvailability] = createSignal<Availability>("unknown")
  const [providersAvailability, setProvidersAvailability] = createSignal<Availability>("unknown")
  const [usageError, setUsageError] = createSignal<string | undefined>(undefined)
  const [toolRows, setToolRows] = createSignal<ReadonlyMap<string, readonly ToolUsageRow[]>>(new Map())
  const [providerRows, setProviderRows] = createSignal<readonly ProviderUsageSnapshot[] | undefined>(undefined)

  const refreshTools = async (sessionID?: string) => {
    const result = await attempt(() => rpc.usage.tools(sessionID === undefined ? {} : { session: sessionID }))
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
    const result = await attempt(() => (force ? rpc.usage.providersRefresh({}) : rpc.usage.providers({})))
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
  const [traceAvailability, setTraceAvailability] = createSignal<Availability>("unknown")
  let intelSequence = 0

  const pushIntel = (entry: Omit<IntelEntry, "id">) => {
    intelSequence += 1
    setIntelEntries((previous) => [{ id: `intel_${intelSequence}`, ...entry }, ...previous].slice(0, 8))
  }

  const trace = async (sessionID: string): Promise<readonly TraceRow[] | undefined> => {
    const result = await attempt(() => rpc.intel.trace({ session: sessionID, limit: 8 }))
    if (disposed) return undefined
    setTraceAvailability(availabilityOf(result))
    return result.ok ? result.value.events : undefined
  }

  // Hydrate the surfaces that are visible before any panel mounts. Failures
  // are already folded into the availability signals.
  void refreshCore()
  void refreshCodegraph()

  const dispose = () => {
    disposed = true
    for (const off of disposers) off()
    disposers.length = 0
  }

  return {
    core: {
      availability: coreAvailability,
      status: coreStatus,
      refresh: refreshCore,
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
      cancel: () => attempt(() => rpc.codegraph.cancel({})),
      remove: (dropFile) => attempt(() => rpc.codegraph.remove(dropFile === undefined ? {} : { dropFile })),
      forceKill: () => attempt(() => rpc.codegraph.forceKill({})),
    },
    mesh: {
      availability: meshAvailability,
      error: meshError,
      root: (rootSessionID) => meshRoots().get(rootSessionID),
      ensure: ensureMesh,
      limits,
      refreshLimits,
    },
    system: {
      availability: sysAvailability,
      status: sysStatus,
      refresh: refreshSystem,
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
      traceAvailability,
      push: pushIntel,
      trace,
    },
    dispose,
  }
}
