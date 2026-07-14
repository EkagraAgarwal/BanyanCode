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
import { CodegraphNodeSchema } from "@opencode-ai/core/banyancode/types"
import { GraphMeta } from "@opencode-ai/core/banyancode/types"
import * as WebSearchFreeTool from "@opencode-ai/core/tool/websearch-free"
import * as PreflightTool from "@opencode-ai/core/tool/preflight"
import * as BlastRadiusTool from "@opencode-ai/core/tool/blast-radius"
import * as SafeRenameTool from "@opencode-ai/core/tool/safe-rename"

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
  dbPath: Schema.optional(Schema.String),
})

export const CodegraphBuildResult = Schema.Struct({
  started: Schema.Boolean,
  root: Schema.optional(Schema.String),
  dbPath: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

export const WebSearchFreeInput = WebSearchFreeTool.Input
export const WebSearchFreeResult = WebSearchFreeTool.Output

export const PreflightInput = PreflightTool.Input
export const PreflightResult = PreflightTool.Output

export const BlastRadiusInput = BlastRadiusTool.Input
export const BlastRadiusResult = BlastRadiusTool.Output

export const SafeRenameInput = SafeRenameTool.Input
export const SafeRenameResult = SafeRenameTool.Output

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
      HttpApiEndpoint.post("codegraphBuild", GlobalPaths.codegraphBuild, {
        payload: CodegraphBuildInput,
        success: described(CodegraphBuildResult, "Codegraph build kickoff result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.codegraph.build",
          summary: "Build code graph index",
          description:
            "Kick off a codegraph build for the given root (defaults to the current workspace). Runs in the background; progress is published via the banyancode.codegraph.build event.",
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
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
