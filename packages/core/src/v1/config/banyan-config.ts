export * as BanyanConfig from "./banyan-config"

import { Schema } from "effect"

export const Schema_URL = "https://banyan.dev/schema/banyancode.json"

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  banyancode_embedding_base_url: Schema.optional(Schema.String),
  banyancode_embedding_model: Schema.optional(Schema.String),
  banyancode_embedding_api_key_env: Schema.optional(Schema.String),
  banyancode_embedding_dimensions: Schema.optional(Schema.Number),
  banyancode_embedding_batch_size: Schema.optional(Schema.Number),
  banyancode_yolo_mode: Schema.optional(Schema.Boolean),
  banyancode_disable_websearch: Schema.optional(Schema.Boolean),
  banyancode_telegram_enabled: Schema.optional(Schema.Boolean),
  banyancode_telegram_bot_token: Schema.optional(Schema.String),
  banyancode_telegram_webhook_secret: Schema.optional(Schema.String),
  banyancode_telegram_default_session: Schema.optional(Schema.String),
}).annotate({ identifier: "BanyanConfig" })

export type Info = typeof Info.Type
