import { describe, expect, test } from "bun:test"
import { homeFooterVisibility } from "../../src/feature-plugins/home/footer"

describe("home footer visibility", () => {
  test("keeps failure labels readable at the minimum supported width", () => {
    expect(homeFooterVisibility(44)).toEqual({
      mcpCommand: false,
      pluginCommand: false,
      compactHint: false,
      version: false,
    })
  })

  test("adds secondary hints as space becomes available", () => {
    expect(homeFooterVisibility(64)).toEqual({
      mcpCommand: true,
      pluginCommand: false,
      compactHint: true,
      version: false,
    })
    expect(homeFooterVisibility(80)).toEqual({
      mcpCommand: true,
      pluginCommand: true,
      compactHint: true,
      version: false,
    })
  })

  test("trades the compact palette hint for the full hints and the version at 120", () => {
    expect(homeFooterVisibility(119)).toEqual({
      mcpCommand: true,
      pluginCommand: true,
      compactHint: true,
      version: false,
    })
    expect(homeFooterVisibility(120)).toEqual({
      mcpCommand: true,
      pluginCommand: true,
      compactHint: false,
      version: true,
    })
  })
})
