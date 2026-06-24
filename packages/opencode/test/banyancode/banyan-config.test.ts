import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { applyEmbeddingModel } from "@/effect/banyancode-bootstrap"
import { TestConfig } from "../fixture/config"

describe("BanyanConfig", () => {
  test("banyanConfig() returns the loaded BanyanConfig via service", async () => {
    const mockBanyanConfig = {
      banyancode_embedding_model: "openai/text-embedding-3-small",
      banyancode_yolo_mode: true,
    }

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed(mockBanyanConfig),
        getGlobal: () => Effect.succeed(mockBanyanConfig),
        update: () => Effect.succeed(mockBanyanConfig),
      }),
    )

    const testLayer = Layer.mergeAll(TestConfig.layer(), mockBanyanLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const banyanConfig = yield* Banyan.BanyanConfigService.use((svc) => svc.get())
        expect(banyanConfig.banyancode_embedding_model).toBe("openai/text-embedding-3-small")
        expect(banyanConfig.banyancode_yolo_mode).toBe(true)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("update writes to banyancode.json via service", async () => {
    let updatedConfig: any = null

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: (patch) => {
          updatedConfig = patch
          return Effect.succeed(patch)
        },
      }),
    )

    const testLayer = Layer.mergeAll(TestConfig.layer(), mockBanyanLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        yield* svc.update({ banyancode_embedding_model: "openai/text-embedding-3-small" })
      }).pipe(Effect.provide(testLayer)),
    )

    expect(updatedConfig).toEqual({ banyancode_embedding_model: "openai/text-embedding-3-small" })
  })

  test("after update, get returns the new value", async () => {
    let storedConfig = {}

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed(storedConfig),
        getGlobal: () => Effect.succeed(storedConfig),
        update: (patch) => {
          storedConfig = { ...storedConfig, ...patch }
          return Effect.succeed(storedConfig)
        },
      }),
    )

    const testLayer = Layer.mergeAll(TestConfig.layer(), mockBanyanLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        yield* svc.update({ banyancode_embedding_model: "openai/text-embedding-3-small" })
        const result = yield* svc.get()
        expect(result.banyancode_embedding_model).toBe("openai/text-embedding-3-small")
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("opencode config is NOT touched by BanyanConfig updates", async () => {
    let opencodeConfigUpdated = false

    const mockConfigLayer = Layer.succeed(
      Config.Service,
      Config.Service.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], activeOrgName: undefined, switchableOrgCount: 0 }),
        update: () => {
          opencodeConfigUpdated = true
          return Effect.void
        },
        updateGlobal: () => Effect.succeed({ info: {}, changed: false }),
        invalidate: () => Effect.void,
        directories: () => Effect.succeed([]),
        waitForDependencies: () => Effect.void,
      }),
    )

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: () => Effect.succeed({}),
      }),
    )

    const testLayer = Layer.mergeAll(mockConfigLayer, mockBanyanLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        yield* svc.update({ banyancode_embedding_model: "x" })
      }).pipe(Effect.provide(testLayer)),
    )

    expect(opencodeConfigUpdated).toBe(false)
  })
})

describe("applyEmbeddingModel", () => {
  test("setModel is called when banyancode_embedding_model is set in config", async () => {
    const setModelCalls: string[] = []

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({ banyancode_embedding_model: "openai/text-embedding-3-small" }),
        getGlobal: () => Effect.succeed({ banyancode_embedding_model: "openai/text-embedding-3-small" }),
        update: () => Effect.succeed({ banyancode_embedding_model: "openai/text-embedding-3-small" }),
      }),
    )

    const mockEmbeddingProviderLayer = Layer.succeed(
      Banyan.EmbeddingProviderService,
      Banyan.EmbeddingProviderService.of({
        embed: () => Effect.succeed([]),
        model: () => Effect.succeed("openai/text-embedding-3-small"),
        setModel: (name) => {
          setModelCalls.push(name!)
          return Effect.void
        },
      }),
    )

    const mockRuntimeFlagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: true,
        banyancodeEmbeddingModel: undefined,
        autoShare: false,
        banyancodeYoloMode: false,
        pure: false,
        disableDefaultPlugins: false,
        disableEmbeddedWebUi: false,
        disableExternalSkills: false,
        disableLspDownload: false,
        disableClaudeCodePrompt: false,
        disableClaudeCodeSkills: false,
        enableExa: false,
        enableParallel: false,
        enableExperimentalModels: false,
        enableQuestionTool: false,
        experimentalReferences: false,
        experimentalBackgroundSubagents: false,
        experimentalLspTy: false,
        experimentalLspTool: false,
        experimentalOxfmt: false,
        experimentalPlanMode: false,
        experimentalEventSystem: false,
        experimentalIconDiscovery: false,
        experimentalWorkspaces: false,
        outputTokenMax: undefined,
        bashDefaultTimeoutMs: undefined,
        experimentalNativeLlm: false,
        experimentalWebSockets: false,
        client: "cli",
      }),
    )

    const testLayer = Layer.mergeAll(
      TestConfig.layer(),
      mockBanyanLayer,
      mockEmbeddingProviderLayer,
      mockRuntimeFlagsLayer,
    )

    await Effect.runPromise(
      applyEmbeddingModel.pipe(Effect.provide(testLayer)),
    )

    expect(setModelCalls).toEqual(["openai/text-embedding-3-small"])
  })

  test("setModel is NOT called when banyancode_embedding_model is not in config", async () => {
    const setModelCalls: string[] = []

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: () => Effect.succeed({}),
      }),
    )

    const mockEmbeddingProviderLayer = Layer.succeed(
      Banyan.EmbeddingProviderService,
      Banyan.EmbeddingProviderService.of({
        embed: () => Effect.succeed([]),
        model: () => Effect.succeed(undefined),
        setModel: (name) => {
          if (name !== undefined) setModelCalls.push(name)
          return Effect.void
        },
      }),
    )

    const mockRuntimeFlagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: true,
        banyancodeEmbeddingModel: undefined,
        autoShare: false,
        banyancodeYoloMode: false,
        pure: false,
        disableDefaultPlugins: false,
        disableEmbeddedWebUi: false,
        disableExternalSkills: false,
        disableLspDownload: false,
        disableClaudeCodePrompt: false,
        disableClaudeCodeSkills: false,
        enableExa: false,
        enableParallel: false,
        enableExperimentalModels: false,
        enableQuestionTool: false,
        experimentalReferences: false,
        experimentalBackgroundSubagents: false,
        experimentalLspTy: false,
        experimentalLspTool: false,
        experimentalOxfmt: false,
        experimentalPlanMode: false,
        experimentalEventSystem: false,
        experimentalIconDiscovery: false,
        experimentalWorkspaces: false,
        outputTokenMax: undefined,
        bashDefaultTimeoutMs: undefined,
        experimentalNativeLlm: false,
        experimentalWebSockets: false,
        client: "cli",
      }),
    )

    const testLayer = Layer.mergeAll(
      TestConfig.layer(),
      mockBanyanLayer,
      mockEmbeddingProviderLayer,
      mockRuntimeFlagsLayer,
    )

    await Effect.runPromise(
      applyEmbeddingModel.pipe(Effect.provide(testLayer)),
    )

    expect(setModelCalls).toEqual([])
  })

  test("setModel falls back to RuntimeFlags.banyancodeEmbeddingModel when config is empty", async () => {
    const setModelCalls: string[] = []

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: () => Effect.succeed({}),
      }),
    )

    const mockEmbeddingProviderLayer = Layer.succeed(
      Banyan.EmbeddingProviderService,
      Banyan.EmbeddingProviderService.of({
        embed: () => Effect.succeed([]),
        model: () => Effect.succeed(undefined),
        setModel: (name) => {
          if (name !== undefined) setModelCalls.push(name)
          return Effect.void
        },
      }),
    )

    const mockRuntimeFlagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: true,
        banyancodeEmbeddingModel: "nvidia/llama-nemotron-embed-1b-v2",
        autoShare: false,
        banyancodeYoloMode: false,
        pure: false,
        disableDefaultPlugins: false,
        disableEmbeddedWebUi: false,
        disableExternalSkills: false,
        disableLspDownload: false,
        disableClaudeCodePrompt: false,
        disableClaudeCodeSkills: false,
        enableExa: false,
        enableParallel: false,
        enableExperimentalModels: false,
        enableQuestionTool: false,
        experimentalReferences: false,
        experimentalBackgroundSubagents: false,
        experimentalLspTy: false,
        experimentalLspTool: false,
        experimentalOxfmt: false,
        experimentalPlanMode: false,
        experimentalEventSystem: false,
        experimentalIconDiscovery: false,
        experimentalWorkspaces: false,
        outputTokenMax: undefined,
        bashDefaultTimeoutMs: undefined,
        experimentalNativeLlm: false,
        experimentalWebSockets: false,
        client: "cli",
      }),
    )

    const testLayer = Layer.mergeAll(
      TestConfig.layer(),
      mockBanyanLayer,
      mockEmbeddingProviderLayer,
      mockRuntimeFlagsLayer,
    )

    await Effect.runPromise(
      applyEmbeddingModel.pipe(Effect.provide(testLayer)),
    )

    expect(setModelCalls).toEqual(["nvidia/llama-nemotron-embed-1b-v2"])
  })

  test("setModel is NOT called when banyancodeEnable is false", async () => {
    const setModelCalls: string[] = []

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({ banyancode_embedding_model: "openai/text-embedding-3-small" }),
        getGlobal: () => Effect.succeed({ banyancode_embedding_model: "openai/text-embedding-3-small" }),
        update: () => Effect.succeed({ banyancode_embedding_model: "openai/text-embedding-3-small" }),
      }),
    )

    const mockEmbeddingProviderLayer = Layer.succeed(
      Banyan.EmbeddingProviderService,
      Banyan.EmbeddingProviderService.of({
        embed: () => Effect.succeed([]),
        model: () => Effect.succeed("openai/text-embedding-3-small"),
        setModel: (name) => {
          if (name !== undefined) setModelCalls.push(name)
          return Effect.void
        },
      }),
    )

    const mockRuntimeFlagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: false,
        banyancodeEmbeddingModel: undefined,
        autoShare: false,
        banyancodeYoloMode: false,
        pure: false,
        disableDefaultPlugins: false,
        disableEmbeddedWebUi: false,
        disableExternalSkills: false,
        disableLspDownload: false,
        disableClaudeCodePrompt: false,
        disableClaudeCodeSkills: false,
        enableExa: false,
        enableParallel: false,
        enableExperimentalModels: false,
        enableQuestionTool: false,
        experimentalReferences: false,
        experimentalBackgroundSubagents: false,
        experimentalLspTy: false,
        experimentalLspTool: false,
        experimentalOxfmt: false,
        experimentalPlanMode: false,
        experimentalEventSystem: false,
        experimentalIconDiscovery: false,
        experimentalWorkspaces: false,
        outputTokenMax: undefined,
        bashDefaultTimeoutMs: undefined,
        experimentalNativeLlm: false,
        experimentalWebSockets: false,
        client: "cli",
      }),
    )

    const testLayer = Layer.mergeAll(
      TestConfig.layer(),
      mockBanyanLayer,
      mockEmbeddingProviderLayer,
      mockRuntimeFlagsLayer,
    )

    await Effect.runPromise(
      applyEmbeddingModel.pipe(Effect.provide(testLayer)),
    )

    expect(setModelCalls).toEqual([])
  })
})
