import { describe, expect, test } from "bun:test"
import { EnvMap } from "../src/env-map"

describe("EnvMap.apply", () => {
  test("drops stock OpenCode variables and maps BanyanCode variables onto the internal namespace", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_CONFIG_DIR: "/opencode/config",
      OPENCODE_DB: "/opencode/opencode.db",
      BANYANCODE_CONFIG_DIR: "/banyancode/config",
      BANYANCODE_DB: "/banyancode/banyancode.db",
      BANYANCODE_EMPTY: "",
      UNRELATED: "kept",
    }

    EnvMap.apply(env)

    expect(env).toEqual({
      [EnvMap.marker]: "1",
      OPENCODE_INTERNAL_ENV_MAPPED: "1",
      BANYANCODE_CONFIG_DIR: "/banyancode/config",
      BANYANCODE_DB: "/banyancode/banyancode.db",
      BANYANCODE_EMPTY: "",
      OPENCODE_CONFIG_DIR: "/banyancode/config",
      OPENCODE_DB: "/banyancode/banyancode.db",
      OPENCODE_EMPTY: "",
      UNRELATED: "kept",
    })
  })

  test("removes a stock OpenCode environment even without BanyanCode overrides", () => {
    const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_PASSWORD: "secret", PATH: "x" }

    EnvMap.apply(env)

    expect(env).toEqual({ [EnvMap.marker]: "1", OPENCODE_INTERNAL_ENV_MAPPED: "1", PATH: "x" })
  })

  test("leaves a spawned child's explicit internal values alone once the parent mapped the environment", () => {
    const parent: NodeJS.ProcessEnv = { OPENCODE_PASSWORD: "user-shell", BANYANCODE_DB: "b.db" }
    EnvMap.apply(parent)

    // standalone.ts spawns `serve` with an explicit lease password on top of the inherited env.
    const child: NodeJS.ProcessEnv = { ...parent, OPENCODE_PASSWORD: "lease" }
    EnvMap.apply(child)

    expect(child.OPENCODE_PASSWORD).toBe("lease")
    expect(child.OPENCODE_DB).toBe("b.db")
  })
})
