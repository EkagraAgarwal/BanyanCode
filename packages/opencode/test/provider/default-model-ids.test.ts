import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Provider } from "../../src/provider/provider"

describe("Provider.defaultModelIDs", () => {
  test("returns undefined for providers with no models", () => {
    const result = Provider.defaultModelIDs({
      a: { models: {} },
      b: { models: { x: { id: "x" } } },
    })
    expect(result as Record<string, string | undefined>).toEqual({ a: undefined, b: "x" })
  })

  test("returns an empty record when every provider has no models", () => {
    const result = Provider.defaultModelIDs({
      a: { models: {} },
      b: { models: {} },
    })
    expect(result as Record<string, string | undefined>).toEqual({ a: undefined, b: undefined })
  })

  test("returns an empty record when there are no providers", () => {
    const result = Provider.defaultModelIDs({})
    expect(result).toEqual({})
  })

  test("returns one of the available model ids for normal input", () => {
    const result = Provider.defaultModelIDs({
      a: { models: { zulu: { id: "zulu" }, alpha: { id: "alpha" } } },
    })
    expect(result.a).toBeOneOf(["zulu", "alpha"])
  })

  test("ConfigProvidersResult schema accepts undefined entries in the default map", () => {
    const decoded = Schema.decodeUnknownSync(Provider.ConfigProvidersResult)({
      providers: [],
      default: { a: undefined, b: "x" },
    } as unknown as Provider.ConfigProvidersResult)
    expect(decoded.default as Record<string, string | undefined>).toEqual({ a: undefined, b: "x" })
  })
})
