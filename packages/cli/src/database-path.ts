import path from "node:path"
import { Product } from "@opencode/util/product"
import { OPENCODE_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.OPENCODE_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? Product.dbName
      : `${Product.app}-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
