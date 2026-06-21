export * as BanyanConfig from "./banyan-config"

import { Schema } from "effect"

export const Schema_URL = "https://banyan.dev/schema/banyancode.json"

export const EmbeddingType = Schema.Union([
  Schema.Literal("F32"),
  Schema.Literal("F16"),
  Schema.Literal("F8"),
  Schema.Literal("F1BIT"),
])

export const OpenAICompatibleEndpoint = Schema.Struct({
  name: Schema.String,
  base_url: Schema.String,
  api_key: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Array(Schema.String)),
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  banyancode_embedding_model: Schema.optional(Schema.String),
  banyancode_embedding_dim: Schema.optional(Schema.Number),
  banyancode_embedding_type: Schema.optional(EmbeddingType),
  banyancode_openai_compatible_endpoints: Schema.optional(Schema.Array(OpenAICompatibleEndpoint)),
  banyancode_yolo_mode: Schema.optional(Schema.Boolean),
  banyancode_disable_websearch: Schema.optional(Schema.Boolean),
  banyancode_telegram_enabled: Schema.optional(Schema.Boolean),
  banyancode_telegram_bot_token: Schema.optional(Schema.String),
  banyancode_telegram_webhook_secret: Schema.optional(Schema.String),
  banyancode_telegram_default_session: Schema.optional(Schema.String),
}).annotate({ identifier: "BanyanConfig" })

export type Info = typeof Info.Type
