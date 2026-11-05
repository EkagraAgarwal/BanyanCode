import { describe, expect, test } from "bun:test"
import { formatBytesSaved, gatewayMarker, gatewayMarkerText, gatewayTally, gatewayView } from "../../src/util/tool-gateway"

/**
 * The marker is a pure function of the persisted `metadata.gateway`, so these
 * cases also pin what a reloaded session shows.
 */

describe("gatewayView", () => {
  test("accepts the gateway's shape", () => {
    expect(
      gatewayView({
        gateway: { route: "swapped", from: "grep", to: "code_find", op: "usages", reason: "identifier" },
      }),
    ).toEqual({
      route: "swapped",
      from: "grep",
      to: "code_find",
      op: "usages",
      reason: "identifier",
    })
  })

  test("ignores absent or malformed metadata", () => {
    expect(gatewayView(undefined)).toBeUndefined()
    expect(gatewayView({})).toBeUndefined()
    expect(gatewayView({ gateway: "swapped" })).toBeUndefined()
    expect(gatewayView({ gateway: { route: "nope", from: "grep" } })).toBeUndefined()
    expect(gatewayView({ gateway: { route: "swapped" } })).toBeUndefined()
  })
})

describe("gatewayMarker", () => {
  test("a swap names the tool that ran", () => {
    expect(gatewayMarker({ gateway: { route: "swapped", from: "grep", to: "code_find" } })).toEqual({
      tone: "accent",
      text: "⇢ code_find",
    })
    expect(gatewayMarker({ gateway: { route: "swapped", from: "glob", to: "repo", op: "files" } })).toEqual({
      tone: "accent",
      text: "⇢ repo",
    })
  })

  test("an outline read reports the bytes it saved", () => {
    expect(
      gatewayMarker({ gateway: { route: "swapped", from: "read", to: "repo", op: "outline", bytesSaved: 3_277 } }),
    ).toEqual({ tone: "accent", text: "⇢ repo (3.2 KB saved)" })
    // No invented savings for grep or glob.
    expect(gatewayMarker({ gateway: { route: "swapped", from: "grep", to: "code_find", bytesSaved: 0 } })).toEqual({
      tone: "accent",
      text: "⇢ code_find",
    })
  })

  test("a fallback names the short reason", () => {
    expect(gatewayMarker({ gateway: { route: "fallback", from: "grep", reason: "graph-empty" } })).toEqual({
      tone: "muted",
      text: "↩ graph empty",
    })
    expect(gatewayMarker({ gateway: { route: "fallback", from: "read", reason: "file-stale" } })).toEqual({
      tone: "muted",
      text: "↩ file changed",
    })
    expect(gatewayMarker({ gateway: { route: "fallback", from: "read", reason: "graph-unbuilt" } })).toEqual({
      tone: "muted",
      text: "↩ graph missing",
    })
  })

  test("an augmented read gets a small marker", () => {
    expect(gatewayMarker({ gateway: { route: "augmented", from: "read", reason: "symbol-header" } })).toEqual({
      tone: "faint",
      text: "+symbols",
    })
  })

  test("a direct call adds nothing", () => {
    expect(gatewayMarker({ gateway: { route: "direct", from: "grep", reason: "repeat" } })).toBeUndefined()
    expect(gatewayMarker({})).toBeUndefined()
    expect(gatewayMarkerText({})).toBeUndefined()
  })
})

describe("formatBytesSaved", () => {
  test("keeps the marker short", () => {
    expect(formatBytesSaved(12)).toBe("12 B")
    expect(formatBytesSaved(3_277)).toBe("3.2 KB")
    expect(formatBytesSaved(2 * 1024 * 1024)).toBe("2.0 MB")
  })
})

describe("gatewayTally", () => {
  const gateway = (route: string) => ({ gateway: { route, from: "grep" } })

  test("counts swaps and fallbacks for a collapsed row", () => {
    expect(gatewayTally([gateway("swapped"), gateway("swapped"), gateway("fallback"), gateway("direct")])).toBe(
      "⇢ 2 via graph, ↩ 1 fallback",
    )
  })

  test("says nothing when no call touched the graph", () => {
    expect(gatewayTally([gateway("direct"), gateway("augmented"), undefined, {}])).toBe("")
  })
})
