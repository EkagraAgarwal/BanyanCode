import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { BanyanConfig } from "@opencode-ai/core/v1/config/banyan-config"
import { EventV2 } from "@opencode-ai/core/event"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { InvalidRequestError } from "../errors"
import { CodegraphNodeSchema } from "@opencode-ai/core/banyancode/types"
import { GraphMeta } from "@opencode-ai/core/banyancode/types"
import { MeshStatus } from "@opencode-ai/core/banyancode/mesh-coordinator"
import * as WebSearchFreeTool from "@opencode-ai/core/tool/websearch-free"
import * as PreflightTool from "@opencode-ai/core/tool/preflight"
import * as BlastRadiusTool from "@opencode-ai/core/tool/blast-radius"
import * as SafeRenameTool from "@opencode-ai/core/tool/safe-rename"
import * as TypecheckTool from "@opencode-ai/core/tool/typecheck"
import * as TestTool from "@opencode-ai/core/tool/test"
import * as LintTool from "@opencode-ai/core/tool/lint"

const CodegraphEdgesQuery = Schema.Struct({
  nodeID: Schema.optional(Schema.String),
})

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const SyncEventSchemas = EventV2.registry
  .values()
  .flatMap((definition) => {
    if (!definition.sync) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.sync.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventV2.registry
      .values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.optional(Schema.String),
})

export const BanyanConfigUpdateInput = Schema.Struct({
  config: BanyanConfig.Info,
  scope: Schema.optional(Schema.Literals(["global", "project"])),
})

export const BanyanAgentSaveInput = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9._-]+$/, {
      identifier: "BanyanAgentName",
      description: "Agent name (letters, digits, '.', '_', '-' only; no path separators or whitespace)",
    }),
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(280))),
  mode: Schema.optional(Schema.Literals(["primary", "subagent", "all"])),
  hidden: Schema.optional(Schema.Boolean),
  model: Schema.optional(
    Schema.Struct({
      providerID: Schema.String.check(Schema.isMaxLength(128)),
      modelID: Schema.String.check(Schema.isMaxLength(128)),
    }),
  ),
  permission: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(128)))),
  tools: Schema.optional(
    Schema.Array(
      Schema.String.check(
        Schema.isPattern(/^[a-zA-Z0-9_]+$/, {
          identifier: "BanyanAgentToolName",
          description: "Tool name (letters, digits, underscores only; no path separators)",
        }),
        Schema.isMaxLength(128),
      ),
    ),
  ),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(50_000))),
})

export const BanyanAgentSaveResult = Schema.Struct({
  ok: Schema.Literal(true),
  filePath: Schema.String,
})

export const BanyanAgentOverrideUpdateInput = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9._-]+$/, {
      identifier: "AgentOverrideName",
      description: "Agent name (letters, digits, '.', '_', '-' only)",
    }),
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  enabled: Schema.optional(Schema.Boolean),
  model: Schema.optional(
    Schema.Union([
      Schema.Struct({
        providerID: Schema.String.check(Schema.isMaxLength(128)),
        modelID: Schema.String.check(Schema.isMaxLength(128)),
      }),
      Schema.Null,
    ]),
  ),
})

export const BanyanAgentPromptUpdateInput = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9._-]+$/, {
      identifier: "AgentPromptName",
      description: "Agent name (letters, digits, '.', '_', '-' only)",
    }),
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  prompt: Schema.String.check(Schema.isMaxLength(50_000)),
})

export const CodegraphBuildInput = Schema.Struct({
  root: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
  // dbPath was removed in the Phase 7 follow-up: storage is canonical per
  // workspace root. The build handler derives the effective DB path from
  // the resolved root via WorkspaceIdentity.identityForRoot and returns
  // it on the result so the client never has to guess where the graph
  // actually went.
  dbPath: Schema.optional(Schema.String),
})

export const CodegraphBuildResult = Schema.Struct({
  started: Schema.Boolean,
  root: Schema.optional(Schema.String),
  dbPath: Schema.optional(Schema.String),
  // Phase 7 follow-up: banyanDir is the canonical .banyancode directory
  // that derived the built DB. Together with `dbPath` this gives the
  // client a single source of truth for "where my graph went".
  banyanDir: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

export const CodegraphStatusQuery = Schema.Struct({
  root: Schema.optional(Schema.String),
})

// Contract for the TUI status pill: persisted codegraph readiness + graph
// metadata, keyed by an explicit workspace root. The wire shape is exact —
// consumers (packages/tui status-pills.tsx) depend on these field names.
export const CodegraphStatusResult = Schema.Struct({
  reason: Schema.Literals(["ready", "missing", "stale", "building", "failed"]),
  autoBuilt: Schema.Boolean,
  graphBuiltAt: Schema.optional(Schema.Number),
  graphVersion: Schema.optional(Schema.Number),
  graphCoverage: Schema.optional(Schema.Number),
  totalFiles: Schema.optional(Schema.Number),
  warning: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

export const CodegraphRemoveInput = Schema.Struct({
  dropFile: Schema.optional(Schema.Boolean),
})

export const CodegraphRemoveResult = Schema.Struct({
  sizeBefore: Schema.Number,
  sizeAfter: Schema.Number,
  droppedFile: Schema.Boolean,
})

// Phase 6 (usage surface): a single `codegraph_tool_usage` row. Consumers
// (the TUI sidebar widget) depend on these field names — `toolId` is the tool
// registry id, `useCount` the lifetime invocation count, `lastUsedAt` the
// epoch-seconds of the most recent invocation.
export const ToolUsageRow = Schema.Struct({
  toolId: Schema.String,
  useCount: Schema.Number,
  lastUsedAt: Schema.Number,
}).annotate({ identifier: "ToolUsageRow" })

export const ToolUsageResult = Schema.Struct({
  tools: Schema.Array(ToolUsageRow),
}).annotate({ identifier: "ToolUsageResult" })

export const WebSearchFreeInput = WebSearchFreeTool.Input
export const WebSearchFreeResult = WebSearchFreeTool.Output

export const PreflightInput = PreflightTool.Input
export const PreflightResult = PreflightTool.Output

export const BlastRadiusInput = BlastRadiusTool.Input
export const BlastRadiusResult = BlastRadiusTool.Output

export const SafeRenameInput = SafeRenameTool.Input
export const SafeRenameResult = SafeRenameTool.Output

export const TypecheckInput = TypecheckTool.Input
export const TypecheckResult = TypecheckTool.Output

export const TestRunInput = TestTool.Input
export const TestRunResult = TestTool.Output

export const LintInput = LintTool.Input
export const LintResult = LintTool.Output

const MeshStatusQuery = Schema.Struct({
  parentSessionID: Schema.String.check(
    Schema.isPattern(/^ses_[a-zA-Z0-9]{16,64}$/, {
      identifier: "MeshParentSessionID",
      description: "Parent session ID (must look like a ses_<id> identifier)",
    }),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  codegraphCancel: "/global/codegraph-cancel",
  codegraphForceKill: "/global/codegraph-force-kill",
  codegraphBuild: "/global/codegraph-build",
  codegraphRemove: "/global/codegraph-remove",
  codegraphStatus: "/global/codegraph-status",
  toolUsage: "/global/tool-usage",
  startup: "/global/startup",
  banyanConfig: "/global/banyan-config",
  codegraphNodes: "/global/codegraph-nodes",
  codegraphEdges: "/global/codegraph-edges",
  banyanAgentSave: "/global/banyan-agent/save",
  banyanAgentOverride: "/global/banyan-agent-override",
  banyanAgentPrompt: "/global/banyan-agent-prompt",
  websearchFree: "/global/websearch-free",
  preflight: "/global/preflight",
  blastRadius: "/global/blast-radius",
  safeRename: "/global/safe-rename",
  meshStatus: "/global/mesh/status",
  typecheck: "/global/typecheck",
  testRun: "/global/test-run",
  lint: "/global/lint",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: [HttpApiSchema.NoContent, GlobalUpgradeInput],
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version or latest if not specified.",
        }),
      ),
      HttpApiEndpoint.get("getBanyanConfig", GlobalPaths.banyanConfig, {
        success: described(BanyanConfig.Info, "BanyanConfig"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.banyanConfig.get",
          summary: "Get BanyanCode config",
          description: "Get the current BanyanCode config from ~/.config/banyancode/banyancode.json.",
        }),
      ),
      HttpApiEndpoint.patch("updateBanyanConfig", GlobalPaths.banyanConfig, {
        payload: BanyanConfigUpdateInput,
        success: described(BanyanConfig.Info, "BanyanConfig updated"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.banyanConfig.update",
          summary: "Update BanyanCode config",
          description: "Update the BanyanCode config in ~/.config/banyancode/banyancode.json.",
        }),
      ),
      HttpApiEndpoint.patch("updateBanyanAgentOverride", GlobalPaths.banyanAgentOverride, {
        payload: BanyanAgentOverrideUpdateInput,
        success: described(BanyanConfig.Info, "Updated BanyanConfig"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.banyanAgentOverride.update",
          summary: "Update per-agent override",
          description: "Atomically update one agent's enabled/model override in ~/.config/banyancode/banyancode.json.",
        }),
      ),
      HttpApiEndpoint.patch("updateBanyanAgentPrompt", GlobalPaths.banyanAgentPrompt, {
        payload: BanyanAgentPromptUpdateInput,
        success: described(BanyanConfig.Info, "Updated BanyanConfig"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.banyanAgentPrompt.update",
          summary: "Update per-agent prompt override",
          description: "Atomically update one agent's prompt override in ~/.config/banyancode/banyancode.json.",
        }),
      ),
      HttpApiEndpoint.post("codegraphCancel", GlobalPaths.codegraphCancel, {
        success: described(Schema.Boolean, "Codegraph build cancelled"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.codegraph.cancel",
          summary: "Cancel codegraph build",
          description: "Cancel the in-flight codegraph build for the current instance.",
        }),
      ),
      HttpApiEndpoint.post("codegraphForceKill", GlobalPaths.codegraphForceKill, {
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            message: Schema.String,
          }),
          "Result of the force-kill attempt",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.codegraph.forceKill",
          summary: "Force-kill the opencode server hosting a wedged codegraph build",
          description:
            "Last-resort escape hatch for a hung codegraph build. First tries a normal Fiber.interrupt, then on Windows spawns an elevated `taskkill /F /PID <pid> /T` against the opencode server process. Kills the whole bun process — the user will need to restart the TUI.",
        }),
      ),
      HttpApiEndpoint.post("codegraphRemove", GlobalPaths.codegraphRemove, {
        payload: CodegraphRemoveInput,
        success: described(CodegraphRemoveResult, "Codegraph remove result"),
        error: HttpApiError.ServiceUnavailable,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.codegraph.remove",
          summary: "Clear the codegraph index for the current instance",
          description:
            "Removes every row from `codegraph_*` tables (or, with `dropFile: true`, deletes the underlying `banyancode.db`). Equivalent to the slash command `/codegraph-remove`.",
        }),
      ),
      HttpApiEndpoint.post("codegraphBuild", GlobalPaths.codegraphBuild, {
        payload: CodegraphBuildInput,
        success: described(CodegraphBuildResult, "Codegraph build kickoff result"),
        // Defense in depth: a declared error schema makes handler failures
        // surface as a typed 4xx with a `.message` instead of the default
        // Respondable's empty 5xx body, which the SDK decodes to neither
        // `data` nor `error.message` and the TUI shows as "no response from
        // server". Mirrors the sibling `codegraphRemove` endpoint.
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.codegraph.build",
          summary: "Build code graph index",
          description:
            "Kick off a codegraph build for the given root (defaults to the current workspace). Runs in the background; progress is published via the banyancode.codegraph.build event.",
        }),
      ),
      HttpApiEndpoint.get("codegraphStatus", GlobalPaths.codegraphStatus, {
        query: CodegraphStatusQuery,
        success: described(CodegraphStatusResult, "Persisted codegraph status for a root"),
        // InvalidRequestError carries a `.message` (HttpApiError.BadRequest in
        // this effect version renders an EMPTY 400 body, losing the root-
        // validation message), so root-validation failures surface as a typed
        // 400 the SDK can decode. Same 400 status the plan calls for.
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.codegraph.status",
          summary: "Get persisted codegraph status",
          description:
            "Read the persisted codegraph build status (missing/ready/stale) plus graph metadata for the given root (defaults to the current workspace). Root validation happens at the HTTP boundary via WorkspaceIdentity.identityForRoot; the status is read from the same canonical per-root DB the build indexer writes to.",
        }),
      ),
      HttpApiEndpoint.get("toolUsage", GlobalPaths.toolUsage, {
        success: described(ToolUsageResult, "Most-used codegraph tools"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.toolUsage",
          summary: "List tool usage",
          description:
            "Return the most-used tools from the `codegraph_tool_usage` table, ordered by use count (lifetime invocation count), capped at 50 rows. The same table drives the hot-tier promotion gate in the adapted tool catalog. Returns an empty list when BanyanCode is disabled.",
        }),
      ),
      HttpApiEndpoint.get("codegraphNodes", GlobalPaths.codegraphNodes, {
        success: described(
          Schema.Struct({
            nodes: Schema.Array(CodegraphNodeSchema),
            meta: Schema.optional(GraphMeta),
            total: Schema.Number,
          }),
          "Codegraph nodes list with meta",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.codegraph.nodes",
          summary: "List codegraph nodes",
          description: "Returns all indexed codegraph nodes with summary metadata.",
        }),
      ),
      HttpApiEndpoint.get("codegraphEdges", GlobalPaths.codegraphEdges, {
        query: CodegraphEdgesQuery,
        success: described(
          Schema.Struct({
            edges: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                fromNodeID: Schema.String,
                toNodeID: Schema.String,
                kind: Schema.Literals([
                  "imports",
                  "calls",
                  "extends",
                  "references",
                  "tested_by",
                  "configured_by",
                  "built_by",
                  "mounts",
                  "generated_from",
                ]),
              }),
            ),
            total: Schema.Number,
          }),
          "Codegraph edges for a node",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.codegraph.edges",
          summary: "List codegraph edges",
          description: "Returns edges originating from or targeting a given node ID.",
        }),
      ),
      HttpApiEndpoint.post("startup", GlobalPaths.startup, {
        success: described(Schema.Boolean, "Startup complete"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.startup",
          summary: "Startup bridges",
          description: "Initialize all BanyanCode bridges on TUI startup.",
        }),
      ),
      HttpApiEndpoint.post("banyanAgentSave", GlobalPaths.banyanAgentSave, {
        payload: BanyanAgentSaveInput,
        success: described(BanyanAgentSaveResult, "Agent saved"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.banyanAgent.save",
          summary: "Save custom agent",
          description: "Save or update an agent definition to ~/.config/banyancode/agent/<name>.md.",
        }),
      ),
      HttpApiEndpoint.post("websearchFree", GlobalPaths.websearchFree, {
        payload: WebSearchFreeInput,
        success: described(WebSearchFreeResult, "DuckDuckGo search results"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.websearchFree",
          summary: "DuckDuckGo web search",
          description:
            "Run a free web search using DuckDuckGo HTML. Honors BANYANCODE_DISABLE_WEBSEARCH=1 to disable the tool entirely.",
        }),
      ),
      HttpApiEndpoint.post("preflight", GlobalPaths.preflight, {
        payload: PreflightInput,
        success: described(PreflightResult, "Decision-ready preflight report"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preflight",
          summary: "Run preflight on a symbol",
          description:
            "Single-call decision report for a symbol: direct + transitive callers, tests to run, docs/configs affected, event bridges and HTTP routes impacted, and risk verdicts.",
        }),
      ),
      HttpApiEndpoint.post("blastRadius", GlobalPaths.blastRadius, {
        payload: BlastRadiusInput,
        success: described(BlastRadiusResult, "Blast-radius counts"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.blastRadius",
          summary: "Blast-radius counts",
          description:
            "Lightweight blast-radius read of a symbol: direct + transitive caller counts, files affected, tests to run, and a single risk verdict.",
        }),
      ),
      HttpApiEndpoint.post("safeRename", GlobalPaths.safeRename, {
        payload: SafeRenameInput,
        success: described(SafeRenameResult, "Proposed rename edits + tests + risks"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.safeRename",
          summary: "Propose safe rename edits",
          description:
            "Compute the edit list for safely renaming a symbol, plus tests to run and risk list. Returns a preflight-shaped report so the caller can apply edits one at a time via the existing edit tool.",
        }),
      ),
      HttpApiEndpoint.post("typecheck", GlobalPaths.typecheck, {
        payload: TypecheckInput,
        success: described(TypecheckResult, "Typecheck result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.typecheck",
          summary: "Run typecheck",
          description:
            "Run the project's type checker (`bunx tsc --noEmit` by default, or `tsgo --noEmit` if the project uses the TypeScript 7 native compiler). Caches results by (path, package.json hash, tsconfig.json hash) for 1 hour.",
        }),
      ),
      HttpApiEndpoint.post("testRun", GlobalPaths.testRun, {
        payload: TestRunInput,
        success: described(TestRunResult, "Test run result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.testRun",
          summary: "Run tests",
          description: "Run `bun test <path>` for the given file. Caches results for 1 hour.",
        }),
      ),
      HttpApiEndpoint.post("lint", GlobalPaths.lint, {
        payload: LintInput,
        success: described(LintResult, "Lint result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.lint",
          summary: "Run lint",
          description:
            "Run the project's lint command (per `.banyancode.json` → `commands.lint`, falling back to `bun run lint`). Caches results for 1 hour.",
        }),
      ),
      HttpApiEndpoint.get("meshStatus", GlobalPaths.meshStatus, {
        query: MeshStatusQuery,
        success: described(MeshStatus, "Mesh status for the given parent session"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.mesh.status",
          summary: "Get mesh status",
          description:
            "Read the orchestrator mesh status (peers, pending messages, recent activity) for a given parent session. Works whether or not the session is currently active.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
