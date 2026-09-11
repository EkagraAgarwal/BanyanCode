import { generateImage } from "ai"
import type { ImageModelV3 } from "@ai-sdk/provider"
import { Cause, Effect, Exit, Schema } from "effect"
import { Provider } from "@/provider/provider"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "A detailed description of the image to generate" }),
})

function dataUrl(base64: string, mediaType: string) {
  if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mediaType)) return
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return
  try {
    atob(base64)
  } catch {
    return
  }
  return `data:${mediaType};base64,${base64}`
}

export const GenerateImageTool = Tool.define(
  "generate_image",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return {
      description: "Generate an image from a text prompt using the current provider's image model.",
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx,
      ): Effect.Effect<Tool.ExecuteResult<{ provider: string; model: string }>> =>
        Effect.gen(function* () {
          const model = ctx.extra?.model
          if (!Schema.is(Provider.Model)(model)) {
            return {
              title: "Image generation failed",
              output: "No current model is selected.",
              metadata: { provider: "unknown", model: "unknown" },
            }
          }
          const providers = yield* provider.list()
          const candidates = Object.values(providers)
            .toSorted((a, b) => {
              if (a.id === model.providerID) return -1
              if (b.id === model.providerID) return 1
              return a.id.localeCompare(b.id)
            })
            .flatMap((item) =>
              Object.values(item.models)
                .filter((model) => model.capabilities.output.image)
                .toSorted((a, b) => a.id.localeCompare(b.id))
                .map((model) => ({ provider: item, model })),
            )
          if (candidates.length === 0) {
            return {
              title: "Image generation unavailable",
              output: "No connected provider has an image-capable model.",
              metadata: { provider: "unknown", model: "unknown" },
            }
          }

          let candidate: (typeof candidates)[number] | undefined
          let resolved: ImageModelV3 | undefined
          for (const item of candidates) {
            const result = yield* Effect.exit(provider.getImage(item.model))
            if (Exit.isSuccess(result)) {
              candidate = item
              resolved = result.value
              break
            }
          }
          if (!candidate || !resolved) {
            return {
              title: "Image generation unavailable",
              output: "Connected image-capable models do not expose a usable image model resolver.",
              metadata: { provider: "unknown", model: "unknown" },
            }
          }

          yield* ctx.ask({
            permission: "generate_image",
            patterns: [`${candidate.provider.id}/${candidate.model.id}`],
            always: [`${candidate.provider.id}/*`],
            metadata: { providerID: candidate.provider.id, modelID: candidate.model.id },
          })
          const generated = yield* Effect.exit(
            Effect.tryPromise(() =>
              generateImage({ model: resolved, prompt: params.prompt, abortSignal: ctx.abort }),
            ),
          )
          if (Exit.isFailure(generated)) {
            const error = Cause.squash(generated.cause)
            return {
              title: "Image generation failed",
              output: error instanceof Error ? error.message : String(error),
              metadata: { provider: candidate.provider.id, model: candidate.model.id },
            }
          }
          const result = generated.value
          const attachments = result.images
            .map((image, index) => {
              const url = dataUrl(image.base64, image.mediaType)
              const extension = image.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "bin"
              return url
                ? { type: "file" as const, mime: image.mediaType, url, filename: `generated-${index + 1}.${extension}` }
                : undefined
            })
            .filter((item): item is { type: "file"; mime: string; url: string; filename: string } => item !== undefined)
          if (!attachments.length) {
            return {
              title: "Image generation failed",
              output: "The provider returned no valid image data.",
              metadata: { provider: candidate.provider.id, model: candidate.model.id },
            }
          }
          return {
            title: `Generated image with ${candidate.model.id}`,
            output: `Generated ${attachments.length} image${attachments.length === 1 ? "" : "s"} with ${candidate.provider.id}/${candidate.model.id}.`,
            metadata: { provider: candidate.provider.id, model: candidate.model.id },
            attachments,
          }
        }),
    }
  }),
)
