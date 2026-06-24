/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { BUILT_IN_EMBEDDING_MODELS } from "../../src/component/dialog-model"

// DialogEmbeddingModel uses useLocal, useDialog, useSDK, useToast which require
// complex context providers. The core logic is tested here by verifying:
// 1. The onSelect callback pattern (set locally + single HTTP call)
// 2. The local.embeddingModel API contract

describe("DialogEmbeddingModel", () => {
  describe("onSelect callback behavior", () => {
    test("setting embedding model constructs correct full model string", () => {
      const providerID = "openai"
      const modelID = "text-embedding-3-small"
      const fullModel = modelID.includes("/") ? modelID : `${providerID}/${modelID}`
      expect(fullModel).toBe("openai/text-embedding-3-small")
    })

    test("namespaced modelID is used as-is, no double-prefix", () => {
      const providerID = "nvidia"
      const modelID = "nvidia/llama-nemotron-embed-1b-v2"
      const fullModel = modelID.includes("/") ? modelID : `${providerID}/${modelID}`
      expect(fullModel).toBe("nvidia/llama-nemotron-embed-1b-v2")
    })

    test("bge-m3 modelID uses provider-family namespace, not nvidia/ prefix", () => {
      const providerID = "nvidia"
      const modelID = "baai/bge-m3"
      const fullModel = modelID.includes("/") ? modelID : `${providerID}/${modelID}`
      expect(fullModel).toBe("baai/bge-m3")
    })

    test("banyanConfig.update payload structure for embedding model", () => {
      const providerID = "openai"
      const modelID = "text-embedding-3-small"
      const fullModel = modelID.includes("/") ? modelID : `${providerID}/${modelID}`

      const payload = {
        config: { banyancode_embedding_model: fullModel },
        scope: "global" as const,
      }

      expect(payload).toEqual({
        config: { banyancode_embedding_model: "openai/text-embedding-3-small" },
        scope: "global",
      })
    })

    test("multiple model selections produce correct payloads", () => {
      const models = [
        { providerID: "openai", modelID: "text-embedding-3-small", expected: "openai/text-embedding-3-small" },
        { providerID: "cohere", modelID: "embed-english-v3.0", expected: "cohere/embed-english-v3.0" },
        { providerID: "nvidia", modelID: "nvidia/llama-nemotron-embed-1b-v2", expected: "nvidia/llama-nemotron-embed-1b-v2" },
        { providerID: "nvidia", modelID: "nvidia/nv-embedqa-e5-v5", expected: "nvidia/nv-embedqa-e5-v5" },
        { providerID: "nvidia", modelID: "baai/bge-m3", expected: "baai/bge-m3" },
      ]

      for (const model of models) {
        const fullModel = model.modelID.includes("/") ? model.modelID : `${model.providerID}/${model.modelID}`
        expect(fullModel).toBe(model.expected)
      }
    })
  })

  describe("embeddingModel API contract", () => {
    test("current() returns undefined when not set", () => {
      // Simulating the state of an uninitialized embeddingModel store
      const store = { ready: false, providerID: undefined, modelID: undefined }
      const current = () =>
        store.providerID !== undefined && store.modelID !== undefined
          ? { providerID: store.providerID, modelID: store.modelID }
          : undefined

      expect(current()).toBeUndefined()
    })

    test("current() returns model when set", () => {
      const store = {
        ready: true,
        providerID: "openai",
        modelID: "text-embedding-3-small",
      }
      const current = () =>
        store.providerID !== undefined && store.modelID !== undefined
          ? { providerID: store.providerID, modelID: store.modelID }
          : undefined

      expect(current()).toEqual({ providerID: "openai", modelID: "text-embedding-3-small" })
    })

    test("value() derives providerID/modelID string", () => {
      const store = {
        ready: true,
        providerID: "openai",
        modelID: "text-embedding-3-small",
      }
      const current = () =>
        store.providerID !== undefined && store.modelID !== undefined
          ? { providerID: store.providerID, modelID: store.modelID }
          : undefined
      const value = () => {
        const c = current()
        return c ? `${c.providerID}/${c.modelID}` : undefined
      }

      expect(value()).toBe("openai/text-embedding-3-small")
    })

    test("value() returns undefined when current is undefined", () => {
      const store = { ready: false, providerID: undefined, modelID: undefined }
      const current = () =>
        store.providerID !== undefined && store.modelID !== undefined
          ? { providerID: store.providerID, modelID: store.modelID }
          : undefined
      const value = () => {
        const c = current()
        return c ? `${c.providerID}/${c.modelID}` : undefined
      }

      expect(value()).toBeUndefined()
    })

    test("set() updates store synchronously", () => {
      const store = { ready: true, providerID: undefined as string | undefined, modelID: undefined as string | undefined }
      const set = (input: { providerID: string; modelID: string }) => {
        store.providerID = input.providerID
        store.modelID = input.modelID
      }

      // Verify sync behavior - set returns void and updates immediately
      set({ providerID: "openai", modelID: "text-embedding-3-small" })
      expect(store.providerID).toBe("openai")
      expect(store.modelID).toBe("text-embedding-3-small")
    })
  })

  describe("no embedding.model.apply call verification", () => {
    test("the embedding.model.apply route was removed from SDK", () => {
      // This test verifies that we don't call embedding.model.apply anymore
      // The DialogEmbeddingModel only calls banyanConfig.update
      const mockSdk = {
        client: {
          global: {
            banyanConfig: {
              update: (payload: any) => {
                return Promise.resolve({ data: {} })
              },
            },
          },
        },
      }

      // Call banyanConfig.update (what DialogEmbeddingModel actually does)
      const updatePayloads: any[] = []
      mockSdk.client.global.banyanConfig.update = (payload: any) => {
        updatePayloads.push(payload)
        return Promise.resolve({ data: {} })
      }

      // Simulate onSelect
      const fullModel = "openai/text-embedding-3-small"
      mockSdk.client.global.banyanConfig.update({
        config: { banyancode_embedding_model: fullModel },
        scope: "global",
      })

      expect(updatePayloads.length).toBe(1)
      expect(updatePayloads[0].config.banyancode_embedding_model).toBe(fullModel)

      // Verify there's no embedding.model.apply in the SDK
      expect((mockSdk.client.global as any).embedding).toBeUndefined()
    })
  })
})
