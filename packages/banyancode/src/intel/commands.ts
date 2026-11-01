import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope } from "effect"

/**
 * v1 `/repository-*` slash commands
 * (`packages/opencode/src/command/index.ts:388-471` + `command/template/*.txt`).
 *
 * v1 registered these as templates that the session prompt layer rendered and
 * sent to the model; the command callback itself was a no-op. v2 plugin
 * commands only have an `execute` callback, so each command sends the same
 * template plus the user's arguments with `ctx.session.prompt` — byte-for-byte
 * the text the v1 template path produced, which is what an existing user
 * sees.
 */

export const REPOSITORY_QUERY = "repository-query"
export const REPOSITORY_EXPLAIN = "repository-explain"
export const REPOSITORY_TRACE = "repository-trace"
export const REPOSITORY_IMPACT = "repository-impact"
export const REPOSITORY_TESTS = "repository-tests"
export const REPOSITORY_SYMBOLS = "repository-symbols"
export const REPOSITORY_RELATIONSHIPS = "repository-relationships"
export const REPOSITORY_OWNERSHIP = "repository-ownership"

export const REPOSITORY_COMMAND_NAMES = [
  REPOSITORY_QUERY,
  REPOSITORY_EXPLAIN,
  REPOSITORY_TRACE,
  REPOSITORY_IMPACT,
  REPOSITORY_TESTS,
  REPOSITORY_SYMBOLS,
  REPOSITORY_RELATIONSHIPS,
  REPOSITORY_OWNERSHIP,
] as const

export interface RepositoryCommand {
  readonly name: (typeof REPOSITORY_COMMAND_NAMES)[number]
  readonly description: string
  readonly template: string
}

// Verbatim from v1 `packages/opencode/src/command/template/repository-*.txt`.
export const REPOSITORY_COMMANDS: ReadonlyArray<RepositoryCommand> = [
  {
    name: REPOSITORY_QUERY,
    description: "run a unified repository query (symbols, tests, docs, configs)",
    template: [
      "Run a unified repository query.",
      "",
      "Usage: /repository-query <query> [--limit <n>]",
      "",
      "The query returns matched symbols, related tests, docs, configs, and the surrounding code graph as a single repository context. Use this before writing a plan that spans multiple symbols.",
      "",
      "- <query>: a function name, file path, or free-form feature phrase (required)",
      "- --limit: maximum number of recent commits to include (optional, default 10)",
      "",
      "If the codegraph has not been built yet, run /codegraph-build first.",
    ].join("\n"),
  },
  {
    name: REPOSITORY_EXPLAIN,
    description: "explain a symbol by name (entrypoints, tests, docs, configs)",
    template: [
      "Explain a symbol by name.",
      "",
      "Usage: /repository-explain <symbol>",
      "",
      "Looks up the symbol in the code graph and returns an ArchitecturalSlice describing its entrypoints, related tests, docs, and configs. Use this when introducing a new contributor, before editing an unfamiliar symbol, or when summarising a feature area.",
      "",
      "- <symbol>: a function, class, method, type, variable, or known identifier (required)",
      "",
      "If the symbol is not found, the codegraph may not have been built. Run /codegraph-build and try again.",
    ].join("\n"),
  },
  {
    name: REPOSITORY_TRACE,
    description: "trace a symbol through the code graph to its downstream dependents",
    template: [
      "Trace a symbol through the code graph to its downstream dependents.",
      "",
      "Usage: /repository-trace <symbol> [--depth <n>]",
      "",
      "Walks the code graph from the symbol up to the given depth and returns the entrypoints it leads to. Use this before refactoring to understand blast radius.",
      "",
      "- <symbol>: a function, class, method, or known identifier (required)",
      "- --depth: maximum walk depth (optional, default 2)",
      "",
      "If the symbol is not found, the codegraph may not have been built. Run /codegraph-build and try again.",
    ].join("\n"),
  },
  {
    name: REPOSITORY_IMPACT,
    description: "analyze the impact of changing a file by path",
    template: [
      "Analyze the impact of changing a file by path.",
      "",
      "Usage: /repository-impact <path>",
      "",
      "Returns an ArchitecturalSlice with the file's dependents expanded into important symbols. Use this before refactoring a shared module to identify all callers.",
      "",
      "- <path>: a repository-relative path to a file (required)",
      "",
      "If the file is not found, the codegraph may not have been built. Run /codegraph-build and try again.",
    ].join("\n"),
  },
  {
    name: REPOSITORY_TESTS,
    description: "find tests that reference a given symbol",
    template: [
      "Find tests that reference a given symbol.",
      "",
      "Usage: /repository-tests <symbol>",
      "",
      "Returns the list of test nodes that call or reference the symbol. Use this before editing a symbol to confirm the test coverage in place.",
      "",
      "- <symbol>: a function, class, method, or known identifier (required)",
    ].join("\n"),
  },
  {
    name: REPOSITORY_SYMBOLS,
    description: "look up symbols by name across the code graph",
    template: [
      "Look up symbols by name across the code graph.",
      "",
      "Usage: /repository-symbols <query> [--limit <n>]",
      "",
      "Returns matching CodegraphNode objects with their file, line range, and signature. Use this when searching for a definition without traversing the graph.",
      "",
      "- <query>: a function, class, method, or variable name (required)",
      "- --limit: maximum number of symbols to return (optional, default 50)",
    ].join("\n"),
  },
  {
    name: REPOSITORY_RELATIONSHIPS,
    description: "walk the code graph from a node to its related nodes",
    template: [
      "Walk the code graph from a node to its related nodes.",
      "",
      "Usage: /repository-relationships <nodeID> [--depth <n>]",
      "",
      "Returns the related nodes up to the given graph depth (excludes the anchor). Use this when you already have a CodegraphNode id and want to inspect its neighbourhood.",
      "",
      "- <nodeID>: a CodegraphNode id (required)",
      "- --depth: maximum walk depth (optional, default 2)",
    ].join("\n"),
  },
  {
    name: REPOSITORY_OWNERSHIP,
    description: "find the most active author for a file by path",
    template: [
      "Find the most active author for a file by path.",
      "",
      "Usage: /repository-ownership <path>",
      "",
      "Returns the author with the most recent commits to the file plus their commit count. Use this when triaging who to ask before refactoring a hot file.",
      "",
      "- <path>: a repository-relative path to a file (required)",
    ].join("\n"),
  },
]

/** v1 rendered `template` then appended the user's arguments. */
export const commandText = (template: string, argumentsText: string): string =>
  [template, argumentsText.trim()].filter((part) => part.length > 0).join("\n\n")

export const registerCommands = (ctx: Context): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* ctx.command
      .transform((editor) => {
        for (const command of REPOSITORY_COMMANDS) {
          editor.add({
            name: command.name,
            description: command.description,
            execute: (input) =>
              ctx.session
                .prompt({
                  sessionID: input.sessionID,
                  text: commandText(command.template, input.prompt.text),
                  delivery: input.delivery,
                })
                .pipe(Effect.asVoid),
          })
        }
      })
      .pipe(Effect.orDie)
  })
