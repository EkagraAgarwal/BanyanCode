import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import path from "path"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Session as SessionNs } from "../../src/session/session"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { Skill } from "../../src/skill"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { BackgroundJob } from "../../src/background/job"
import { Permission } from "../../src/permission"

process.env.BANYANCODE_ENABLE = "1"

// Plan mode denies every edit tool (except plans/*.md) and every task
// (except scout, explore, and researcher). Mirrors the `plan` agent block
// in src/agent/agent.ts. A session created in plan mode stores these as
// its session permission, and session/tools.ts merges them into every
// effective ruleset.
const planPermission: PermissionV1.Ruleset = [
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" },
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "task", pattern: "scout", action: "allow" },
  { permission: "task", pattern: "explore", action: "allow" },
  { permission: "task", pattern: "researcher", action: "allow" },
]

// Orchestrator agent rules: `*` allow plus its task/subagent allows, with no
// edit/task deny. Mirrors the `defaults` + `orchestrator` blocks in
// src/agent/agent.ts. Once the session permission is cleared, the merged
// ruleset falls back to these, so edit/task are allowed.
const orchestratorRules = Permission.fromConfig({
  "*": "allow",
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  task: {
    "*": "deny",
    researcher: "allow",
    coder: "allow",
    explore: "allow",
    scout: "allow",
    reviewer: "allow",
  },
})

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    get: () => Effect.succeed({} as ConfigV1.Info),
    getGlobal: () => Effect.succeed({} as ConfigV1.Info),
    getConsoleState: () => Effect.succeed({} as ConsoleState),
    update: () => Effect.void,
    updateGlobal: () => Effect.succeed({ info: {} as ConfigV1.Info, changed: false }),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in goal-command tests"),
    authenticate: () => Effect.die("unexpected MCP auth in goal-command tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in goal-command tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const buildLayers = (dbLayer: Layer.Layer<never, never, never>) => {
  const runtimeFlags = RuntimeFlags.layer({ experimentalWorkspaces: false })
  const eventLayer = EventV2.layer.pipe(Layer.provide(dbLayer))
  const eventBridgeLayer = EventV2Bridge.layer.pipe(Layer.provide(eventLayer))
  const projectorLayer = SessionProjector.layer.pipe(Layer.provide(eventLayer), Layer.provide(dbLayer))
  const sessionLayer = SessionNs.layer.pipe(
    Layer.provide(dbLayer),
    Layer.provide(eventBridgeLayer),
    Layer.provide(projectorLayer),
    Layer.provide(runtimeFlags),
    Layer.provide(BackgroundJob.defaultLayer),
  )
  const goalLayer = Banyan.goalServiceDefaultLayer.pipe(Layer.provide(dbLayer))
  const commandLayer = Command.layer.pipe(
    Layer.provide(config),
    Layer.provide(mcp),
    Layer.provide(Layer.mock(Skill.Service)({ all: () => Effect.succeed([]) })),
  )
  return Layer.mergeAll(dbLayer, sessionLayer, goalLayer, commandLayer, eventLayer, eventBridgeLayer)
}

const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

describe("goal command session takeover", () => {
  it.instance(
    "plan-mode session starting a goal persists orchestrator agent and clears permission denies",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dbPath = path.join(test.directory, "goal-session.sqlite")
        const dbLayer = Database.layerFromPath(dbPath)
        const layers = buildLayers(dbLayer)

        return yield* Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const commands = yield* Command.Service

          // Simulate a plan-mode session: agent=plan with plan's deny rules.
          const info = yield* sessions.create({ agent: "plan", permission: [...planPermission] })

          // Before the fix this session is read-only: plan's denies make both
          // edit and task deny for the orchestrator loop.
          const before = yield* sessions.get(info.id)
          expect(before.agent).toBe("plan")
          const beforeMerged = Permission.merge(before.permission ?? [], [...planPermission])
          expect(Permission.evaluate("edit", "src/foo.ts", beforeMerged).action).toBe("deny")
          expect(Permission.evaluate("task", "coder", beforeMerged).action).toBe("deny")

          const goalCmd = yield* commands.get("goal")
          expect(goalCmd).toBeDefined()
          const result = yield* goalCmd!.execute!({
            command: "goal",
            arguments: "ship the feature",
            sessionID: info.id,
          })
          expect(result.kind).toBe("continue")

          // The session's stored agent is now orchestrator and its stored
          // permission is cleared — the persistence path (Session.Service →
          // SessionProjector → SessionTable) was used, not in-memory state.
          const stored = yield* sessions.get(info.id)
          expect(stored.agent).toBe("orchestrator")
          expect(stored.permission).toEqual([])

          // Effective ruleset = orchestrator agent rules + cleared session
          // permission → edit/task allowed (session/tools.ts:73 semantics).
          const merged = Permission.merge(orchestratorRules, stored.permission ?? [])
          expect(Permission.evaluate("edit", "src/foo.ts", merged).action).toBe("allow")
          expect(Permission.evaluate("task", "coder", merged).action).toBe("allow")
          expect(Permission.evaluate("task", "reviewer", merged).action).toBe("allow")
        }).pipe(Effect.provide(layers))
      }),
  )

  it.instance(
    "/goal status does not take over the session (agent/permission untouched)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dbPath = path.join(test.directory, "goal-status.sqlite")
        const dbLayer = Database.layerFromPath(dbPath)
        const layers = buildLayers(dbLayer)

        return yield* Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const commands = yield* Command.Service

          const info = yield* sessions.create({ agent: "plan", permission: [...planPermission] })

          const goalCmd = yield* commands.get("goal")
          expect(goalCmd).toBeDefined()
          const result = yield* goalCmd!.execute!({
            command: "goal",
            arguments: "status",
            sessionID: info.id,
          })
          expect(result.kind).toBe("terminal")

          // Status is read-only: the session must NOT be switched to the
          // orchestrator or have its permission neutralized.
          const stored = yield* sessions.get(info.id)
          expect(stored.agent).toBe("plan")
          expect(stored.permission).toEqual([...planPermission])
        }).pipe(Effect.provide(layers))
      }),
  )

  it.instance(
    "/goal cancel does not take over the session (agent/permission untouched)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dbPath = path.join(test.directory, "goal-cancel.sqlite")
        const dbLayer = Database.layerFromPath(dbPath)
        const layers = buildLayers(dbLayer)

        return yield* Effect.gen(function* () {
          const sessions = yield* SessionNs.Service
          const commands = yield* Command.Service
          const goalSvc = yield* Banyan.GoalService

          const info = yield* sessions.create({ agent: "plan", permission: [...planPermission] })
          yield* goalSvc.setGoal({
            parentSessionID: info.id,
            condition: "some active goal",
          })

          const goalCmd = yield* commands.get("goal")
          expect(goalCmd).toBeDefined()
          const result = yield* goalCmd!.execute!({
            command: "goal",
            arguments: "cancel",
            sessionID: info.id,
          })
          expect(result.kind).toBe("terminal")

          const stored = yield* sessions.get(info.id)
          expect(stored.agent).toBe("plan")
          expect(stored.permission).toEqual([...planPermission])
        }).pipe(Effect.provide(layers))
      }),
  )
})
