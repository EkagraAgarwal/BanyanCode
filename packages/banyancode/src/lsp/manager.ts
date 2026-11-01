import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import * as LSPClient from "./client.js"
import type { Info } from "./types.js"
import { normalizePath } from "./fs.js"
import { stop } from "./process.js"
import type { Resolved } from "./config.js"
import type { Diagnostic, DocumentSymbol, Instance, LspServerStatus, LspStatus, Location, Symbol } from "./types.js"
import { notifyChange } from "./state.js"

/**
 * LSP client manager. Port of v1 `packages/opencode/src/lsp/lsp.ts`:
 * lazy spawn on first relevant file, one client per (root, server), broken
 * server memoization, global + per-server idle shutdown, and the same status
 * shape reported to the TUI.
 *
 * Deliberate differences from v1:
 * - one unref'd sweep timer per manager instead of lazily checking idle only
 *   during file access (idle servers now exit even when the workspace is quiet)
 * - no `GlobalBus` subscription: v1 reacted to `banyancode.config.updated`;
 *   v2 has no plugin event bus, so the manager re-resolves config when it is
 *   older than a second at the start of each operation.
 */

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

const languagesForServer = (server: Info): string[] => {
  const mapped = LSP_LANGUAGE_MAP[server.id]
  if (mapped) return [...mapped]
  return Array.from(new Set(server.extensions.map((ext) => ext.replace(/^\./, "").toLowerCase()))).slice(0, 6)
}

const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const

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

interface Attached {
  readonly client: LSPClient.Info
  readonly serverID: string
  readonly root: string
  lastActivity: number
  readonly pid?: number
}

const keyOf = (root: string, serverID: string) => root + serverID

const containsPath = (file: string, instance: Instance) => {
  const target = normalizePath(path.resolve(file))
  const inside = (root: string) => {
    const rel = path.relative(normalizePath(root), target)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  }
  if (instance.worktree === "/") return inside(instance.directory)
  return inside(instance.directory) || inside(instance.worktree)
}

const shutdown = async (client: LSPClient.Info) => {
  await client.shutdown().catch(() => {})
}

export interface Manager {
  readonly instance: Instance
  readonly touch: (file: string, mode?: "document" | "full") => Promise<void>
  readonly diagnostics: () => Promise<Record<string, Diagnostic[]>>
  readonly hasClients: (file: string) => Promise<boolean>
  readonly status: () => LspStatus
  readonly enabled: () => boolean
  readonly idleTimeoutMs: () => number
  readonly reload: () => Promise<void>
  readonly dispose: () => Promise<void>
  readonly hover: (input: Location) => Promise<unknown[]>
  readonly definition: (input: Location) => Promise<unknown[]>
  readonly references: (input: Location) => Promise<unknown[]>
  readonly implementation: (input: Location) => Promise<unknown[]>
  readonly documentSymbol: (uri: string) => Promise<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Promise<Symbol[]>
  readonly prepareCallHierarchy: (input: Location) => Promise<unknown[]>
  readonly incomingCalls: (input: Location) => Promise<unknown[]>
  readonly outgoingCalls: (input: Location) => Promise<unknown[]>
}

export const create = (input: {
  readonly instance: Instance
  readonly resolve: () => Promise<Resolved>
  /** Overridable for tests; defaults to a 1s staleness window. */
  readonly reloadIntervalMs?: number
  readonly sweepIntervalMs?: number
  readonly now?: () => number
}): Manager => {
  const now = input.now ?? (() => Date.now())
  const reloadIntervalMs = input.reloadIntervalMs ?? 1_000
  let config: Resolved = {
    enabled: false,
    servers: {},
    disabled: new Map(),
    idleTimeoutMs: 5 * 60 * 1000,
    perServerIdleTimeoutMs: new Map(),
    flags: { disableLspDownload: true, experimentalLspTy: false, experimentalLspTool: false },
  }
  let attached: Attached[] = []
  let broken = new Set<string>()
  let spawning = new Map<string, Promise<LSPClient.Info | undefined>>()
  let resolvedAt = 0
  let disposed = false
  let sweeping = false
  let busy = 0
  let signature = ""
  let timer: ReturnType<typeof setTimeout> | undefined

  const idleFor = (serverID: string) => config.perServerIdleTimeoutMs.get(serverID) ?? config.idleTimeoutMs

  const detach = async (entries: Attached[]) => {
    if (entries.length === 0) return
    const remove = new Set(entries)
    attached = attached.filter((item) => !remove.has(item))
    notifyChange()
    await Promise.all(entries.map((item) => shutdown(item.client)))
  }

  const sweepIdle = async () => {
    // An in-flight open/diagnostic wait counts as activity; v1 checked idle
    // only at access time and could never race its own operation.
    if (sweeping || busy > 0 || disposed) return
    sweeping = true
    try {
      const timestamp = now()
      const idle = attached.filter((item) => {
        const timeout = idleFor(item.serverID)
        if (timeout <= 0) return false
        return timestamp - item.lastActivity > timeout
      })
      await detach(idle)
    } finally {
      sweeping = false
    }
  }

  const arm = () => {
    if (disposed) return
    const base = input.sweepIntervalMs ?? Math.max(500, Math.min(30_000, (config.idleTimeoutMs || 60_000) / 2))
    timer = setTimeout(async () => {
      await sweepIdle()
      arm()
    }, base)
    timer.unref?.()
  }
  arm()

  const resolveNow = async (force: boolean) => {
    if (!force && resolvedAt !== 0 && now() - resolvedAt < reloadIntervalMs) return
    const next = await input.resolve()
    resolvedAt = now()
    config = next
    if (!next.enabled) {
      await detach([...attached])
      return
    }
    // Shut down clients whose server disappeared or whose definition changed.
    const stale = attached.filter((item) => {
      const server = next.servers[item.serverID]
      if (server) return false
      return true
    })
    await detach(stale)
    const nextSignature = Object.keys(next.servers).sort().join(",")
    if (nextSignature !== signature) {
      signature = nextSignature
      broken = new Set()
    }
    notifyChange()
  }

  const snapshotStatus = (): LspStatus => {
    const servers: LspServerStatus[] = []
    const seen = new Set<string>()
    for (const item of attached) {
      const server = config.servers[item.serverID]
      seen.add(item.serverID)
      servers.push({
        id: item.serverID,
        name: server?.id ?? item.serverID,
        root: path.relative(input.instance.directory, item.root),
        status: "connected",
        autoDownload: server?.autoDownload ?? false,
        languages: server ? languagesForServer(server) : [],
        inert: false,
        disabled: false,
        clientCount: attached.filter((entry) => entry.serverID === item.serverID).length,
        ...(item.pid !== undefined ? { pid: item.pid } : {}),
      })
    }
    for (const server of Object.values(config.servers)) {
      if (seen.has(server.id)) continue
      const isBroken = [...broken].some((key) => key.endsWith(server.id))
      if (isBroken) {
        seen.add(server.id)
        servers.push({
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
    for (const server of Object.values(config.servers)) {
      if (seen.has(server.id)) continue
      servers.push({
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
    for (const [name, reason] of config.disabled.entries()) {
      if (seen.has(name)) continue
      servers.push({
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
    return { enabled: config.enabled, idleTimeoutMs: config.idleTimeoutMs, servers }
  }

  const schedule = async (server: Info, root: string, key: string): Promise<LSPClient.Info | undefined> => {
    const handle = await server
      .spawn(root, input.instance, config.flags)
      .then((value) => {
        if (!value) broken.add(key)
        return value
      })
      .catch(() => {
        broken.add(key)
        return undefined
      })
    if (!handle) {
      notifyChange()
      return undefined
    }

    const client = await LSPClient.create({
      serverID: server.id,
      server: handle,
      root,
      directory: input.instance.directory,
    }).catch(async () => {
      broken.add(key)
      await stop(handle.process)
      return undefined
    })
    if (!client) {
      notifyChange()
      return undefined
    }

    // The scope may close while a spawn is in flight; never attach (or leak) a
    // server after dispose took its snapshot.
    if (disposed) {
      await client.shutdown().catch(() => {})
      return undefined
    }

    const existing = attached.find((item) => item.root === root && item.serverID === server.id)
    if (existing) {
      await stop(handle.process)
      existing.lastActivity = now()
      return existing.client
    }

    attached.push({
      client,
      serverID: server.id,
      root,
      lastActivity: now(),
      ...(typeof handle.process.pid === "number" ? { pid: handle.process.pid } : {}),
    })
    notifyChange()
    return client
  }

  const clientsFor = async (file: string): Promise<LSPClient.Info[]> => {
    if (disposed) return []
    if (!containsPath(file, input.instance)) return []
    await resolveNow(false)
    if (!config.enabled) return []
    await sweepIdle()
    const extension = path.parse(file).ext || file
    const result: LSPClient.Info[] = []

    for (const server of Object.values(config.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue
      const root = await server.root(file, input.instance)
      if (!root) continue
      const key = keyOf(root, server.id)
      if (broken.has(key)) continue

      const match = attached.find((item) => item.root === root && item.serverID === server.id)
      if (match) {
        match.lastActivity = now()
        result.push(match.client)
        continue
      }

      const inflight = spawning.get(key)
      if (inflight) {
        const client = await inflight
        if (!client) continue
        const entry = attached.find((item) => item.root === root && item.serverID === server.id)
        if (entry) entry.lastActivity = now()
        result.push(client)
        continue
      }

      const task = schedule(server, root, key)
      spawning.set(key, task)
      const client = await task
      spawning.delete(key)
      if (client) result.push(client)
    }

    return result
  }

  const run = async <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>): Promise<T[]> => {
    const clients = await clientsFor(file)
    return Promise.all(clients.map((client) => fn(client)))
  }

  const runAll = async <T>(fn: (client: LSPClient.Info) => Promise<T>): Promise<T[]> => {
    const timestamp = now()
    for (const item of attached) item.lastActivity = timestamp
    return Promise.all(attached.map((item) => fn(item.client)))
  }

  const positionParams = (location: Location) => ({
    textDocument: { uri: pathToFileURL(location.file).href },
    position: { line: location.line, character: location.character },
  })

  return {
    instance: input.instance,
    touch: async (file, mode) => {
      busy += 1
      try {
        const clients = await clientsFor(file)
        for (const item of attached) {
          if (clients.includes(item.client)) item.lastActivity = now()
        }
        await Promise.all(
          clients.map(async (client) => {
            const after = now()
            const version = await client.notify.open({ path: file })
            if (!mode) return
            return client.waitForDiagnostics({ path: file, version, mode, after })
          }),
        ).catch(() => {})
        const timestamp = now()
        for (const item of attached) {
          if (clients.includes(item.client)) item.lastActivity = timestamp
        }
      } finally {
        busy -= 1
      }
    },
    diagnostics: async () => {
      const results: Record<string, Diagnostic[]> = {}
      const all = await runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [file, items] of result.entries()) {
          const current = results[file] ?? []
          current.push(...items)
          results[file] = current
        }
      }
      return results
    },
    hasClients: async (file) => {
      if (!containsPath(file, input.instance)) return false
      await resolveNow(false)
      if (!config.enabled) return false
      const extension = path.parse(file).ext || file
      for (const server of Object.values(config.servers)) {
        if (server.extensions.length && !server.extensions.includes(extension)) continue
        const root = await server.root(file, input.instance)
        if (!root) continue
        if (broken.has(keyOf(root, server.id))) continue
        return true
      }
      return false
    },
    status: snapshotStatus,
    enabled: () => config.enabled,
    idleTimeoutMs: () => config.idleTimeoutMs,
    reload: async () => {
      await resolveNow(true)
      notifyChange()
    },
    dispose: async () => {
      disposed = true
      if (timer) clearTimeout(timer)
      spawning.clear()
      const clients = [...attached]
      attached = []
      notifyChange()
      await Promise.all(clients.map((item) => shutdown(item.client)))
    },
    hover: async (location) =>
      run(location.file, (client) =>
        client.connection.request("textDocument/hover", positionParams(location)).catch(() => null),
      ),
    definition: async (location) =>
      (
        await run(location.file, (client) =>
          client.connection.request("textDocument/definition", positionParams(location)).catch(() => null),
        )
      )
        .flat()
        .filter(Boolean),
    references: async (location) =>
      (
        await run(location.file, (client) =>
          client.connection
            .request("textDocument/references", { ...positionParams(location), context: { includeDeclaration: true } })
            .catch(() => []),
        )
      )
        .flat()
        .filter(Boolean),
    implementation: async (location) =>
      (
        await run(location.file, (client) =>
          client.connection.request("textDocument/implementation", positionParams(location)).catch(() => null),
        )
      )
        .flat()
        .filter(Boolean),
    documentSymbol: async (uri) => {
      const file = fileURLToPath(uri)
      const results = await run(file, (client) =>
        client.connection.request("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    },
    workspaceSymbol: async (query) => {
      const results = await runAll((client) =>
        client.connection
          .request<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((item) => (kinds as readonly number[]).includes(item.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    },
    prepareCallHierarchy: async (location) =>
      (
        await run(location.file, (client) =>
          client.connection.request("textDocument/prepareCallHierarchy", positionParams(location)).catch(() => []),
        )
      )
        .flat()
        .filter(Boolean),
    incomingCalls: (location) => callHierarchy(location, "callHierarchy/incomingCalls"),
    outgoingCalls: (location) => callHierarchy(location, "callHierarchy/outgoingCalls"),
  }

  async function callHierarchy(
    location: Location,
    direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
  ) {
    const results = await run(location.file, async (client) => {
      const items = await client.connection
        .request<unknown[] | null>("textDocument/prepareCallHierarchy", positionParams(location))
        .catch(() => [] as unknown[])
      if (!items?.length) return []
      return client.connection.request(direction, { item: items[0] }).catch(() => [])
    })
    return results.flat().filter(Boolean)
  }
}

