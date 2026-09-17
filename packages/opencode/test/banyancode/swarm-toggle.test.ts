import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { SWARM_MODE_KEY, readSwarmMode } from "@opencode-ai/core/banyancode/swarm-waves"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { Skill } from "../../src/skill"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"

process.env.BANYANCODE_ENABLE = "1"

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
    startAuth: () => Effect.die("unexpected MCP auth in swarm-toggle tests"),
    authenticate: () => Effect.die("unexpected MCP auth in swarm-toggle tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in swarm-toggle tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

// Stateful merge-preserving mock: the swarm key survives update/get even
// before it lands in BanyanConfig.Info (peer slice owns the schema).
const makeSwarmConfig = () => {
  let state: Record<string, unknown> = {}
  return Layer.succeed(
    Banyan.BanyanConfigService,
    Banyan.BanyanConfigService.of({
      get: () => Effect.succeed(state as any),
      getGlobal: () => Effect.succeed(state as any),
      update: (patch: any) => Effect.succeed((state = { ...state, ...patch }) as any),
      updateAgentOverride: (_name: string, _patch: any) => Effect.succeed({ ...state } as any),
      getAgentOverrides: () => Effect.succeed([] as any),
      updateAgentPrompt: (_name: string, _prompt: string) => Effect.succeed({ ...state } as any),
    }),
  )
}

const buildLayers = () => {
  const commandLayer = Command.layer.pipe(
    Layer.provide(config),
    Layer.provide(mcp),
    Layer.provide(Layer.mock(Skill.Service)({ all: () => Effect.succeed([]) })),
  )
  return Layer.mergeAll(commandLayer, makeSwarmConfig())
}

const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

describe("/swarm toggle", () => {
  it.instance("first invoke turns swarm on, second turns it off", () =>
    Effect.gen(function* () {
      const layers = buildLayers()
      return yield* Effect.gen(function* () {
        const commands = yield* Command.Service
        const swarm = yield* commands.get("swarm")
        expect(swarm).toBeDefined()

        const first = yield* swarm!.execute!({
          command: "swarm",
          arguments: "",
          sessionID: SessionID.make("ses_swarm_toggle"),
        })
        expect(first).toEqual({ kind: "terminal", message: "Swarm mode is now on." })

        const banyan = yield* Banyan.BanyanConfigService
        expect(readSwarmMode(yield* banyan.get())).toBe(true)

        const second = yield* swarm!.execute!({
          command: "swarm",
          arguments: "",
          sessionID: SessionID.make("ses_swarm_toggle"),
        })
        expect(second).toEqual({ kind: "terminal", message: "Swarm mode is now off." })
        expect(yield* banyan.get().pipe(Effect.map((c) => (c as Record<string, unknown>)[SWARM_MODE_KEY]))).toBe(
          false,
        )
      }).pipe(Effect.provide(layers))
    }),
  )
})
