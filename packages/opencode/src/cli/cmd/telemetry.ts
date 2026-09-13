import type { Argv } from "yargs"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Banyan } from "@opencode-ai/core/banyancode"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"
import { readInstallIdentity, readTelemetrySetting, telemetryEnabled } from "../../installation/telemetry"
import { EOL } from "os"

const configFile = () => path.join(Global.Path.banyan.config, "banyancode.json")

async function writeTelemetrySetting(setting: "on" | "off") {
  const file = configFile()
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  let config: Record<string, unknown> = {}
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === "object" && parsed !== null) config = parsed as Record<string, unknown>
    } catch {}
  }
  config.banyancode_telemetry = setting
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(config, null, 2))
}

const StatusCommand = effectCmd({
  command: "status",
  describe: "show install telemetry status",
  instance: false,
  handler: Effect.fn("Cli.telemetry.status")(function* () {
    const setting = yield* Effect.promise(() => readTelemetrySetting(Global.Path.banyan.config))
    const identity = yield* Effect.promise(() => readInstallIdentity(Global.Path.banyan.state))
    const enabled = telemetryEnabled(process.env, setting)
    UI.println(UI.Style.TEXT_HIGHLIGHT + `Telemetry: ${enabled ? "enabled" : "disabled"}` + UI.Style.TEXT_NORMAL)
    UI.println(`  install_id: ${identity?.install_id ?? "(none — first run pending)"}`)
    UI.println(`  config: banyancode_telemetry = ${setting ?? "on (default)"}`)
    if (!enabled) {
      UI.println(UI.Style.TEXT_DIM + "  re-enable with: banyancode telemetry on" + UI.Style.TEXT_NORMAL)
    }
  }),
})

const OnCommand = effectCmd({
  command: "on",
  describe: "enable install telemetry (default)",
  instance: false,
  handler: Effect.fn("Cli.telemetry.on")(function* () {
    yield* Effect.promise(() => writeTelemetrySetting("on"))
    UI.println(UI.Style.TEXT_SUCCESS + "Telemetry enabled" + UI.Style.TEXT_NORMAL)
  }),
})

const OffCommand = effectCmd({
  command: "off",
  describe: "disable install telemetry",
  instance: false,
  handler: Effect.fn("Cli.telemetry.off")(function* () {
    yield* Effect.promise(() => writeTelemetrySetting("off"))
    UI.println(UI.Style.TEXT_WARNING + "Telemetry disabled" + UI.Style.TEXT_NORMAL)
  }),
})

const metadataNumber = (event: Banyan.AgentEfficiencyEvent, key: string) => {
  const value = event.metadata?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const summarizeAgentEvents = (events: readonly Banyan.AgentEfficiencyEvent[]) => {
  const byEventType = new Map<string, number>()
  const byRole = new Map<
    string,
    {
      events: number
      modelUsageEvents: number
      inputTokens: number
      outputTokens: number
      cost: number
      inputComplete: boolean
      outputComplete: boolean
      costComplete: boolean
      cachedInputTokens: number
      uncachedInputTokens: number
      cacheComplete: boolean
      uncachedComplete: boolean
    }
  >()
  let inputTokens = 0
  let inputTokensKnown = false
  let uncachedInputTokens: number | undefined
  let uncachedFieldsComplete = true
  let cachedInputTokens: number | undefined
  let cacheMetricEvents = 0
  let cacheFieldsComplete = true
  let outputTokens = 0
  let outputTokensKnown = false
  let totalCost = 0
  let totalCostKnown = false
  let modelUsageEvents = 0
  let inputFieldsComplete = true
  let outputFieldsComplete = true
  let costFieldsComplete = true

  for (const event of events) {
    byEventType.set(event.eventType, (byEventType.get(event.eventType) ?? 0) + 1)
    const input = metadataNumber(event, "input_tokens")
    if (input !== undefined) {
      inputTokensKnown = true
      inputTokens += input
    }
    const uncached = event.metadata?.uncached_input_tokens
    if (typeof uncached === "number" && Number.isFinite(uncached)) {
      uncachedInputTokens = (uncachedInputTokens ?? 0) + uncached
    }
    const cached = event.metadata?.cached_input_tokens
    if (event.eventType.startsWith("model.") && event.eventType !== "model.started") {
      cacheMetricEvents += 1
      if (input === undefined || typeof cached !== "number" || !Number.isFinite(cached)) cacheFieldsComplete = false
      if (typeof uncached !== "number" || !Number.isFinite(uncached)) uncachedFieldsComplete = false
    }
    if (typeof cached === "number" && Number.isFinite(cached)) {
      cachedInputTokens = (cachedInputTokens ?? 0) + cached
    }
    const output = metadataNumber(event, "output_tokens")
    if (output !== undefined) {
      outputTokensKnown = true
      outputTokens += output
    }
    const cost = metadataNumber(event, "total_cost")
    if (cost !== undefined) {
      totalCostKnown = true
      totalCost += cost
    }
    if (event.eventType.startsWith("model.") && event.eventType !== "model.started") {
      modelUsageEvents += 1
      if (input === undefined) inputFieldsComplete = false
      if (output === undefined) outputFieldsComplete = false
      if (cost === undefined) costFieldsComplete = false
    }
    if (!event.agentRole) continue
    const role =
      byRole.get(event.agentRole) ??
      {
        events: 0,
        modelUsageEvents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        inputComplete: true,
        outputComplete: true,
        costComplete: true,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        cacheComplete: true,
        uncachedComplete: true,
      }
    role.events += 1
    if (event.eventType.startsWith("model.") && event.eventType !== "model.started") {
      role.modelUsageEvents += 1
      if (input === undefined) role.inputComplete = false
      else role.inputTokens += input
      if (output === undefined) role.outputComplete = false
      else role.outputTokens += output
      if (cost === undefined) role.costComplete = false
      else role.cost += cost
      if (typeof cached !== "number" || !Number.isFinite(cached)) role.cacheComplete = false
      else role.cachedInputTokens += cached
      if (typeof uncached !== "number" || !Number.isFinite(uncached)) role.uncachedComplete = false
      else role.uncachedInputTokens += uncached
    }
    byRole.set(event.agentRole, role)
  }

  return {
    eventCount: events.length,
    runCount: new Set(events.map((event) => event.runID)).size,
    agentCount: new Set(events.map((event) => event.agentInstanceID).filter((id): id is string => id !== undefined)).size,
    modelCallCount: new Set(events.map((event) => event.modelCallID).filter((id): id is string => id !== undefined)).size,
    toolCallCount: new Set(events.map((event) => event.toolCallID).filter((id): id is string => id !== undefined)).size,
    inputTokens: modelUsageEvents > 0 && inputFieldsComplete && inputTokensKnown ? inputTokens : null,
    cachedInputTokens:
      modelUsageEvents > 0 && cacheFieldsComplete && cachedInputTokens !== undefined ? cachedInputTokens : null,
    uncachedInputTokens:
      modelUsageEvents > 0 && uncachedFieldsComplete && uncachedInputTokens !== undefined ? uncachedInputTokens : null,
    outputTokens: modelUsageEvents > 0 && outputFieldsComplete && outputTokensKnown ? outputTokens : null,
    totalCost: modelUsageEvents > 0 && costFieldsComplete && totalCostKnown ? totalCost : null,
    realizedCacheReadRatio:
      cacheMetricEvents > 0 &&
      cacheFieldsComplete &&
      inputFieldsComplete &&
      inputTokensKnown &&
      inputTokens > 0 &&
      cachedInputTokens !== undefined
        ? cachedInputTokens / inputTokens
        : null,
    byEventType: Object.fromEntries([...byEventType.entries()].sort(([a], [b]) => a.localeCompare(b))),
    byRole: Object.fromEntries(
      [...byRole.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([role, values]) => [role, {
        events: values.events,
        inputTokens: values.modelUsageEvents > 0 && values.inputComplete ? values.inputTokens : null,
        outputTokens: values.modelUsageEvents > 0 && values.outputComplete ? values.outputTokens : null,
        cost: values.modelUsageEvents > 0 && values.costComplete ? values.cost : null,
        cachedInputTokens: values.modelUsageEvents > 0 && values.cacheComplete ? values.cachedInputTokens : null,
        uncachedInputTokens: values.modelUsageEvents > 0 && values.uncachedComplete ? values.uncachedInputTokens : null,
      }]),
    ),
  }
}

const telemetryFilters = (args: { runId?: string; sessionId?: string; since?: number }) => ({
  ...(args.runId === undefined ? {} : { runID: args.runId }),
  ...(args.sessionId === undefined ? {} : { sessionID: args.sessionId }),
  ...(args.since === undefined ? {} : { since: args.since }),
})

const AgentReportCommand = effectCmd({
  command: "agent-report",
  describe: "show local agent-efficiency telemetry",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("run-id", { describe: "filter by run id", type: "string" })
      .option("session-id", { describe: "filter by session id", type: "string" })
      .option("since", { describe: "only include events after this epoch millisecond", type: "number" })
      .option("json", { describe: "print the report as JSON", type: "boolean" }),
  handler: Effect.fn("Cli.telemetry.agentReport")(function* (args) {
    const telemetry = yield* Banyan.AgentEfficiencyTelemetry
    const events = yield* telemetry.recent(telemetryFilters(args))
    const report = summarizeAgentEvents(events)
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }
    UI.println(UI.Style.TEXT_HIGHLIGHT + "Agent telemetry" + UI.Style.TEXT_NORMAL)
    UI.println(`  events: ${report.eventCount}`)
    UI.println(`  runs: ${report.runCount}`)
    UI.println(`  agents: ${report.agentCount}`)
    UI.println(`  model calls: ${report.modelCallCount}`)
    UI.println(`  tool calls: ${report.toolCallCount}`)
    UI.println(`  input tokens: ${report.inputTokens}`)
    UI.println(`  cached input tokens: ${report.cachedInputTokens}`)
    UI.println(`  uncached input tokens: ${report.uncachedInputTokens}`)
    UI.println(`  output tokens: ${report.outputTokens}`)
    UI.println(`  total cost: ${report.totalCost}`)
    UI.println(`  realized cache-read ratio: ${report.realizedCacheReadRatio === null ? "unknown" : report.realizedCacheReadRatio}`)
    for (const [role, values] of Object.entries(report.byRole)) {
      UI.println(`  ${role}: ${values.events} events, ${values.inputTokens} input, ${values.outputTokens} output`)
    }
  }),
})

const AgentExportCommand = effectCmd({
  command: "agent-export",
  describe: "export sanitized local agent telemetry as JSONL",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("run-id", { describe: "filter by run id", type: "string" })
      .option("session-id", { describe: "filter by session id", type: "string" })
      .option("since", { describe: "only include events after this epoch millisecond", type: "number" }),
  handler: Effect.fn("Cli.telemetry.agentExport")(function* (args) {
    const telemetry = yield* Banyan.AgentEfficiencyTelemetry
    const events = yield* telemetry.recent(telemetryFilters(args))
    for (const event of events) process.stdout.write(JSON.stringify(event) + EOL)
  }),
})

export const TelemetryCommand = effectCmd({
  command: "telemetry",
  describe: "telemetry subcommands (status/on/off/agent-report/agent-export)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(StatusCommand)
      .command(OnCommand)
      .command(OffCommand)
      .command(AgentReportCommand)
      .command(AgentExportCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.telemetry")(function* () {}),
})
