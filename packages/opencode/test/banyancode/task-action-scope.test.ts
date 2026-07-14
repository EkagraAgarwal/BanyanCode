import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Permission } from "../../src/permission"
import { Config } from "@/config/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Config.defaultLayer)

const load = Config.use.get()

describe("task action scope for coder agent", () => {
  it.instance(
    "coder with task: { explore: allow, '*': deny } can spawn explore",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Coder's task permission should allow explore
        const result = Permission.evaluate("task", "explore", ruleset)
        expect(result.action).toBe("allow")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            explore: "allow",
          },
        },
      },
    },
  )

  it.instance(
    "coder with task: { explore: allow, '*': deny } cannot spawn coder",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Coder's task permission should deny coder subagent
        const result = Permission.evaluate("task", "coder", ruleset)
        expect(result.action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            explore: "allow",
          },
        },
      },
    },
  )

  it.instance(
    "coder with task: { explore: allow, '*': deny } cannot spawn general",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Coder's task permission should deny general subagent
        const result = Permission.evaluate("task", "general", ruleset)
        expect(result.action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            explore: "allow",
          },
        },
      },
    },
  )

  it.instance(
    "last matching rule takes precedence for task permission",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // explore should be allowed (more specific)
        expect(Permission.evaluate("task", "explore", ruleset).action).toBe("allow")
        // general should be denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("deny")
        // unknown should be denied by wildcard
        expect(Permission.evaluate("task", "unknown", ruleset).action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            explore: "allow",
          },
        },
      },
    },
  )
})
