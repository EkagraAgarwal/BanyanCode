import { Effect, Option } from "effect"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { ToolRegistry as OpencodeToolRegistry } from "@/tool/registry"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

type Category =
  | "Primitive"
  | "Repository"
  | "Codegraph"
  | "Memory"
  | "Mesh"
  | "Edit"
  | "Search"
  | "MCP"

const classify = (name: string): Category => {
  if (name === "bash" || name === "read" || name === "write" || name === "edit" || name === "grep" ||
      name === "glob" || name === "fetch" || name === "task" || name === "todo" || name === "skill" ||
      name === "patch" || name === "invalid" || name === "question" || name === "lsp" ||
      name === "plan" || name === "systeminfo" || name === "websearch") {
    return "Primitive"
  }
  if (name.startsWith("repository_")) return "Repository"
  if (name.startsWith("codegraph_")) return "Codegraph"
  if (name.startsWith("code_find") || name.startsWith("codegraph_search") || name.startsWith("codegraph_search") ||
      name === "search" || name === "websearch_free") {
    return "Search"
  }
  if (name.startsWith("memory_") || name === "shared_memory") return "Memory"
  if (name.startsWith("mesh_")) return "Mesh"
  if (name === "edit_plan") return "Edit"
  return "MCP"
}

const ORDER: Category[] = ["Primitive", "Repository", "Codegraph", "Search", "Memory", "Mesh", "Edit", "MCP"]

export const ToolsCommand = effectCmd({
  command: "tools",
  describe: "print the canonical tool catalog: registered / materialized / visible to the LLM",
  builder: (yargs) =>
    yargs.option("category", {
      type: "string",
      describe: "filter to a single category (e.g. Repository, Memory, Primitive)",
    }),
  handler: Effect.fn("Cli.tools")(function* (args: { category?: string }) {
    const v1 = yield* OpencodeToolRegistry.Service
    yield* v1.ids()
    const option = yield* Effect.serviceOption(ToolCatalog.Service)
    if (Option.isNone(option)) {
      return yield* fail(
        "ToolCatalog is not in the opencode runtime. BANYANCODE_ENABLE set to 0?",
      )
    }
    const catalog = option.value
    const list = yield* catalog.list()
    const materialized = yield* catalog.materialize()
    const materializedNames = new Set(materialized.definitions.map((d) => d.name))
    const defined = [...list.entries()]
      .map(([name]) => name)
      .filter((name) => materializedNames.has(name))
      .filter((name) => !args.category || classify(name) === args.category)
      .toSorted()

    const grouped = new Map<Category, string[]>()
    for (const name of defined) {
      const cat = classify(name)
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat)!.push(name)
    }

    const registered = list.size
    const visible = materialized.definitions.length
    const drift = registered - visible

    UI.println(UI.Style.TEXT_HIGHLIGHT + "Tool Catalog" + UI.Style.TEXT_NORMAL)
    UI.println(dim(`  registered:  ${registered}`))
    UI.println(dim(`  materialized: ${visible}`))
    UI.println(dim(`  visible:     ${visible}`))
    if (drift !== 0) UI.println(UI.Style.TEXT_DANGER + `  drift:       ${drift}` + UI.Style.TEXT_NORMAL)
    UI.println("")

    const categories = args.category ? [args.category as Category] : ORDER
    for (const cat of categories) {
      const entries = grouped.get(cat) ?? []
      if (entries.length === 0) continue
      UI.println(UI.Style.TEXT_INFO_BOLD + `${cat}` + UI.Style.TEXT_NORMAL)
      for (const name of entries) {
        UI.println(`  ${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL} ${name}`)
      }
      UI.println("")
    }
  }),
})
