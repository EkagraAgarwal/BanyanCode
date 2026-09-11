import { afterEach, describe, expect } from "bun:test"
import type { ImageModelV3 } from "@ai-sdk/provider"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { SessionID, MessageID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { GenerateImageTool } from "@/tool/generate-image"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const textModel = ProviderTest.model({
  id: ModelV2.ID.make("text-model"),
  providerID: ProviderV2.ID.make("test"),
})
const imageModel = ProviderTest.model({
  id: ModelV2.ID.make("image-model"),
  providerID: ProviderV2.ID.make("test"),
  capabilities: {
    ...textModel.capabilities,
    output: { ...textModel.capabilities.output, image: true },
  },
})

const observedAborts: AbortSignal[] = []

const image: ImageModelV3 = {
  specificationVersion: "v3",
  provider: "test",
  modelId: "image-model",
  maxImagesPerCall: 1,
  doGenerate: async ({ abortSignal }) => {
    if (abortSignal) observedAborts.push(abortSignal)
    return {
      images: ["iVBORw0KGgo="],
      warnings: [],
      response: { timestamp: new Date(0), modelId: "image-model", headers: undefined },
    }
  },
}

const provider = ProviderTest.fake({
  model: textModel,
  info: ProviderTest.info(
    { id: textModel.providerID, models: { [textModel.id]: textModel, [imageModel.id]: imageModel } },
    textModel,
  ),
  getImage: () => Effect.succeed(image),
})

const noImageProvider = ProviderTest.fake({ model: textModel })

const alternateProviderID = ProviderV2.ID.make("images")
const alternateImageModel = ProviderTest.model({
  ...imageModel,
  providerID: alternateProviderID,
})
const alternateInfo = ProviderTest.info(
  { id: alternateProviderID, models: { [alternateImageModel.id]: alternateImageModel } },
  alternateImageModel,
)
const unusableProviderID = ProviderV2.ID.make("aaa-images")
const unusableImageModel = ProviderTest.model({
  ...imageModel,
  id: ModelV2.ID.make("a-image-model"),
  providerID: unusableProviderID,
})
const unusableInfo = ProviderTest.info(
  { id: unusableProviderID, models: { [unusableImageModel.id]: unusableImageModel } },
  unusableImageModel,
)
const fallbackProvider = ProviderTest.fake({
  model: textModel,
  list: () =>
    Effect.succeed({
      [noImageProvider.info.id]: noImageProvider.info,
      [unusableInfo.id]: unusableInfo,
      [alternateInfo.id]: alternateInfo,
    }),
  getProvider: (providerID) =>
    providerID === alternateInfo.id
      ? Effect.succeed(alternateInfo)
      : providerID === unusableInfo.id
        ? Effect.succeed(unusableInfo)
        : Effect.succeed(noImageProvider.info),
  getImage: (model) =>
    model.providerID === alternateProviderID
      ? Effect.succeed(image)
      : Effect.fail(new Provider.ModelNotFoundError({ providerID: model.providerID, modelID: model.id })),
})

const configLayer = TestConfig.layer()
const registryRoot = LayerNode.group([ToolRegistry.node, Agent.node])
const registryReplacements = [
  LayerNode.replace(Config.node, configLayer),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalBackgroundSubagents: false })),
  LayerNode.replace(Provider.node, provider.layer),
]
const registryWithImage = testEffect(LayerNode.buildLayer(registryRoot, { replacements: registryReplacements }))
const registryWithoutImage = testEffect(
  LayerNode.buildLayer(registryRoot, {
    replacements: [...registryReplacements.slice(0, 2), LayerNode.replace(Provider.node, noImageProvider.layer)],
  }),
)

const toolLayer = Layer.mergeAll(provider.layer, Agent.defaultLayer, Truncate.defaultLayer)
const it = testEffect(toolLayer)
const fallbackIt = testEffect(Layer.mergeAll(fallbackProvider.layer, Agent.defaultLayer, Truncate.defaultLayer))

const ctx = (ask: Tool.Context["ask"], abort = new AbortController().signal): Tool.Context => ({
  sessionID: SessionID.make("ses_image-test"),
  messageID: MessageID.make("msg_image-test"),
  agent: "build",
  abort,
  messages: [],
  metadata: () => Effect.void,
  ask,
  extra: { model: textModel },
})

afterEach(async () => disposeAllInstances())

describe("generate_image", () => {
  registryWithoutImage.instance("is hidden without an image-capable provider model", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const info = yield* agent.get("build")
      if (!info) throw new Error("build agent not found")
      const tools = yield* registry.tools({ providerID: textModel.providerID, modelID: textModel.id, agent: info })
      expect(tools.some((tool) => tool.id === "generate_image")).toBe(false)
    }),
    20_000,
  )

  registryWithImage.instance("is exposed with an image-capable provider model", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const info = yield* agent.get("build")
      if (!info) throw new Error("build agent not found")
      const tools = yield* registry.tools({ providerID: textModel.providerID, modelID: textModel.id, agent: info })
      expect(tools.some((tool) => tool.id === "generate_image")).toBe(true)
    }),
    20_000,
  )

  it.instance("executes through Tool.Def, asks permission, forwards abort, and returns a validated attachment", () =>
    Effect.gen(function* () {
      observedAborts.length = 0
      const requested: unknown[] = []
      const controller = new AbortController()
      const info = yield* GenerateImageTool
      const tool = yield* Tool.init(info)
      const result = yield* tool.execute(
        { prompt: "a small test image" },
        ctx((request) => Effect.sync(() => requested.push(request)), controller.signal),
      )
      expect(requested).toHaveLength(1)
      expect(requested[0]).toMatchObject({ permission: "generate_image", patterns: ["test/image-model"] })
      expect(observedAborts[0] === controller.signal).toBe(true)
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo=", filename: "generated-1.png" },
      ])
      expect(Schema.is(Schema.Array(Schema.Struct({ type: Schema.Literal("file"), mime: Schema.String, url: Schema.String, filename: Schema.String })))(result.attachments)).toBe(true)
    }),
    20_000,
  )

  it.instance("returns availability result when the image resolver is unavailable", () =>
    Effect.gen(function* () {
      const unavailable = ProviderTest.fake({
        model: textModel,
        info: ProviderTest.info({ id: textModel.providerID, models: { [textModel.id]: imageModel } }, imageModel),
        getImage: () =>
          Effect.fail(
            new Provider.ModelNotFoundError({
              providerID: ProviderV2.ID.make("test"),
              modelID: ModelV2.ID.make("image-model"),
            }),
          ),
      })
      const info = yield* GenerateImageTool.pipe(Effect.provide(unavailable.layer))
      const tool = yield* Tool.init(info)
      const result = yield* tool.execute({ prompt: "test" }, ctx(() => Effect.void))
      expect(result.title).toBe("Image generation unavailable")
      expect(result.output).toContain("do not expose a usable image model resolver")
    }),
    20_000,
  )

  fallbackIt.instance("falls back to an image model from another connected provider", () =>
    Effect.gen(function* () {
      const requested: unknown[] = []
      const info = yield* GenerateImageTool
      const tool = yield* Tool.init(info)
      const result = yield* tool.execute(
        { prompt: "cross-provider image" },
        ctx((request) => Effect.sync(() => requested.push(request))),
      )
      expect(requested[0]).toMatchObject({ permission: "generate_image", patterns: ["images/image-model"] })
      expect(result.metadata).toMatchObject({ provider: "images", model: "image-model" })
      expect(result.attachments?.[0]?.filename).toBe("generated-1.png")
    }),
    20_000,
  )
})
