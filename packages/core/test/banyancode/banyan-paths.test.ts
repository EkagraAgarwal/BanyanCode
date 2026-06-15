import { describe, expect, test } from "bun:test"
import { Global } from "../../src/global"

describe("Global.Path.banyan", () => {
  test("config is under xdgConfig/banyancode", () => {
    expect(Global.Path.banyan.config).toContain(".config")
    expect(Global.Path.banyan.config).toContain("banyancode")
  })

  test("data is under xdgData/banyancode", () => {
    expect(Global.Path.banyan.data).toContain(".local")
    expect(Global.Path.banyan.data).toContain("share")
    expect(Global.Path.banyan.data).toContain("banyancode")
  })

  test("cache is under xdgCache/banyancode", () => {
    expect(Global.Path.banyan.cache).toContain(".cache")
    expect(Global.Path.banyan.cache).toContain("banyancode")
  })

  test("banyan.data, banyan.state, banyan.tmp, banyan.bin, banyan.log, banyan.repos all under banyancode", () => {
    const paths = [
      Global.Path.banyan.data,
      Global.Path.banyan.state,
      Global.Path.banyan.tmp,
      Global.Path.banyan.bin,
      Global.Path.banyan.log,
      Global.Path.banyan.repos,
    ]
    for (const p of paths) {
      expect(p).toContain("banyancode")
    }
  })
})
