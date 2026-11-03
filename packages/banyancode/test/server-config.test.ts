import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BanyanConfig, setConfigUpdatedListener, type ConfigUpdatedEvent, type Loaded } from "../src/config/index.js"
import plugin, { handleConfigUpdate } from "../src/server.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-server-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const configFor = (directory: string) =>
  BanyanConfig.make({
    directory,
    projectRoot: directory,
    globalDir: join(directory, "global"),
    home: directory,
    env: {},
  })

describe("banyancode.config.update + config.updated", () => {
  test("writes the patch through the writer and re-reads the effective config", async () => {
    await withTemp(async (directory) => {
      const events: ConfigUpdatedEvent[] = []
      setConfigUpdatedListener((event) => events.push(event))
      try {
        const config = configFor(directory)
        const loaded = (await Effect.runPromise(
          handleConfigUpdate(config, { directory, projectRoot: directory }, {
            config: { banyancode_yolo_mode: true, banyancode_max_subagents: 9 },
            scope: "project",
          }),
        )) as Loaded
        expect(loaded.config.banyancode_yolo_mode).toBe(true)
        expect(loaded.config.banyancode_max_subagents).toBe(9)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ scope: "project" })
        expect(events[0]?.file?.endsWith("banyancode.json")).toBe(true)
      } finally {
        setConfigUpdatedListener(undefined)
      }
    })
  })

  test("writer notifications are process-local and never throw without a listener", async () => {
    await withTemp(async (directory) => {
      const config = configFor(directory)
      setConfigUpdatedListener(undefined)
      const loaded = (await Effect.runPromise(
        handleConfigUpdate(config, { directory, projectRoot: directory }, {
          config: { banyancode_swarm_mode: true },
          scope: "project",
        }),
      )) as Loaded
      expect(loaded.config.banyancode_swarm_mode).toBe(true)
    })
  })
})

describe("BANYANCODE_ENABLE=0 gate", () => {
  test("registers only the core status RPC + tool, and uses the shared project DB", async () => {
    const previous = process.env.BANYANCODE_ENABLE
    process.env.BANYANCODE_ENABLE = "0"
    try {
      await withTemp(async (directory) => {
        const rpcs: { definition: { id: string }; handlers: Record<string, unknown> }[] = []
        const tools: Tool.Info[] = []
        const commands: string[] = []
        const emitted: { name: string; payload: unknown }[] = []
        const ctx = {
          app: { name: "banyancode", version: "26.10.9", channel: "dev" },
          location: {
            directory,
            project: { canonical: directory, directory, id: "project-1" },
          },
          rpc: {
            register: (definition: { id: string }, handlers: Record<string, unknown>) =>
              Effect.sync(() => {
                rpcs.push({ definition, handlers })
                return {
                  dispose: Effect.void,
                  events: {
                    emit: (name: string, payload: unknown) =>
                      Effect.sync(() => {
                        emitted.push({ name, payload })
                      }),
                  },
                }
              }),
          },
          tool: {
            transform: (fn: (editor: unknown) => void) =>
              Effect.sync(() => {
                fn({ namespace: () => {}, add: (tool: Tool.Info) => tools.push(tool) })
              }),
          },
          command: {
            transform: (fn: (editor: { add: (command: { name: string }) => void }) => void) =>
              Effect.sync(() => fn({ add: (command) => commands.push(command.name) })),
          },
        } as unknown as Context

        const status = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              yield* plugin.effect(ctx as never)
              // `config.update` writes through the writer; the writer's
              // process-local notification must reach the plugin RPC event.
              const update = rpcs[0]!.handlers["config.update"] as (input: {
                config: Record<string, unknown>
                scope: "project"
              }) => Effect.Effect<unknown>
              yield* update({ config: { banyancode_yolo_mode: true }, scope: "project" })
              yield* Effect.sleep("50 millis")
              return (yield* (rpcs[0]!.handlers.status as () => Effect.Effect<{
                version: string
                database: { path: string }
              }>)()) as {
                version: string
                database: { path: string }
              }
            }),
          ),
        )

        expect(rpcs).toHaveLength(1)
        expect(rpcs[0]!.definition.id).toBe("banyancode")
        expect(Object.keys(rpcs[0]!.handlers).sort()).toEqual(["config.get", "config.update", "status"])
        expect(tools.map((tool) => tool.name)).toEqual(["banyan_status"])
        expect(commands).toEqual([])
        expect(emitted).toHaveLength(1)
        expect(emitted[0]!.name).toBe("config.updated")
        expect(emitted[0]!.payload).toMatchObject({ scope: "project" })
        // The plugin reports the host app version, never a workspace placeholder.
        expect(status.version).toBe("26.10.9")
        // Every channel shares one project database; a dev build is not isolated.
        expect(status.database.path).toMatch(/banyancode-[a-f0-9]{12}\.db$/)
      })
    } finally {
      if (previous === undefined) delete process.env.BANYANCODE_ENABLE
      else process.env.BANYANCODE_ENABLE = previous
    }
  })
})
