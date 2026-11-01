import path from "node:path"
import { Product } from "@opencode/util/product"
import { OPENCODE_CHANNEL } from "./version"

export function databasePath(data: string, channel = OPENCODE_CHANNEL) {
  const filename =
    process.env.OPENCODE_DB ??
    // Only stable channels share the plain file: a dev or next build must never open stable data.
    (["latest", "beta", "prod"].includes(channel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? Product.dbName
      : `${Product.app}-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
