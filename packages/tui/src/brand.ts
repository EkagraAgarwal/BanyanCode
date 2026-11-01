// BanyanCode user-visible identity for the TUI. Paths and names come from
// Product, so branding call sites share one source of truth.
import { Product } from "@opencode/util/product"

export const displayName = "BanyanCode"
export const cliName = Product.cliName
export const configName = Product.configNames[0]
export const repo = "https://github.com/EkagraAgarwal/BanyanCode"
export const docs = repo
export const issues = `${repo}/issues`
