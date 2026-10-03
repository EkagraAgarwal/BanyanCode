import { describe, expect, test } from "bun:test"
import { buildShellEnv } from "../../src/tool/shell"

describe("buildShellEnv", () => {
  test("strips server passwords from spawned child env", () => {
    const env = buildShellEnv({
      PATH: "/usr/bin",
      OPENCODE_SERVER_PASSWORD: "secret-opencode",
      BANYANCODE_SERVER_PASSWORD: "secret-banyan",
    })
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.BANYANCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
  })

  test("strips passwords reintroduced via plugin extra env", () => {
    const env = buildShellEnv({ PATH: "/usr/bin" }, { OPENCODE_SERVER_PASSWORD: "secret" })
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
  })

  test("no behavior change when vars are absent", () => {
    const env = buildShellEnv({ FOO: "bar" })
    expect(env).toEqual({ FOO: "bar" })
  })
})
