import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode/schema/tool"
import type { Context } from "@opencode/plugin/effect/plugin"
import DESCRIPTION from "./lsp.txt"
import { exists } from "./fs.js"
import type { Manager } from "./manager.js"
import type { Location } from "./types.js"

/**
 * Model-facing `lsp` tool (v1 `packages/opencode/src/tool/lsp.ts`). Same
 * operations, same 1-based line/character contract, same permission action,
 * same result text. Registered only when the experimental flag is set, which
 * is how v1 gated it.
 */

export const NAME_LSP = "lsp"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const Parameters = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The character offset (1-based, as shown in editors)",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
})

export const Output = Schema.Struct({
  operation: Schema.String,
  result: Schema.Array(Schema.Unknown),
})

export const makeLspTool = (input: {
  readonly ctx: Context
  readonly manager: Manager
}): Tool.Info<typeof Parameters, typeof Output> => ({
  name: NAME_LSP,
  description: DESCRIPTION,
  input: Parameters,
  output: Output,
  options: { permission: NAME_LSP, codemode: true },
  execute: (args, context) =>
    Effect.gen(function* () {
      const instance = input.manager.instance
      const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(instance.directory, args.filePath)
      const meta =
        args.operation === "workspaceSymbol"
          ? { operation: args.operation }
          : args.operation === "documentSymbol"
            ? { operation: args.operation, filePath: file }
            : { operation: args.operation, filePath: file, line: args.line, character: args.character }

      yield* input.ctx.permission.assert({
        action: "lsp",
        resources: ["*"],
        save: ["*"],
        metadata: meta,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })

      const uri = pathToFileURL(file).href
      const position: Location = { file, line: args.line - 1, character: args.character - 1 }
      const relPath = path.relative(instance.worktree, file)
      const detail =
        args.operation === "workspaceSymbol"
          ? ""
          : args.operation === "documentSymbol"
            ? relPath
            : `${relPath}:${args.line}:${args.character}`

      if (!(yield* Effect.promise(() => exists(file)))) {
        return yield* Effect.fail(new Tool.Error({ message: `File not found: ${file}` }))
      }

      const available = yield* Effect.promise(() => input.manager.hasClients(file))
      if (!available) return yield* Effect.fail(new Tool.Error({ message: "No LSP server available for this file type." }))

      yield* Effect.promise(() => input.manager.touch(file, "document"))

      const result: unknown[] = yield* Effect.promise(async () => {
        switch (args.operation) {
          case "goToDefinition":
            return input.manager.definition(position)
          case "findReferences":
            return input.manager.references(position)
          case "hover":
            return input.manager.hover(position)
          case "documentSymbol":
            return input.manager.documentSymbol(uri)
          case "workspaceSymbol":
            return input.manager.workspaceSymbol(args.query ?? "")
          case "goToImplementation":
            return input.manager.implementation(position)
          case "prepareCallHierarchy":
            return input.manager.prepareCallHierarchy(position)
          case "incomingCalls":
            return input.manager.incomingCalls(position)
          case "outgoingCalls":
            return input.manager.outgoingCalls(position)
        }
      })

      return {
        output: { operation: args.operation, result },
        metadata: { result, ...(detail ? { detail } : {}) },
        content: result.length === 0 ? `No results found for ${args.operation}` : JSON.stringify(result, null, 2),
      }
    }),
})
