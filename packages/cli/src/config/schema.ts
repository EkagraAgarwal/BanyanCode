import { Config } from "@opencode/tui/config"
import { Schema } from "effect"
import { docs } from "../brand"

export const SchemaURL = `${docs}#configuration`

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({ description: "JSON Schema for CLI configuration" }),
  ...Config.Info.fields,
})
export type Info = Schema.Schema.Type<typeof Info>

export function normalizeLegacyTabs(info: Info | undefined) {
  if (info?.tabs?.enabled === undefined) return info
  const tabs = { ...info.tabs }
  tabs.mode ??= tabs.enabled ? "on" : "off"
  delete tabs.enabled
  return { ...info, tabs }
}
