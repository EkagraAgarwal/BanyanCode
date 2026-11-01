export * as BanyanRpc from "./rpc.js"

import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
import { Info } from "./config/schema.js"

const ConfigSummary = Schema.Struct({
  yoloMode: Schema.Boolean,
  telemetry: Schema.Literals(["on", "off"]),
  backgroundSubagents: Schema.Boolean,
  maxSubagents: Schema.Int,
  codegraphWatch: Schema.Boolean,
  agentOverrides: Schema.Int,
  sourceCount: Schema.Int,
  unknownKeyCount: Schema.Int,
}).annotate({ identifier: "Banyan.ConfigSummary" })

export const Status = Schema.Struct({
  plugin: Schema.String,
  version: Schema.String,
  host: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    channel: Schema.String,
  }),
  database: Schema.Struct({
    path: Schema.String,
    driver: Schema.Literals(["bun:sqlite", "node:sqlite"]),
    schemaVersion: Schema.Int,
    migrations: Schema.Array(Schema.String),
    ftsTokenizer: Schema.Literals(["trigram", "unicode61"]),
  }),
  config: Schema.Struct({
    sources: Schema.Array(Schema.String),
    unknownKeys: Schema.Array(Schema.String),
    errors: Schema.Array(Schema.String),
    summary: ConfigSummary,
  }),
}).annotate({ identifier: "Banyan.Status" })

export type Status = typeof Status.Type

export const ConfigGetOutput = Schema.Struct({
  config: Info,
  sources: Schema.Array(Schema.String),
  unknownKeys: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      keys: Schema.Array(Schema.String),
    }),
  ),
  errors: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      message: Schema.String,
    }),
  ),
}).annotate({ identifier: "Banyan.ConfigGetOutput" })

export type ConfigGetOutput = typeof ConfigGetOutput.Type

/**
 * `PATCH /global/banyan-config` parity: a top-level patch of `banyancode.json`.
 * `undefined` in the record skips a key; `null` deletes it (same contract as
 * the writer). The response is the re-read effective config, so callers never
 * have to issue a second `config.get`.
 */
export const ConfigUpdateInput = Schema.Struct({
  config: Schema.Record(Schema.String, Schema.Unknown),
  scope: Schema.optional(Schema.Literals(["global", "project"])),
}).annotate({ identifier: "Banyan.ConfigUpdateInput" })

export type ConfigUpdateInput = typeof ConfigUpdateInput.Type

/** Payload of the v1 `banyancode.config.updated` event (host prefixes `rpc.banyancode.`). */
export const ConfigUpdated = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["global", "project"])),
  file: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan.ConfigUpdated" })

export type ConfigUpdated = typeof ConfigUpdated.Type

/**
 * Plugin-owned RPC surface. Workstreams 3a-3h add their namespaces here
 * (`codegraph.*`, `intel.*`, `verify.*`, `mesh.*`, ...); events are emitted as
 * `rpc.banyancode.*` by the host.
 */
export const Definition = Rpc.define({
  id: "banyancode",
  methods: {
    status: {
      input: Schema.Struct({}),
      output: Status,
    },
    "config.get": {
      input: Schema.Struct({}),
      output: ConfigGetOutput,
    },
    "config.update": {
      input: ConfigUpdateInput,
      output: ConfigGetOutput,
    },
  },
  events: {
    "config.updated": { schema: ConfigUpdated },
  },
})
