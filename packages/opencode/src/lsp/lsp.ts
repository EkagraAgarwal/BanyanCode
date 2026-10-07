import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Process } from "@/util/process"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, Context, Schema, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const Event = {
  Updated: EventV2.define({ type: "lsp.updated", schema: {} }),
}

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["configured", "connected", "error"]),
  // True when the server downloads + manages its own binary (clangd,
  // jdtls, kotlin-ls, ...). Lets the TUI show "auto-downloaded" badges.
  autoDownload: Schema.Boolean,
  languages: Schema.Array(Schema.String).annotate({
    description: "Languages served by this LSP, derived from its file extensions.",
  }),
  inert: Schema.Boolean.annotate({
    description: "True when configured but currently attached to zero open files.",
  }),
  disabled: Schema.Boolean.annotate({
    description: "True when the user explicitly disabled this server in banyancode_lsp.",
  }),
  disabledReason: Schema.optional(Schema.String).annotate({
    description: "Human-readable reason the server is disabled (omitted when enabled).",
  }),
  clientCount: Schema.optional(Schema.Number).annotate({
    description: "Attached clients for this server (1 for a connected entry, 0 otherwise).",
  }),
  rssBytes: Schema.optional(Schema.Number).annotate({
    description: "Best-effort process-tree RSS in bytes for the attached client.",
  }),
  pid: Schema.optional(Schema.Number).annotate({
    description: "OS pid of the attached language server process.",
  }),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

const LSP_LANGUAGE_MAP: Record<string, readonly string[]> = {
  deno: ["TypeScript", "JavaScript"],
  typescript: ["TypeScript", "JavaScript"],
  vue: ["Vue", "TypeScript", "JavaScript"],
  eslint: ["JavaScript", "TypeScript", "CSS", "JSON"],
  oxlint: ["TypeScript", "JavaScript"],
  biome: ["TypeScript", "JavaScript", "JSON", "CSS"],
  gopls: ["Go"],
  rubocop: ["Ruby"],
  ty: ["Python"],
  pyright: ["Python"],
  elixir_ls: ["Elixir"],
  zls: ["Zig"],
  csharp: ["C#"],
  razor: ["Razor", "C#"],
  fsharp: ["F#"],
  sourcekit_lsp: ["Swift"],
  rust_analyzer: ["Rust"],
  clangd: ["C", "C++", "Objective-C"],
  svelte: ["Svelte", "TypeScript", "JavaScript"],
  astro: ["Astro", "TypeScript", "JavaScript"],
  jdtls: ["Java"],
  kotlin_ls: ["Kotlin"],
  yaml_ls: ["YAML"],
  lua_ls: ["Lua"],
  intelephense: ["PHP"],
  prisma: ["Prisma"],
  dart: ["Dart"],
  ocaml: ["OCaml"],
  bashls: ["Shell"],
  terraformls: ["Terraform", "HCL"],
  texlab: ["LaTeX"],
  dockerfilels: ["Dockerfile"],
  gleam: ["Gleam"],
  clojure: ["Clojure"],
  nixd: ["Nix"],
  tinymist: ["Typst"],
  hls: ["Haskell"],
  julials: ["Julia"],
}

function languagesForServer(server: LSPServer.Info): string[] {
  const mapped = LSP_LANGUAGE_MAP[server.id]
  if (mapped) return [...mapped]
  return Array.from(new Set(server.extensions.map((ext) => ext.replace(/^\./, "").toLowerCase()))).slice(0, 6)
}

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

export const DEFAULT_LSP_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export function resolveLspIdleTimeoutMs(raw?: unknown) {
  if (raw === 0) return 0
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LSP_IDLE_TIMEOUT_MS
  return Math.floor(raw)
}

const clientKey = (root: string, serverID: string) => root + serverID

function mergeServerInitialization(
  serverID: string,
  handleInit: Record<string, unknown> | undefined,
  item: { initialization?: Record<string, unknown>; maxMemoryMb?: unknown },
) {
  if (serverID !== "typescript") return item.initialization ?? handleInit
  const itemInit = item.initialization
  const handleTs = handleInit?.["tsserver"]
  const itemTs = itemInit?.["tsserver"]
  const explicit =
    typeof itemTs === "object" && itemTs !== null
      ? (itemTs as Record<string, unknown>)["maxTsServerMemory"]
      : undefined
  const maxTsServerMemory =
    typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0
      ? Math.floor(Math.min(Math.max(explicit, 256), 16384))
      : LSPServer.resolveTypescriptMaxMemoryMb(item.maxMemoryMb)
  return {
    ...(handleInit ?? {}),
    ...(itemInit ?? {}),
    tsserver: {
      ...(typeof handleTs === "object" && handleTs !== null ? (handleTs as Record<string, unknown>) : {}),
      ...(typeof itemTs === "object" && itemTs !== null ? (itemTs as Record<string, unknown>) : {}),
      maxTsServerMemory,
    },
  }
}

async function shutdownClient(client: LSPClient.Info) {
  await client.shutdown().catch(() => {})
}

async function readProcessTreeRss(pid?: number) {
  if (!pid || !Number.isFinite(pid) || pid <= 0 || process.platform === "win32") return undefined
  try {
    const out = await Process.text(["ps", "-o", "pid=,ppid=,rss="], { nothrow: true })
    if (out.code !== 0) return undefined
    const rows: { pid: number; ppid: number; rssKb: number }[] = []
    for (const line of out.text.split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const rowPid = Number.parseInt(parts[0] ?? "", 10)
      const rowPpid = Number.parseInt(parts[1] ?? "", 10)
      const rowRss = Number.parseInt(parts[2] ?? "", 10)
      if (!Number.isFinite(rowPid) || !Number.isFinite(rowPpid) || !Number.isFinite(rowRss)) continue
      rows.push({ pid: rowPid, ppid: rowPpid, rssKb: rowRss })
    }
    if (!rows.some((row) => row.pid === pid)) return undefined
    const children = new Map<number, number[]>()
    for (const row of rows) {
      const list = children.get(row.ppid) ?? []
      list.push(row.pid)
      children.set(row.ppid, list)
    }
    const rssByPid = new Map(rows.map((row) => [row.pid, row.rssKb] as const))
    let totalKb = 0
    const queue = [pid]
    const seen = new Set([pid])
    while (queue.length > 0) {
      const current = queue.pop() as number
      totalKb += rssByPid.get(current) ?? 0
      for (const child of children.get(current) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        queue.push(child)
      }
    }
    return totalKb * 1024
  } catch {
    return undefined
  }
}

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: Set<string>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
  lastActivity: Map<string, number>
  clientPid: Map<string, number>
  idleTimeoutMs: number
  // Per-server disabled reasons harvested from `banyancode_lsp`. Allows the
  // TUI sidebar to surface "typescript: disabled" without the user having
  // to dig through the global banyancode config dialog.
  disabled: Map<string, string>
  // `banyancode_lsp` resolved truthy / falsey. Lets the TUI distinguish
  // "disabled because the user set banyancode_lsp to false" from
  // "disabled because the field is unset" (both should look "off", but the
  // latter should still be re-readable as a config nudge).
  configEnabled: boolean
}

type LocInput = { file: string; line: number; character: number }

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly reload: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        // BanyanCode is its own product identity and does not read
        // opencode.json. LSP config lives in banyancode.json under
        // `banyancode_lsp`. When BanyanCode is disabled (BanyanConfigService
        // not in scope) or the field is unset, all LSPs are off â€” matching
        // the previous opencode default of `cfg.lsp === undefined`.
        const banyanOption = yield* Effect.serviceOption(Banyan.BanyanConfigService)
        const banyanConfig = Option.isSome(banyanOption) ? yield* banyanOption.value.get() : ({} as Banyan.BanyanConfigInfo)
        const lsp = banyanConfig.banyancode_lsp

        const servers: Record<string, LSPServer.Info> = {}

        if (!lsp) {
          yield* Effect.logInfo("all LSPs are disabled")
        } else {
          for (const candidate of Object.values(LSPServer)) {
            if (!candidate || typeof candidate !== "object" || !("id" in candidate) || !("spawn" in candidate))
              continue
            const server = candidate as LSPServer.Info
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (lsp !== true) {
            for (const [name, item] of Object.entries(lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: item.command
                  ? async (root) => ({
                      process: lspspawn(item.command![0], item.command!.slice(1), {
                        cwd: root,
                        env: { ...process.env, ...item.env },
                      }),
                      initialization:
                        name === "typescript"
                          ? mergeServerInitialization(name, undefined, item)
                          : item.initialization,
                    })
                  : existing?.spawn
                    ? async (root, ctx, flags) => {
                        const handle = await existing.spawn(root, ctx, flags)
                        if (!handle) return undefined
                        return {
                          ...handle,
                          initialization: mergeServerInitialization(name, handle.initialization, item),
                        }
                      }
                    : async () => undefined,
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const disabled = new Map<string, string>()
        if (lsp && typeof lsp === "object") {
          for (const [name, item] of Object.entries(lsp)) {
            if (item && typeof item === "object" && "disabled" in item && item.disabled) {
              disabled.set(name, "disabled in banyancode.json")
            }
          }
        }

        const s: State = {
          clients: [],
          servers,
          broken: new Set(),
          spawning: new Map(),
          lastActivity: new Map(),
          clientPid: new Map(),
          idleTimeoutMs: resolveLspIdleTimeoutMs(banyanConfig.banyancode_lsp_idle_timeout_ms),
          disabled,
          configEnabled: Boolean(lsp),
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(s.clients.map((client) => shutdownClient(client)))
          }),
        )

        return s
      }),
    )

    const getClients = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const s = yield* InstanceState.get(state)
      const clients = yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []
        let updated = 0

        if (s.idleTimeoutMs > 0) {
          const now = Date.now()
          const idle: LSPClient.Info[] = []
          for (const client of s.clients) {
            const at = s.lastActivity.get(clientKey(client.root, client.serverID)) ?? now
            if (now - at > s.idleTimeoutMs) idle.push(client)
          }
          if (idle.length > 0) {
            s.clients = s.clients.filter((c) => !idle.includes(c))
            for (const client of idle) {
              s.lastActivity.delete(clientKey(client.root, client.serverID))
              s.clientPid.delete(clientKey(client.root, client.serverID))
            }
            await Promise.all(idle.map((client) => shutdownClient(client)))
          }
        }

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          const handle = await server
            .spawn(root, ctx, flags)
            .then((value) => {
              if (!value) s.broken.add(key)
              return value
            })
            .catch(() => {
              s.broken.add(key)
              return undefined
            })

          if (!handle) return undefined
          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            root,
            directory: ctx.directory,
            instance: ctx,
          }).catch(async () => {
            s.broken.add(key)
            await Process.stop(handle.process)
            return undefined
          })

          if (!client) return undefined

          const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (existing) {
            await Process.stop(handle.process)
            s.lastActivity.set(key, Date.now())
            return existing
          }

          s.clients.push(client)
          s.lastActivity.set(key, Date.now())
          if (typeof handle.process.pid === "number") s.clientPid.set(key, handle.process.pid)
          return client
        }

        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue

          const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (match) {
            s.lastActivity.set(root + server.id, Date.now())
            result.push(match)
            continue
          }

          const inflight = s.spawning.get(root + server.id)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            s.lastActivity.set(root + server.id, Date.now())
            result.push(client)
            continue
          }

          const task = schedule(server, root, root + server.id)
          s.spawning.set(root + server.id, task)

          task.finally(() => {
            if (s.spawning.get(root + server.id) === task) {
              s.spawning.delete(root + server.id)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          updated++
        }

        return { result, updated }
      })
      yield* Effect.forEach(Array.from({ length: clients.updated }), () => events.publish(Event.Updated, {}), {
        discard: true,
      })
      return clients.result
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const clients = yield* getClients(file)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      const now = Date.now()
      for (const client of s.clients) s.lastActivity.set(clientKey(client.root, client.serverID), now)
      return yield* Effect.promise(() => Promise.all(s.clients.map((x) => fn(x))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const reload = Effect.fn("LSP.reload")(function* () {
      const s = yield* InstanceState.get(state)
      const banyanOption = yield* Effect.serviceOption(Banyan.BanyanConfigService)
      const banyanConfig = Option.isSome(banyanOption) ? yield* banyanOption.value.get() : ({} as Banyan.BanyanConfigInfo)
      const lsp = banyanConfig.banyancode_lsp

      const newServers: Record<string, LSPServer.Info> = {}

      if (lsp) {
        for (const candidate of Object.values(LSPServer)) {
          if (!candidate || typeof candidate !== "object" || !("id" in candidate) || !("spawn" in candidate))
            continue
          const server = candidate as LSPServer.Info
          newServers[server.id] = server
        }

        filterExperimentalServers(newServers, flags)

        if (lsp !== true) {
          for (const [name, item] of Object.entries(lsp)) {
            const existing = newServers[name]
            if (item.disabled) {
              delete newServers[name]
              continue
            }
            newServers[name] = {
              ...existing,
              id: name,
              root: existing?.root ?? (async (_file, ctx) => ctx.directory),
              extensions: item.extensions ?? existing?.extensions ?? [],
              spawn: item.command
                ? async (root) => ({
                    process: lspspawn(item.command![0], item.command!.slice(1), {
                      cwd: root,
                      env: { ...process.env, ...item.env },
                    }),
                    initialization:
                      name === "typescript" ? mergeServerInitialization(name, undefined, item) : item.initialization,
                  })
                : existing?.spawn
                  ? async (root, ctx, flags) => {
                      const handle = await existing.spawn(root, ctx, flags)
                      if (!handle) return undefined
                      return {
                        ...handle,
                        initialization: mergeServerInitialization(name, handle.initialization, item),
                      }
                    }
                  : async () => undefined,
            }
          }
        }
      }

      const disabled = new Map<string, string>()
      if (lsp && typeof lsp === "object") {
        for (const [name, item] of Object.entries(lsp)) {
          if (item && typeof item === "object" && "disabled" in item && item.disabled) {
            disabled.set(name, "disabled in banyancode.json")
          }
        }
      }

      s.servers = newServers
      s.disabled = disabled
      s.configEnabled = Boolean(lsp)
      s.idleTimeoutMs = resolveLspIdleTimeoutMs(banyanConfig.banyancode_lsp_idle_timeout_ms)
      s.broken.clear()

      // Shutdown any clients that are no longer configured
      const toRemove: LSPClient.Info[] = []
      for (const client of s.clients) {
        if (!newServers[client.serverID]) {
          toRemove.push(client)
        }
      }
      if (toRemove.length > 0) {
        s.clients = s.clients.filter((c) => !toRemove.includes(c))
        for (const client of toRemove) {
          s.lastActivity.delete(clientKey(client.root, client.serverID))
          s.clientPid.delete(clientKey(client.root, client.serverID))
        }
        yield* Effect.promise(() => Promise.all(toRemove.map((c) => shutdownClient(c))))
      }

      yield* events.publish(Event.Updated, {})
    })

    const onGlobalEvent = (evt: GlobalEvent) => {
      if (evt.payload?.type === "banyancode.config.updated") {
        Effect.runFork(reload().pipe(Effect.catchCause(() => Effect.void)))
      }
    }
    GlobalBus.on("event", onGlobalEvent)
    yield* Effect.addFinalizer(() => Effect.sync(() => { GlobalBus.off("event", onGlobalEvent) }))

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      const seen = new Set<string>()
      const rssByKey = yield* Effect.promise(() =>
        Promise.all(
          s.clients.map((client) => readProcessTreeRss(s.clientPid.get(clientKey(client.root, client.serverID)))),
        ),
      )
      // Currently-attached clients first (status: connected).
      for (const [index, client] of s.clients.entries()) {
        const server = s.servers[client.serverID]
        seen.add(client.serverID)
        const clientCount = s.clients.filter((c) => c.serverID === client.serverID).length
        const rssBytes = rssByKey[index]
        const pid = s.clientPid.get(clientKey(client.root, client.serverID))
        result.push({
          id: client.serverID,
          name: server?.id ?? client.serverID,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
          autoDownload: server?.autoDownload ?? false,
          languages: server ? languagesForServer(server) : [],
          inert: false,
          disabled: false,
          clientCount,
          ...(rssBytes !== undefined ? { rssBytes } : {}),
          ...(pid !== undefined ? { pid } : {}),
        })
      }
      // Then configured servers that failed to spawn (status: error)
      for (const server of Object.values(s.servers)) {
        if (seen.has(server.id)) continue
        const isBroken = Array.from(s.broken).some((k) => k.endsWith(server.id))
        if (isBroken) {
          seen.add(server.id)
          result.push({
            id: server.id,
            name: server.id,
            root: "",
            status: "error",
            autoDownload: server.autoDownload ?? false,
            languages: languagesForServer(server),
            inert: false,
            disabled: false,
            clientCount: 0,
          })
        }
      }
      // Then every other configured server that has not yet attached.
      for (const server of Object.values(s.servers)) {
        if (seen.has(server.id)) continue
        result.push({
          id: server.id,
          name: server.id,
          root: "",
          status: "configured",
          autoDownload: server.autoDownload ?? false,
          languages: languagesForServer(server),
          inert: true,
          disabled: false,
          clientCount: 0,
        })
      }
      // Then any server the user explicitly disabled in banyancode_lsp
      for (const [name, reason] of s.disabled.entries()) {
        if (seen.has(name)) continue
        result.push({
          id: name,
          name,
          root: "",
          status: "configured",
          autoDownload: false,
          languages: LSP_LANGUAGE_MAP[name] ?? [],
          inert: true,
          disabled: true,
          disabledReason: reason,
          clientCount: 0,
        })
      }
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      const clients = yield* getClients(input)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch(() => {}),
      )
      const s = yield* InstanceState.get(state)
      const now = Date.now()
      for (const client of clients) s.lastActivity.set(clientKey(client.root, client.serverID), now)
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      reload,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make(layer, [RuntimeFlags.node, FSUtil.node, EventV2Bridge.node])

export * as LSP from "./lsp"
