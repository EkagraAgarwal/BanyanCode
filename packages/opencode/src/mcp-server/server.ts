// Bootstrap for `banyancode mcp serve`.
//
// Mirrors the shape of packages/opencode/src/cli/cmd/acp.ts:19-30:
// an in-process Server.listen on loopback, with an SDK v2 client built
// against it via ServerAuth.headers. Code tools (tools-code.ts) and task
// tools (tools-task.ts) register group-conditionally per the
// banyancode_mcp_server `tools` allowlist; the TaskEngine is wired with the
// real SDK SessionClient, the policy ruleset builder, and session-metadata
// rehydrate lookup.

import path from "path"
import { stat } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { BanyanConfig } from "@opencode-ai/core/v1/config/banyan-config"
import type { PermissionRuleset } from "@opencode-ai/sdk/v2"
import type { TaskEngine } from "./task-engine"
import type { EngineEventSource, EngineSessionClient, EngineSessionLookup } from "./task-engine"
import type { SessionClient } from "./tasks"
import { resolveOutputChars } from "./output"
import { DEFAULT_RESULT_MAX_TOKENS } from "./result"
import { DEFAULT_NEEDS_INPUT_TIMEOUT_MS } from "./task-engine"

export type McpBootstrapOptions = {
  cwd?: string
  attach?: string
  allowYolo?: boolean
  // CLI overrides for banyancode_mcp_server keys (flags land here; a later
  // pass adds --agent/--model/--permission/--max-tasks to cli/cmd/mcp.ts).
  // Every override wins over the stored config.
  defaultAgent?: string
  defaultModel?: string
  permission?: "reject" | "edits" | "yolo"
  maxConcurrentTasks?: number
  toolGroups?: string[]
}

export type ResolvedMcpServerConfig = {
  defaultAgent?: string
  defaultModel?: string
  // yolo only via the allowYolo process flag — never from stored config.
  permission: "reject" | "edits" | "yolo"
  maxConcurrentTasks: number
  resultMaxTokens: number
  needsInputTimeoutMs: number
  outputChars: number
  allowedAgents?: string[]
  allowedModels?: string[]
  // undefined = every group enabled.
  toolGroups?: string[]
}

export type McpBootstrap = {
  mcp: McpServer
  sdk: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>
  baseUrl: string
  cwd: string
  config: ResolvedMcpServerConfig
  engine: TaskEngine | undefined
  cleanup: () => Promise<void>
}

// Stdout belongs to the MCP protocol in stdio mode. All diagnostics go
// to stderr so no non-JSON-RPC bytes ever land on stdout.
export function log(message: string) {
  process.stderr.write(`[mcp-server] ${message}\n`)
}

export async function resolveCwd(input?: string): Promise<string> {
  const raw = input ?? process.cwd()
  const resolved = path.resolve(raw)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch {
    throw new Error(`--cwd does not exist: ${raw}`)
  }
  if (!info.isDirectory()) throw new Error(`--cwd is not a directory: ${raw}`)
  return resolved
}

// Env keys that must never reach agent-spawned child processes. The
// in-process server password is deleted from process.env right after listen
// resolves, but this scrub is defense-in-depth for the spawn env maps —
// wire it into the shell/tool spawn paths (see util/process.ts,
// pty-preparation.ts, session/prompt.ts shell.env).
const SERVER_SECRET_ENV_KEYS = ["OPENCODE_SERVER_PASSWORD", "BANYANCODE_SERVER_PASSWORD"] as const

export function scrubServerSecretsFromEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of SERVER_SECRET_ENV_KEYS) delete next[key]
  return next
}

// True when `target` equals `root` or lives under it. Case-insensitive on
// win32, where the filesystem is case-preserving but not case-sensitive.
export function isEqualOrAncestor(root: string, target: string): boolean {
  const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s)
  const resolvedRoot = fold(path.resolve(root))
  const resolvedTarget = fold(path.resolve(target))
  if (resolvedTarget === resolvedRoot) return true
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep
  return resolvedTarget.startsWith(prefix)
}

// Group allowlist gate (B6): an absent `tools` key enables every group;
// a present key enables exactly the listed groups.
export function isToolGroupEnabled(groups: string[] | undefined, group: string): boolean {
  if (groups === undefined) return true
  return groups.includes(group)
}

// Read banyancode_mcp_server through Banyan.BanyanConfigService (never
// Config.Service.getGlobal().banyancode_*, which fails typecheck — those
// keys live in BanyanConfig.Info). Unreadable config falls back to
// reject-everything defaults; CLI overrides win over stored values.
export async function resolveMcpServerConfig(
  overrides: Pick<
    McpBootstrapOptions,
    "defaultAgent" | "defaultModel" | "permission" | "maxConcurrentTasks" | "toolGroups"
  > = {},
): Promise<ResolvedMcpServerConfig> {
  const { Banyan } = await import("@opencode-ai/core/banyancode")
  const { Effect } = await import("effect")
  const { DEFAULT_MAX_SUBAGENTS } = await import("@opencode-ai/core/v1/config/banyan-config")
  const stored = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* Banyan.BanyanConfigService
      return yield* svc.get()
    }).pipe(Effect.provide(Banyan.banyanConfigServiceDefaultLayer)),
  ).catch(() => ({} as BanyanConfig.Info))
  const mcpCfg = stored.banyancode_mcp_server
  const permission = overrides.permission ?? mcpCfg?.permission ?? "reject"
  const cap = Math.min(
    mcpCfg?.max_concurrent_tasks ?? DEFAULT_MAX_SUBAGENTS,
    stored.banyancode_max_subagents ?? DEFAULT_MAX_SUBAGENTS,
  )
  const resolved: ResolvedMcpServerConfig = {
    permission,
    maxConcurrentTasks: overrides.maxConcurrentTasks ?? Math.max(1, cap),
    resultMaxTokens: mcpCfg?.result_max_tokens ?? DEFAULT_RESULT_MAX_TOKENS,
    needsInputTimeoutMs: (mcpCfg?.needs_input_timeout_seconds ?? DEFAULT_NEEDS_INPUT_TIMEOUT_MS / 1000) * 1000,
    outputChars: mcpCfg?.output_max_chars ?? resolveOutputChars(),
  }
  const defaultAgent = overrides.defaultAgent ?? mcpCfg?.default_agent
  if (defaultAgent !== undefined) resolved.defaultAgent = defaultAgent
  const defaultModel = overrides.defaultModel ?? mcpCfg?.default_model
  if (defaultModel !== undefined) resolved.defaultModel = defaultModel
  if (mcpCfg?.allowed_agents !== undefined) resolved.allowedAgents = [...mcpCfg.allowed_agents]
  if (mcpCfg?.allowed_models !== undefined) resolved.allowedModels = [...mcpCfg.allowed_models]
  const toolGroups = overrides.toolGroups ?? mcpCfg?.tools
  if (toolGroups !== undefined) resolved.toolGroups = [...toolGroups]
  return resolved
}

// session.get/session.list responses carry metadata either top-level or
// under info, depending on the endpoint. String values only — the engine
// matches on exact metadata markers (origin, mcp_handle, mcp_state).
function readSessionMetadata(data: unknown): Record<string, string> {
  const root = (data ?? {}) as { metadata?: unknown; info?: { metadata?: unknown } }
  const raw = root.metadata ?? root.info?.metadata ?? {}
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value
  }
  return out
}

// B7 session identity: every MCP-owned session carries an `[mcp]` title
// prefix plus origin/mcp_client metadata so it shows up in the TUI session
// list, telemetry, and /session/:id/mesh. Pure helpers so the protocol tests
// can pin them without booting a server.
export const MCP_SESSION_TITLE_PREFIX = "[mcp] " as const

export function mcpSessionTitle(title?: string): string {
  if (title?.startsWith(MCP_SESSION_TITLE_PREFIX)) return title
  return `${MCP_SESSION_TITLE_PREFIX}${title ?? "mcp task"}`
}

export function mcpSessionMetadata(input: {
  policy: string
  isolation?: string
  metadata: Record<string, string>
}): Record<string, string> {
  return { policy: input.policy, isolation: input.isolation ?? "shared", ...input.metadata, origin: "mcp" }
}
// Fail-closed guard for --attach: the attached server's own worktree must
// equal --cwd or be an ancestor of it, otherwise the server would resolve
// requests against a different base than the paths we validate. Probed
// without a directory override so the answer reflects the server's own
// root, not ours.
async function assertAttachedServerCovers(input: {
  baseUrl: string
  cwd: string
  headers: Record<string, string> | undefined
}): Promise<void> {
  const refuse = (detail: string): never => {
    const message =
      `mcp serve --attach ${input.baseUrl}: refusing to start — ` +
      `attached server worktree (${detail}) is not --cwd ${input.cwd} or an ancestor of it. ` +
      `Start the server in ${input.cwd}, or pass a matching --attach URL.`
    log(message)
    throw new Error(message)
  }
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
  const probe = createOpencodeClient({ baseUrl: input.baseUrl, headers: input.headers })
  let worktree: unknown
  try {
    const result = await probe.project.current(undefined, { throwOnError: true })
    worktree = (result.data as { worktree?: unknown } | undefined)?.worktree
  } catch (error) {
    const message =
      `mcp serve --attach ${input.baseUrl}: refusing to start — ` +
      `could not read the attached server's current project (${error instanceof Error ? error.message : String(error)}).`
    log(message)
    throw new Error(message, { cause: error })
  }
  if (typeof worktree !== "string" || !isEqualOrAncestor(worktree, input.cwd)) refuse(String(worktree))
}

export async function createMcpServer(opts: McpBootstrapOptions = {}): Promise<McpBootstrap> {
  const cwd = await resolveCwd(opts.cwd)
  const { ServerAuth } = await import("@/server/auth")
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")

  const mcp = new McpServer({ name: "banyancode", version: InstallationVersion })
  const { registerCodeTools } = await import("./tools-code")
  const { registerTaskTools } = await import("./tools-task")
  const { TaskEngine } = await import("./task-engine")
  const { buildRuleset, assertYoloAllowed } = await import("./policy")
  const { createSdkSessionClient, splitModelRef } = await import("./session-client")

  const config = await resolveMcpServerConfig(opts)
  assertYoloAllowed(opts.allowYolo ?? false, config.permission)

  const wire = async (sdk: ReturnType<typeof createOpencodeClient>): Promise<TaskEngine | undefined> => {
    if (!isToolGroupEnabled(config.toolGroups, "task")) {
      if (isToolGroupEnabled(config.toolGroups, "code")) registerCodeTools(mcp, { sdk, cwd })
      log(`tool group allowlist hides the task tools (groups: ${(config.toolGroups ?? []).join(",")})`)
      return undefined
    }
    // Session ruleset from the policy at creation time (§4.2): the MCP rows
    // go through session.create, which the server merges after the agent's
    // own rules (later rules win, findLast). yolo additionally needs the
    // process flag, asserted above — stored config can never express it.
    const v1Ruleset = buildRuleset(config.permission, cwd)
    const ruleset: PermissionRuleset = v1Ruleset.map((row) => ({
      permission: row.permission,
      pattern: row.pattern,
      action: row.action,
    }))
    const defaultModel = config.defaultModel !== undefined ? splitModelRef(config.defaultModel) : undefined
    const sessions: SessionClient = await createSdkSessionClient({
      sdk,
      directory: cwd,
      ...(config.defaultAgent !== undefined ? { defaultAgent: config.defaultAgent } : {}),
      ...(defaultModel !== undefined
        ? { defaultModel: { providerID: defaultModel.providerID, id: defaultModel.modelID } }
        : {}),
      permission: ruleset,
      metadata: { origin: "mcp" },
    })
    // session.update replaces metadata wholesale, so every write is a
    // read-merge-write. Shared by the engine (queue/done markers) and the
    // task tools (mcp_handle backfill).
    const writeMetadata = async (input: { sessionID: string; metadata: Record<string, string> }): Promise<void> => {
      const got = await sdk.session.get({ sessionID: input.sessionID, directory: cwd })
      if (!("data" in got) || got.data === undefined || got.data === null) {
        throw new Error(`session.get returned no data for ${input.sessionID}`)
      }
      const merged = { ...readSessionMetadata(got.data), ...input.metadata }
      const updated = await sdk.session.update({ sessionID: input.sessionID, directory: cwd, metadata: merged })
      if ("error" in updated && updated.error !== undefined && updated.error !== null) {
        throw new Error(`session.update failed for ${input.sessionID}: ${JSON.stringify(updated.error)}`)
      }
    }
    // Engine adapter (B7): the [mcp] title prefix and the origin/mcp_client
    // metadata flow into session creation here, and per-task agent/model/
    // permission ruleset pass through (E1). policy/isolation beyond the
    // ruleset fall back to the server defaults (E3 — port passthrough for
    // raw policy/isolation strings is follow-up work).
    const engineClient: EngineSessionClient = {
      createSession: (input) =>
        sessions.createSession({
          title: mcpSessionTitle(input.title),
          metadata: mcpSessionMetadata({ policy: config.permission, metadata: input.metadata }),
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.permission !== undefined
            ? {
                permission: input.permission.map((row) => ({
                  permission: row.permission,
                  pattern: row.pattern,
                  action: row.action,
                })),
              }
            : {}),
        }),
      promptAsync: (input) => sessions.promptAsync(input),
      abort: (input) => sessions.abort(input),
      sessionStatus: (input) => sessions.sessionStatus(input),
      messages: (input) => sessions.messages(input),
      pending: (input) => sessions.pending(input),
      replyPermission: (input) => sessions.replyPermission(input),
      rejectQuestion: (input) => sessions.rejectQuestion(input),
      replyQuestion: (input) => sessions.replyQuestion(input),
      writeMetadata,
    }
    const lookup: EngineSessionLookup = {
      findSession: async (input) => {
        try {
          const got = await sdk.session.get({ sessionID: input.sessionID, directory: cwd })
          if (!("data" in got) || got.data === undefined || got.data === null) return undefined
          return { metadata: readSessionMetadata(got.data) }
        } catch {
          return undefined
        }
      },
      listMcpSessions: async () => {
        const listed = await sdk.session.list({ directory: cwd })
        if (!("data" in listed) || !Array.isArray(listed.data)) {
          throw new Error("session.list returned no data")
        }
        const out: Array<{ sessionID: string; metadata: Record<string, string> }> = []
        for (const item of listed.data) {
          const id = (item as { id?: unknown }).id
          if (typeof id !== "string") continue
          const metadata = readSessionMetadata(item)
          if (metadata["origin"] === "mcp") out.push({ sessionID: id, metadata })
        }
        return out
      },
    }
    // No live event drain yet: the engine's refresh-on-status path covers
    // every transition (pending auto-reject, needs_input timers, done
    // detection), so task_status stays correct without SSE. Wiring
    // sdk.event.subscribe (in-process) / global.event (--attach) into an
    // EngineEventSource is follow-up work that needs no engine change.
    const events: EngineEventSource = { subscribe: () => () => {} }
    const engine = new TaskEngine(engineClient, lookup, events, {
      maxConcurrentTasks: config.maxConcurrentTasks,
      needsInputTimeoutMs: config.needsInputTimeoutMs,
    })
    if (isToolGroupEnabled(config.toolGroups, "code")) registerCodeTools(mcp, { sdk, cwd })
    registerTaskTools(mcp, {
      engine,
      sessions,
      directory: cwd,
      updateMetadata: writeMetadata,
      // Read lazily: at registration time initialize has not run yet, so
      // the client version is still undefined (§8.1 notes it becomes
      // per-request clientInfo on modern transports — this is the v1 API).
      // Probed structurally: the SDK declares getClientVersion on the
      // Protocol base, not on the McpServer public type.
      getMcpClientName: () => {
        const probe = mcp as unknown as { getClientVersion?: () => { name?: string } | undefined }
        return probe.getClientVersion?.()?.name ?? "unknown"
      },
      config: {
        permission: config.permission,
        allowYolo: opts.allowYolo ?? false,
        ...(config.allowedAgents !== undefined ? { allowedAgents: config.allowedAgents } : {}),
        ...(config.allowedModels !== undefined ? { allowedModels: config.allowedModels } : {}),
        resultMaxTokens: config.resultMaxTokens,
        outputChars: config.outputChars,
      },
    })
    log(
      `task tools registered (permission ${config.permission}, maxConcurrentTasks ${config.maxConcurrentTasks}, outputChars ${config.outputChars})`,
    )
    return engine
  }

  if (opts.attach) {
    const baseUrl = opts.attach
    const headers = ServerAuth.headers()
    const sdk = createOpencodeClient({ baseUrl, directory: cwd, headers })
    await assertAttachedServerCovers({ baseUrl, cwd, headers })
    const engine = await wire(sdk)
    log(`attached to running server at ${baseUrl} (cwd ${cwd})`)
    return { mcp, sdk, baseUrl, cwd, config, engine, cleanup: async () => {} }
  }

  // In-process mode owns this process: chdir BEFORE the listener starts so
  // identityForRoot and every other process.cwd() consumer resolve against
  // the requested root, not the launcher's directory.
  process.chdir(cwd)

  // Fresh in-process server: loopback bind, random per-process password
  // that is never printed. The listener snapshots OPENCODE_SERVER_PASSWORD
  // into its per-listener ConfigProvider at listen time (the value is
  // materialized into ServerAuth.Config.defaultLayer during Layer.build),
  // so the env var is restored immediately after listen resolves — a bash
  // tool child process must never inherit it and approve its own
  // permission requests. A pre-existing value is restored, not destroyed.
  const password = randomBytes(32).toString("base64url")
  const priorPassword = process.env.OPENCODE_SERVER_PASSWORD
  process.env.OPENCODE_SERVER_PASSWORD = password
  const { Server } = await import("@/server/server")
  let listener: Awaited<ReturnType<typeof Server.listen>>
  try {
    // Ephemeral: never claim the well-known 4096 port (see §2.5).
    listener = await Server.listen({ hostname: "127.0.0.1", port: 0, ephemeral: true, cors: [] })
  } finally {
    if (priorPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = priorPassword
  }
  const baseUrl = `http://${listener.hostname}:${listener.port}`
  const sdk = createOpencodeClient({ baseUrl, directory: cwd, headers: ServerAuth.headers({ password }) })
  const engine = await wire(sdk)
  log(`in-process server listening on ${baseUrl} (cwd ${cwd})`)
  return {
    mcp,
    sdk,
    baseUrl,
    cwd,
    config,
    engine,
    cleanup: async () => {
      await listener.stop(true).catch(() => {})
    },
  }
}

export * as McpBootstrapServer from "./server"
