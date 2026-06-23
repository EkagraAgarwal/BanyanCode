/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { BUILT_IN_EMBEDDING_MODELS, type BuiltInEmbeddingModel } from "../../src/component/dialog-model"

describe("BUILT_IN_EMBEDDING_MODELS", () => {
  test("every model has a non-empty providerID, modelID, name and a positive dim", () => {
    for (const model of BUILT_IN_EMBEDDING_MODELS) {
      expect(model.providerID.length).toBeGreaterThan(0)
      expect(model.modelID.length).toBeGreaterThan(0)
      expect(model.name.length).toBeGreaterThan(0)
      expect(model.dim).toBeGreaterThan(0)
      expect(Number.isInteger(model.dim)).toBe(true)
    }
  })

  test("no duplicate (providerID, modelID) pairs", () => {
    const seen = new Set<string>()
    for (const model of BUILT_IN_EMBEDDING_MODELS) {
      const key = `${model.providerID}/${model.modelID}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  test("NVIDIA NIM models use the full namespaced model identifier", () => {
    const nvidia = BUILT_IN_EMBEDDING_MODELS.filter((m) => m.providerID === "nvidia")
    expect(nvidia.length).toBeGreaterThan(0)
    for (const model of nvidia) {
      // The NIM /embeddings endpoint expects the namespaced model id; the
      // bare model name (e.g. "llama-nemotron-embed-1b-v2") always 404s.
      // Anything that's not "nvidia/<bare>" or a third-party namespace like
      // "baai/<bare>" gets flagged.
      const looksNamespaced =
        model.modelID.startsWith("nvidia/") || model.modelID.startsWith("baai/")
      expect(looksNamespaced).toBe(true)
    }
  })

  test("OpenAI / Cohere models carry only the bare model name", () => {
    const nonNamespaced = BUILT_IN_EMBEDDING_MODELS.filter(
      (m) => m.providerID === "openai" || m.providerID === "cohere",
    )
    expect(nonNamespaced.length).toBeGreaterThan(0)
    for (const model of nonNamespaced) {
      // The picker prepends providerID/ when building the stored config
      // value, so a bare model name keeps the path well-formed.
      expect(model.modelID.includes("/")).toBe(false)
    }
  })

  test("dims are realistic for the listed families", () => {
    const byID = new Map<string, BuiltInEmbeddingModel>(
      BUILT_IN_EMBEDDING_MODELS.map((m) => [m.modelID, m]),
    )
    expect(byID.get("text-embedding-3-small")?.dim).toBe(1536)
    expect(byID.get("text-embedding-3-large")?.dim).toBe(3072)
    expect(byID.get("nvidia/llama-nemotron-embed-1b-v2")?.dim).toBe(2048)
    expect(byID.get("nvidia/nv-embedqa-e5-v5")?.dim).toBe(1024)
  })
})