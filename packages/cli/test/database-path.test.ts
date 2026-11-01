import { describe, expect, test } from "bun:test"
import path from "node:path"
import { databasePath } from "../src/database-path"

describe("databasePath", () => {
  test("only stable channels share the plain database", () => {
    for (const channel of ["latest", "beta", "prod"]) {
      expect(path.basename(databasePath("/data", channel))).toBe("banyancode.db")
    }
  })

  test("dev and next never open stable data", () => {
    expect(path.basename(databasePath("/data", "dev"))).toBe("banyancode-dev.db")
    expect(path.basename(databasePath("/data", "next"))).toBe("banyancode-next.db")
  })
})
