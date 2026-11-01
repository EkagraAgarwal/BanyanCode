import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { cli, tmpRoot } from "./fixture"

describe("first-run bootstrap (v1 init-banyan)", () => {
  test("creates the product directories and a default banyancode.json only once", async () => {
    const root = await tmpRoot("banyancode-cli-init-")
    const first = await cli(root, ["debug", "paths"])
    expect(first.exitCode).toBe(0)

    const config = path.join(root, "xdg-config", "banyancode", "banyancode.json")
    expect(await fs.readFile(config, "utf8")).toBe(
      JSON.stringify({ $schema: "https://banyan.dev/schema/banyancode.json" }, null, 2),
    )
    for (const dir of ["data", "cache", "state"]) {
      expect(await fs.stat(path.join(root, dir, "banyancode")).then((stat) => stat.isDirectory())).toBe(true)
    }

    // A user edit must survive the next invocation.
    const edited = JSON.stringify({ banyancode_telemetry: "off" }, null, 2)
    await fs.writeFile(config, edited)
    await cli(root, ["debug", "paths"])
    expect(await fs.readFile(config, "utf8")).toBe(edited)
  }, 180_000)
})
