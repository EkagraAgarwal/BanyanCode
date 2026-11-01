/**
 * BanyanCode RPC definitions for the TUI.
 *
 * The server package (`@banyancode/plugin`) is the source of truth: every
 * namespace below is imported from `@banyancode/plugin/rpc*` and wrapped into
 * a portable definition (`StandardSchemaV1`), because `client.rpc()` only
 * accepts portable schemas while the server definitions are Effect codecs.
 *
 * One namespace is deliberately local because the server side does not exist
 * yet:
 *
 * - `banyancode.usage.providers` / `providersRefresh` — v1
 *   `GET /global/provider-usage` and `POST /global/provider-usage/refresh`;
 *   the v2 `banyancode.usage` namespace only ships `toolUsage`/`tokenUsage`.
 *   The extra methods are merged into the real definition, so they stay
 *   `rpc.method_not_found` until the server adds them.
 *
 * Import cost (verified with `bun build --target=bun`): the codegraph/intel
 * definitions pull their computation modules (`node:fs`, `node:path`,
 * `node:crypto`, `node:os`) and `banyancode.system` pulls the config writer
 * (`node:fs/promises`, `node:path`) — all runtime-safe under Bun. None of them
 * imports `bun:sqlite` or `node:child_process`; storage and the verifier
 * service are imported type-only by those RPC files.
 */
import { Definition as BanyanDefinition } from "@banyancode/plugin/rpc"
import { Definition as CodegraphDefinition } from "@banyancode/plugin/rpc/codegraph"
import { Definition as IntelDefinition } from "@banyancode/plugin/rpc/intel"
import { Definition as MeshDefinition } from "@banyancode/plugin/rpc/mesh"
import { Definition as UsageDefinition } from "@banyancode/plugin/rpc/usage"
import { Definition as SystemDefinition } from "@banyancode/plugin/rpc/system"
import { Definition as VerifyDefinition } from "@banyancode/plugin/rpc/verify"
import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"

/**
 * Client-side definitions must be portable (Standard Schema or JSON Schema).
 * Effect codecs are wrapped so `client.rpc(definition)` keeps full type
 * inference while the transport only sees a Standard Schema.
 */
function std<S extends Schema.Top>(schema: S) {
  return Schema.toStandardSchemaV1(schema as unknown as Schema.Codec<S["Encoded"], S["Type"]>)
}

type PortableOf<T> = T extends Schema.Top ? ReturnType<typeof std<T>> : T

type PortableDefinitionOf<D extends Rpc.Definition> = {
  readonly id: D["id"]
  readonly methods: {
    readonly [K in keyof D["methods"]]: {
      readonly input: PortableOf<D["methods"][K]["input"]>
      readonly output: PortableOf<D["methods"][K]["output"]>
    }
  }
  readonly events: {
    readonly [K in keyof D["events"]]: {
      readonly schema: PortableOf<D["events"][K]["schema"]>
    }
  }
}

const isSchema = (value: unknown): value is Schema.Top => Schema.isSchema(value)

const portable = (value: unknown) =>
  isSchema(value) ? std(value) : value

/**
 * Re-wrap every server definition in one pass. Errors are dropped on purpose:
 * the TUI treats every failure as `Attempt`, so the declared error channels
 * only add noise to the client type.
 */
export function portableDefinition<const D extends Rpc.Definition>(definition: D): PortableDefinitionOf<D> {
  return {
    id: definition.id,
    methods: Object.fromEntries(
      Object.entries(definition.methods).map(([name, method]) => [
        name,
        { input: portable(method.input), output: portable(method.output) },
      ]),
    ),
    events: Object.fromEntries(
      Object.entries(definition.events).map(([name, event]) => [name, { schema: portable(event.schema) }]),
    ),
  } as PortableDefinitionOf<D>
}

// ---------------------------------------------------------------------------
// banyancode — status + config.get
// ---------------------------------------------------------------------------

export const BanyanRpc: PortableDefinitionOf<typeof BanyanDefinition> = portableDefinition(BanyanDefinition)

type TypeOf<T> = T extends Schema.Top ? T["Type"] : unknown
type InputOf<T> = T extends Schema.Top ? T["Encoded"] : unknown

export type CoreStatus = TypeOf<(typeof BanyanDefinition.methods)["status"]["output"]>
export type CoreConfigOutput = TypeOf<(typeof BanyanDefinition.methods)["config.get"]["output"]>
export type BanyanConfig = CoreConfigOutput["config"]

// ---------------------------------------------------------------------------
// banyancode.codegraph
// ---------------------------------------------------------------------------

export const CodegraphRpc: PortableDefinitionOf<typeof CodegraphDefinition> = portableDefinition(CodegraphDefinition)

export type CodegraphStatusOutput = TypeOf<(typeof CodegraphDefinition.methods)["status"]["output"]>
export type BuildState = CodegraphStatusOutput["build"]
export type ReadinessResult = CodegraphStatusOutput["readiness"]
export type AutoUpdateState = CodegraphStatusOutput["autoUpdate"]
export type GraphMeta = NonNullable<CodegraphStatusOutput["meta"]>
export type CodegraphNode = TypeOf<(typeof CodegraphDefinition.methods)["nodes"]["output"]>["nodes"][number]
export type CodegraphEdge = TypeOf<(typeof CodegraphDefinition.methods)["edges"]["output"]>["edges"][number]
export type CodegraphFile = TypeOf<(typeof CodegraphDefinition.methods)["files"]["output"]>["files"][number]

// ---------------------------------------------------------------------------
// banyancode.intel — the v1 repository-intelligence surface
// ---------------------------------------------------------------------------

export const IntelRpc: PortableDefinitionOf<typeof IntelDefinition> = portableDefinition(IntelDefinition)

export type IntelQueryOutput = TypeOf<(typeof IntelDefinition.methods)["query"]["output"]>
export type IntelSlice = TypeOf<(typeof IntelDefinition.methods)["explain"]["output"]>

// ---------------------------------------------------------------------------
// banyancode.mesh
// ---------------------------------------------------------------------------

export const MeshRpc: PortableDefinitionOf<typeof MeshDefinition> = portableDefinition(MeshDefinition)

export type MeshStatusOutput = TypeOf<(typeof MeshDefinition.methods)["status"]["output"]>
export type MeshNode = MeshStatusOutput["roots"][number]
export type MeshTokens = MeshNode["tokens"]
export type MeshLimits = TypeOf<(typeof MeshDefinition.methods)["limits.get"]["output"]>

// ---------------------------------------------------------------------------
// banyancode.usage — real toolUsage/tokenUsage + v1 provider-usage placeholder
// ---------------------------------------------------------------------------

export const ToolUsageRow = Schema.Struct({
  toolId: Schema.String,
  useCount: Schema.Number,
  lastUsedAt: Schema.Number,
}).annotate({ identifier: "BanyanCodeTui/ToolUsageRow" })
export type ToolUsageRow = typeof ToolUsageRow.Type

export const ProviderUsageWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["quota", "rate_limit"]),
  usedPercent: Schema.optional(Schema.Number),
  remainingPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.Number),
  durationSeconds: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
}).annotate({ identifier: "BanyanCodeTui/ProviderUsageWindow" })
export type ProviderUsageWindow = typeof ProviderUsageWindow.Type

export const ProviderUsageSnapshot = Schema.Struct({
  providerID: Schema.String,
  displayName: Schema.String,
  status: Schema.Literals(["available", "stale", "unsupported", "unauthenticated", "error"]),
  confidence: Schema.Literals(["exact", "reported", "estimated"]),
  windows: Schema.Array(ProviderUsageWindow),
  balance: Schema.optional(Schema.Struct({ remaining: Schema.Number, currency: Schema.optional(Schema.String) })),
  message: Schema.optional(Schema.String),
  fetchedAt: Schema.Number,
}).annotate({ identifier: "BanyanCodeTui/ProviderUsageSnapshot" })
export type ProviderUsageSnapshot = typeof ProviderUsageSnapshot.Type

export const ProviderUsageOutput = Schema.Struct({
  snapshots: Schema.Array(ProviderUsageSnapshot),
}).annotate({ identifier: "BanyanCodeTui/ProviderUsage" })
export type ProviderUsageOutput = typeof ProviderUsageOutput.Type

export const UsageRpc = Rpc.define({
  id: UsageDefinition.id,
  methods: {
    ...portableDefinition(UsageDefinition).methods,
    providers: { input: std(Schema.Struct({})), output: std(ProviderUsageOutput) },
    providersRefresh: {
      input: std(
        Schema.Struct({
          providerID: Schema.optional(
            Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]+$/), Schema.isMaxLength(128)),
          ),
        }),
      ),
      output: std(ProviderUsageOutput),
    },
  },
  events: portableDefinition(UsageDefinition).events,
})

// ---------------------------------------------------------------------------
// banyancode.verify
// ---------------------------------------------------------------------------

export const VerifyRpc: PortableDefinitionOf<typeof VerifyDefinition> = portableDefinition(VerifyDefinition)

// ---------------------------------------------------------------------------
// banyancode.system — status, LSP state, YOLO switch, agent config writes
// ---------------------------------------------------------------------------

export const SystemRpc: PortableDefinitionOf<typeof SystemDefinition> = portableDefinition(SystemDefinition)

export const SystemStatus = SystemDefinition.methods.status.output
export type SystemStatus = TypeOf<typeof SystemStatus>

export type LspStatusOutput = TypeOf<(typeof SystemDefinition.methods)["lsp.status"]["output"]>
export type YoloStatus = TypeOf<(typeof SystemDefinition.methods)["yolo.get"]["output"]>

export type AgentOverrideInput = InputOf<(typeof SystemDefinition.methods)["config.agentOverride"]["input"]>
export type AgentPromptInput = InputOf<(typeof SystemDefinition.methods)["config.agentPrompt"]["input"]>
export type AgentSaveInput = InputOf<(typeof SystemDefinition.methods)["config.agentSave"]["input"]>
