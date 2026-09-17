import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import path from "node:path"
import { existsSync, statSync } from "node:fs"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Thinking } from "@opencode-ai/core/banyancode/thinking"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Service as SubagentBusService } from "@opencode-ai/core/banyancode/subagent-bus"
import { Service as SubagentPlansService, type PlanStep } from "@opencode-ai/core/banyancode/subagent-plans-repo"
import { Service as SubagentConsumerService } from "@opencode-ai/core/banyancode/subagent-consumer"
import { Service as NestedSpawnRegistryService, NestedSpawnBudgetExceededError } from "@opencode-ai/core/banyancode/nested-spawn-registry"
import {
  MAX_NESTED_EXPLORE_LIFETIME_PER_CODER,
  MAX_NESTED_EXPLORE_PER_CODER,
} from "@opencode-ai/core/banyancode/max-subagents"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  workspace: Schema.optional(Schema.String).annotate({
    description:
      "Optional workspace root override for the child session. Must be an existing directory. Never inferred from the prompt or workdir — when omitted the child inherits the parent session's workspace.",
  }),
  worktree: Schema.optional(Schema.String).annotate({
    description:
      "Optional worktree root override for the child session (alias for workspace; worktree wins when both are set). Must be an existing directory; nonexistent or escaping paths are rejected.",
  }),
  plan: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      steps: Schema.Array(
        Schema.Struct({
          content: Schema.String,
          status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
        }),
      ),
      exitCriteria: Schema.String,
    }),
  ).annotate({ description: "An optional plan to send to the subagent at session start" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
  worktree?: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}"${input.worktree ? ` worktree="${input.worktree}"` : ""}>`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

// Resolve the effective worktree for a child session. Only the explicit
// `workspace` / `worktree` params (validated here) or the parent session's
// directory (inherited workspace) ever decide the target — the prompt text,
// message workdir, and process.cwd() are never consulted. Throws on
// nonexistent, non-directory, or escaping (unresolved `..`) targets.
export const resolveTaskWorktreeTarget = (
  input: { workspace?: string; worktree?: string },
  baseDirectory: string,
): string | undefined => {
  const raw = input.worktree ?? input.workspace
  if (!raw) return undefined
  if (raw.includes("\0")) throw new Error(`TaskTool: workspace target contains a null byte`)
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseDirectory, raw)
  if (!path.isAbsolute(resolved) || resolved.split(path.sep).includes("..")) {
    throw new Error(`TaskTool: workspace target escapes the workspace: ${raw}`)
  }
  let isDirectory = false
  try {
    isDirectory = statSync(resolved).isDirectory()
  } catch {
    throw new Error(`TaskTool: workspace target does not exist: ${raw}`)
  }
  if (!isDirectory) throw new Error(`TaskTool: workspace target is not a directory: ${raw}`)
  if (!existsSync(resolved)) throw new Error(`TaskTool: workspace target does not exist: ${raw}`)
  return resolved
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error(
            "Background subagents are disabled. Set OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true (env) or set BANYANCODE_ENABLE=true to re-enable.",
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      // Nested explore budget: only relevant when a coder is spawning a fresh explore.
      // The cap is enforced at spawn time (not at continuation/resume time) because
      // it tracks how many explores a coder has launched, not how many are alive.
      const isNewCoderExploreSpawn = !params.task_id && ctx.agent === "coder" && next.name === "explore"
      if (isNewCoderExploreSpawn) {
        const registryOpt = yield* Effect.serviceOption(NestedSpawnRegistryService)
        if (Option.isSome(registryOpt)) {
          const reserve = yield* registryOpt.value.tryReserveSlot(ctx.sessionID)
          if (!reserve.ok) {
            return yield* Effect.fail(
              new NestedSpawnBudgetExceededError({
                error: reserve.error,
              }),
            )
          }
        }
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const isFreshSpawn = !session
      const parent = yield* sessions.get(ctx.sessionID)
      // Workspace inheritance: the effective worktree is the validated
      // explicit target or the parent session's directory. Never cwd.
      const target = yield* Effect.try({
        try: () =>
          resolveTaskWorktreeTarget({ workspace: params.workspace, worktree: params.worktree }, parent.directory),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      const effectiveWorktree = target ?? parent.directory
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          ...(target ? { directory: target, path: "" } : {}),
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const parentRunID = typeof ctx.extra?.runID === "string" ? ctx.extra.runID : undefined
      const childRunID = parentRunID ?? crypto.randomUUID()
      const telemetryOption = yield* Effect.serviceOption(Banyan.AgentEfficiencyTelemetry)
      const recordTelemetry = (input: {
        eventType: Banyan.AgentEfficiencyEventType
        status?: "started" | "succeeded" | "failed" | "aborted"
        durationMs?: number
        runID?: string
      }): Effect.Effect<void, never, never> => {
        if (Option.isNone(telemetryOption)) return Effect.void
        return Effect.exit(
          telemetryOption.value.record({
            schemaVersion: 1,
            eventID: `agent:${nextSession.id}:${ctx.callID}:${input.eventType}`,
            eventType: input.eventType,
            occurredAt: Date.now(),
            runID: input.runID ?? childRunID,
            sessionID: nextSession.id,
            parentSessionID: ctx.sessionID,
            agentInstanceID: nextSession.id,
            agentRole: next.name,
            taskID: nextSession.id,
            toolCallID: ctx.callID,
            status: input.status,
            durationMs: input.durationMs,
            metadata: { background: runInBackground, parentAgent: ctx.agent },
          }),
        ).pipe(Effect.asVoid)
      }

      if (isFreshSpawn) {
        yield* recordTelemetry({ eventType: "agent.spawned", runID: childRunID }).pipe(Effect.forkDetach)
      }

      // Start a SubagentConsumer for this new subagent session so it can
      // receive peer messages addressed to it (replies, kills, plans, etc).
      // Only when this is a fresh spawn — resuming an existing task via
      // task_id should NOT restart the consumer (it was started on first
      // spawn and is already forkDetached).
      if (!params.task_id) {
        const consumerOpt = yield* Effect.serviceOption(SubagentConsumerService)
        if (Option.isSome(consumerOpt)) {
          yield* consumerOpt.value.start({ sessionID: nextSession.id, agent: next.name })
        }
      }

      if (params.plan) {
        const plan = params.plan
        const busOption = yield* Effect.serviceOption(SubagentBusService)
        const plansOption = yield* Effect.serviceOption(SubagentPlansService)
        // Phase 1A G3: a single planID is shared between the persisted row
        // and the published message so consumers can correlate the two.
        // Previously the two `crypto.randomUUID()` calls produced different
        // ids and the bus payload `planID` field was never populated,
        // leaving `kind: "plan"` messages uncorrelatable. The payload is
        // wrapped as `{ planID, ...plan }` (PlanDefinition + planID) so
        // existing payload readers see the same PlanDefinition fields plus
        // planID at the top level — see mesh-coordinator.ts:planFor for
        // the same envelope contract. We also stamp the canonical
        // `SubagentMessage.planID` field for top-level correlation.
        const planID = crypto.randomUUID()
        if (Option.isSome(busOption)) {
          yield* busOption.value.publish({
            id: crypto.randomUUID(),
            parentSessionID: ctx.sessionID,
            fromSession: ctx.sessionID,
            fromAgent: ctx.agent,
            toAgent: next.name,
            kind: "plan",
            planID,
            payload: { planID, ...plan },
            createdAt: Date.now(),
          })
        }
        if (Option.isSome(plansOption)) {
          yield* plansOption.value.put({
            id: planID,
            parentSessionID: ctx.sessionID,
            agent: next.name,
            sessionID: nextSession.id,
            title: plan.title,
            steps: [...plan.steps],
            exitCriteria: plan.exitCriteria,
            status: "active",
            createdAt: Date.now(),
          })
        }
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const banyanCfgOpt = yield* Effect.serviceOption(Banyan.BanyanConfigService)
      const banyanCfg = Option.isSome(banyanCfgOpt) ? yield* banyanCfgOpt.value.get() : undefined
      const entry = banyanCfg?.agent?.[next.name]
      let model: { providerID: string; modelID: string } | undefined = undefined
      if (entry?.model) {
        const parts = entry.model.split("/")
        model = {
          providerID: parts[0],
          modelID: parts.slice(1).join("/"),
        }
      } else {
        model = next.model ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }
      }
      // Thinking → variant for the child session. Explicit banyan `variant`
      // wins, then per-agent `thinking`, then the parent session variant,
      // then banyancode_thinking_default (medium). Resolved against the child
      // model's variant keys with nearest-fallback; off/unknown resolves to
      // undefined (omit) so an unsupported level never becomes a 400.
      // Both prompt seams validate the key again (V1 prompt.ts checks
      // full.variants[ag.variant]; V2 withVariant falls back), so passing the
      // raw level when the provider lookup fails is safe.
      const thinkingEscapeHatch = entry?.variant
      const thinkingLevel =
        thinkingEscapeHatch ??
        Thinking.resolveThinkingLevel(entry?.thinking, banyanCfg?.banyancode_thinking_default ?? variant)
      let thinkingKeys: string[] | undefined = undefined
      if (!thinkingEscapeHatch) {
        const providerOpt = yield* Effect.serviceOption(Provider.Service)
        if (Option.isSome(providerOpt)) {
          const full = yield* providerOpt.value
            .getModel(ProviderV2.ID.make(model.providerID), ModelV2.ID.make(model.modelID))
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (full) thinkingKeys = Object.keys(ProviderTransform.variants(full))
        }
      }
      const thinkingVariant = thinkingEscapeHatch
        ? thinkingEscapeHatch
        : thinkingKeys
          ? Thinking.resolveThinkingVariant(thinkingLevel, thinkingKeys)
          : thinkingLevel
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        worktree: effectiveWorktree,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const startedAt = Date.now()
        yield* recordTelemetry({ eventType: "agent.started", status: "started", runID: childRunID }).pipe(Effect.forkDetach)
        return yield* Effect.gen(function* () {
          const parts = yield* ops.resolvePromptParts(params.prompt)
          const result = yield* ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            runID: childRunID,
            model: {
              modelID: ModelV2.ID.make(model.modelID),
              providerID: ProviderV2.ID.make(model.providerID),
            },
            variant: thinkingVariant ?? (next.model ? undefined : variant),
            agent: next.name,
            parts,
          })
          return result.parts.findLast((item) => item.type === "text")?.text ?? ""
        }).pipe(
          Effect.onExit((exit) =>
            recordTelemetry({
              eventType: Exit.isSuccess(exit)
                ? "agent.finished"
                : Exit.hasInterrupts(exit)
                  ? "agent.aborted"
                  : "agent.failed",
              status: Exit.isSuccess(exit) ? "succeeded" : Exit.hasInterrupts(exit) ? "aborted" : "failed",
              durationMs: Date.now() - startedAt,
              runID: childRunID,
            }).pipe(Effect.forkDetach),
          ),
        )
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  worktree: effectiveWorktree,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const unregisterNested = () =>
        Effect.gen(function* () {
          const registryOpt = yield* Effect.serviceOption(NestedSpawnRegistryService)
          if (Option.isSome(registryOpt)) {
            yield* registryOpt.value.unregisterFiber(ctx.sessionID, nextSession.id)
          }
        })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.flatMap(() => unregisterNested()),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            worktree: effectiveWorktree,
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            worktree: effectiveWorktree,
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (!result) {
              return {
                title: params.description,
                metadata,
                output: renderOutput({
                  sessionID: nextSession.id,
                  state: "completed",
                  worktree: effectiveWorktree,
                  text: "",
                }),
              }
            }
            if (result.metadata?.background === true) return backgroundResult()
            if (result.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                worktree: effectiveWorktree,
                text: result.output ?? "",
              }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* unregisterNested()
                yield* Effect.sync(() => {
                  ctx.abort.removeEventListener("abort", onAbort)
                })
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
