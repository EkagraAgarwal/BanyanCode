import { expect, test } from "bun:test"
import { Definition } from "../src/rpc.js"
import plugin from "../src/server.js"

test("server entry defines the built-in banyancode plugin", () => {
  expect(plugin.id).toBe("banyancode")
  expect(typeof plugin.effect).toBe("function")
})

test("rpc definition owns the banyancode namespace and skeleton methods", () => {
  expect(Definition.id).toBe("banyancode")
  expect(Object.keys(Definition.methods)).toEqual(["status", "config.get"])
  expect(Object.keys(Definition.events)).toEqual([])
})
