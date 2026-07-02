import { Context, Effect, Layer, Schema } from "effect"
import type { CodegraphNode } from "../types"
import { CodegraphRepo } from "../codegraph-repo"

export class StructuralQueryError extends Schema.TaggedErrorClass<StructuralQueryError>()(
  "Banyan/StructuralQueryError",
  { message: Schema.String },
) {}

export interface FindImplementationsInput {
  readonly interfaceName: string
  readonly file?: string
  readonly language?: string
}

export interface FindOverridesInput {
  readonly methodName: string
  readonly baseClass?: string
  readonly file?: string
  readonly language?: string
}

export interface FindRecursiveFunctionsInput {
  readonly file?: string
  readonly language?: string
}

export interface FindAsyncFunctionsInput {
  readonly file?: string
  readonly language?: string
}

export interface FindHTTPRoutesInput {
  readonly file?: string
  readonly language?: string
}

export interface Interface {
  readonly findImplementations: (input: FindImplementationsInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findOverrides: (input: FindOverridesInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findRecursiveFunctions: (input: FindRecursiveFunctionsInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findAsyncFunctions: (input: FindAsyncFunctionsInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findHTTPRoutes: (input: FindHTTPRoutesInput) => Effect.Effect<CodegraphNode[], never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/StructuralQueries") {}

const HTTP_METHODS = new Set([
  "get", "post", "put", "delete", "patch", "head", "options", "trace",
  "Get", "Post", "Put", "Delete", "Patch", "Head", "Options", "Trace",
])

// Regex patterns for TypeScript/JavaScript structural analysis
const IMPLEMENTS_REGEX = /(?:implements|extends)\s+([A-Z]\w*)/g
const CLASS_HERITAGE_REGEX = /class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([A-Z]\w*(?:\s*,\s*[A-Z]\w*)*))?/g
const METHOD_DEF_REGEX = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g
const ASYNC_FUNCTION_REGEX = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g
const ARROW_ASYNC_REGEX = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g
const ARROW_ASYNC_REGEX2 = /(?:export\s+)?(?:async\s+)?(\w+)\s*:\s*(?:Promise<[^>]+>|[A-Z]\w*)\s*=\s*(?:async\s*)?\(/g
const HTTP_ROUTE_REGEX = /(?:app|router)\s*\.\s*(get|post|put|delete|patch|head|options|trace)\s*\(\s*["']([^"']+)["']/gi
const FASTIFY_ROUTE_REGEX = /(?:fastify|instance)\s*\.\s*(get|post|put|delete|patch|head|options|trace)\s*\(\s*["']([^"']+)["']/gi
const RECURSIVE_CALL_REGEX = /(?:return|^\s*)(?:\w+\s*\.\s*)*(\w+)\s*\([^)]*\)/gm

// Python patterns
const PY_CLASS_REGEX = /(?:^|\n)class\s+(\w+)(?:\s*\(\s*(\w+)\s*\))?/g
const PY_DEF_REGEX = /(?:^|\n)(?:async\s+)?def\s+(\w+)\s*\(/g
const PY_ASYNC_DEF_REGEX = /(?:^|\n)async\s+def\s+(\w+)\s*\(/g

// Go patterns
const GO_FUNC_REGEX = /(?:^|\n)func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/g

// Java patterns
const JAVA_METHOD_REGEX = /(?:public|private|protected)?\s*(?:static)?\s*(?:void|int|String|boolean|\w+)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+\w+)?\{/g

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    const findImplementations: Interface["findImplementations"] = (input) =>
      Effect.gen(function* () {
        const lang = input.language ?? "typescript"

        if (lang !== "typescript" && lang !== "js" && lang !== "javascript" && lang !== "python") {
          yield* Effect.logDebug(`findImplementations: ${lang} not implemented, returning []`)
          return []
        }

        let nodes: CodegraphNode[]
        if (input.file) {
          const fileNodes = yield* repo.listNodesByFile(input.file)
          nodes = fileNodes.filter((n) => n.kind === "class")
        } else {
          nodes = yield* repo.queryNodes({ kind: "class" })
        }

        const results: CodegraphNode[] = []

        if (lang === "typescript" || lang === "js" || lang === "javascript") {
          for (const node of nodes) {
            if (!node.code) continue

            // Check for extends clause
            const extendsMatch = new RegExp(`extends\\s+${escapeRegex(input.interfaceName)}\\b`).exec(node.code)
            if (extendsMatch) {
              results.push(node)
              continue
            }

            // Check for implements clause
            const implementsMatch = new RegExp(`implements\\s+[^;]*${escapeRegex(input.interfaceName)}\\b`).exec(node.code)
            if (implementsMatch) {
              results.push(node)
            }
          }
        } else if (lang === "python") {
          for (const node of nodes) {
            if (!node.code) continue

            // Check for class inheritance
            const match = PY_CLASS_REGEX.exec(node.code)
            if (match && match[1] === input.interfaceName) {
              results.push(node)
            }
            PY_CLASS_REGEX.lastIndex = 0
          }
        }

        return results
      })

    const findOverrides: Interface["findOverrides"] = (input) =>
      Effect.gen(function* () {
        const lang = input.language ?? "typescript"

        if (lang !== "typescript" && lang !== "js" && lang !== "javascript") {
          yield* Effect.logDebug(`findOverrides: ${lang} not implemented, returning []`)
          return []
        }

        let nodes: CodegraphNode[]
        if (input.file) {
          const fileNodes = yield* repo.listNodesByFile(input.file)
          nodes = fileNodes.filter((n) => n.kind === "method" || n.kind === "function" || n.kind === "class")
        } else {
          const methods = yield* repo.queryNodes({ kind: "method" })
          const functions = yield* repo.queryNodes({ kind: "function" })
          const classes = yield* repo.queryNodes({ kind: "class" })
          nodes = [...methods, ...functions, ...classes]
        }

        const results = nodes.filter((n) => n.name === input.methodName)

        if (input.file && results.length === 0) {
          const fileNodes = yield* repo.listNodesByFile(input.file)
          const classes = fileNodes.filter((n) => n.kind === "class")
          for (const cls of classes) {
            if (!cls.code) continue
            for (const match of cls.code.matchAll(METHOD_DEF_REGEX)) {
              if (match[1] === input.methodName) {
                const localStart = cls.code.substring(0, match.index).split("\n").length
                const startLine = cls.startLine + localStart - 1
                results.push({
                  id: `${cls.id}:method:${input.methodName}:${startLine}`,
                  fileID: cls.fileID,
                  kind: "method",
                  name: input.methodName,
                  startLine,
                  endLine: startLine,
                  code: match[0],
                })
              }
            }
          }
        }

        // If baseClass is specified, filter to subclasses
        if (input.baseClass && input.file) {
          const fileNodes = yield* repo.listNodesByFile(input.file)
          const classes = fileNodes.filter((n) => n.kind === "class")

          for (const cls of classes) {
            if (!cls.code) continue
            const hasExtends = new RegExp(`extends\\s+${escapeRegex(input.baseClass!)}\\b`).test(cls.code)
            if (!hasExtends) continue

            // This class extends baseClass, check if any methods match
            // Methods inside this class would have line numbers within the class range
            const methodResults = results.filter(
              (r) => r.startLine >= cls.startLine && r.endLine <= cls.endLine,
            )
            if (methodResults.length > 0) {
              return methodResults
            }
          }
          return []
        }

        return results
      })

    const findRecursiveFunctions: Interface["findRecursiveFunctions"] = (input) =>
      Effect.gen(function* () {
        const lang = input.language ?? "typescript"

        if (lang !== "typescript" && lang !== "js" && lang !== "javascript" && lang !== "python") {
          yield* Effect.logDebug(`findRecursiveFunctions: ${lang} not implemented, returning []`)
          return []
        }

        let nodes: CodegraphNode[]
        if (input.file) {
          const fileNodes = yield* repo.listNodesByFile(input.file)
          nodes = fileNodes.filter((n) => n.kind === "function")
        } else {
          nodes = yield* repo.queryNodes({ kind: "function" })
        }

        const results: CodegraphNode[] = []

        for (const node of nodes) {
          if (!node.code) continue

          if (lang === "typescript" || lang === "js" || lang === "javascript") {
            // Look for calls to the function within its body
            const fnName = node.name
            const recursivePattern = new RegExp(
              `\\b${escapeRegex(fnName)}\\s*\\(`,
            )

            // Extract body (everything between first { and matching })
            const bodyStart = node.code.indexOf("{")
            if (bodyStart === -1) continue
            const body = extractBlockBody(node.code, bodyStart)

            if (body && recursivePattern.test(body)) {
              // Make sure it's not just a forward declaration
              const beforeBody = node.code.substring(0, bodyStart)
              if (!beforeBody.includes(`function ${fnName}`) || beforeBody.includes(`${fnName}(`)) {
                results.push(node)
              }
            }
          } else if (lang === "python") {
            const fnName = node.name
            const recursivePattern = new RegExp(`\\b${escapeRegex(fnName)}\\s*\\(`)

            // Look for the function body
            const lines = node.code.split("\n")
            let inBody = false
            let baseIndent = 0

            for (const line of lines) {
              const trimmed = line.trim()
              if (!inBody && trimmed.startsWith("def ")) {
                const indent = line.match(/^(\s*)/)?.[1].length ?? 0
                baseIndent = indent
                inBody = true
                continue
              }

              if (inBody && trimmed && !trimmed.startsWith("#")) {
                const indent = line.match(/^(\s*)/)?.[1].length ?? 0
                if (indent <= baseIndent && !trimmed.startsWith("def ")) break

                if (recursivePattern.test(trimmed)) {
                  results.push(node)
                  break
                }
              }
            }
          }
        }

        return results
      })

    const findAsyncFunctions: Interface["findAsyncFunctions"] = (input) =>
      Effect.gen(function* () {
        const lang = input.language ?? "typescript"

        if (lang !== "typescript" && lang !== "js" && lang !== "javascript" && lang !== "python") {
          yield* Effect.logDebug(`findAsyncFunctions: ${lang} not implemented, returning []`)
          return []
        }

        let nodes: CodegraphNode[]
        if (input.file) {
          const fileNodes = yield* repo.listNodesByFile(input.file)
          nodes = fileNodes.filter((n) => n.kind === "function" || n.kind === "method")
        } else {
          const functions = yield* repo.queryNodes({ kind: "function" })
          const methods = yield* repo.queryNodes({ kind: "method" })
          nodes = [...functions, ...methods]
        }

        const results: CodegraphNode[] = []

        for (const node of nodes) {
          if (!node.code) continue

          if (lang === "typescript" || lang === "js" || lang === "javascript") {
            // Check for async keyword before function
            if (/async\s+function\s+\w+/.test(node.code)) {
              results.push(node)
              continue
            }

            // Check for async arrow function: const foo = async () => {}
            if (/const\s+\w+\s*=\s*async\s*\(/.test(node.code)) {
              results.push(node)
              continue
            }

            // Check for async arrow function: const foo = async () => {
            if (/const\s+\w+\s*=\s*async\s*\([^)]*\)\s*=>/.test(node.code)) {
              results.push(node)
              continue
            }

            // Check if return type is Promise
            if (/\):\s*Promise<[^>]+>\s*=>/.test(node.code)) {
              results.push(node)
              continue
            }

            // Check if return type is a Future/Task type
            if (/:\s*(?:Future|Task|Deferred)<[^>]+>\s*=>/.test(node.code)) {
              results.push(node)
            }
          } else if (lang === "python") {
            // Check for async def
            if (/async\s+def\s+\w+/.test(node.code)) {
              results.push(node)
            }
          }
        }

        return results
      })

    const findHTTPRoutes: Interface["findHTTPRoutes"] = (input) =>
      Effect.gen(function* () {
        const lang = input.language ?? "typescript"

        if (lang !== "typescript" && lang !== "js" && lang !== "javascript") {
          yield* Effect.logDebug(`findHTTPRoutes: ${lang} not implemented, returning []`)
          return []
        }

        let nodes: CodegraphNode[]
        if (input.file) {
          nodes = yield* repo.listNodesByFile(input.file)
        } else {
          nodes = yield* repo.listAllNodes()
        }

        const results: CodegraphNode[] = []
        const seen = new Set<string>()

        for (const node of nodes) {
          if (!node.code) continue

          // Express/Fastify routes: app.get(), router.post(), etc.
          HTTP_ROUTE_REGEX.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = HTTP_ROUTE_REGEX.exec(node.code)) !== null) {
            const method = match[1]!.toUpperCase()
            const path = match[2]!
            const key = `${node.id || node.name}:${path}:${method}`
            if (!seen.has(key)) {
              seen.add(key)
              results.push({
                ...node,
                id: node.id || `${path}:${method}`,
                name: `${method} ${path}`,
                signature: `app.${match[1]}('${path}')`,
              })
            }
          }

          // Fastify-style: fastify.get(), instance.post()
          FASTIFY_ROUTE_REGEX.lastIndex = 0
          while ((match = FASTIFY_ROUTE_REGEX.exec(node.code)) !== null) {
            const method = match[1]!.toUpperCase()
            const path = match[2]!
            const key = `${node.id || node.name}:${path}:${method}`
            if (!seen.has(key)) {
              seen.add(key)
              results.push({
                ...node,
                id: node.id || `${path}:${method}`,
                name: `${method} ${path}`,
                signature: `fastify.${match[1]}('${path}')`,
              })
            }
          }
        }

        return results
      })

    return Service.of({
      findImplementations,
      findOverrides,
      findRecursiveFunctions,
      findAsyncFunctions,
      findHTTPRoutes,
    })
  }),
)

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function extractBlockBody(code: string, startBrace: number): string | null {
  let braceCount = 1
  let i = startBrace + 1
  while (i < code.length && braceCount > 0) {
    if (code[i] === "{") braceCount++
    else if (code[i] === "}") braceCount--
    i++
  }
  if (braceCount === 0) {
    return code.substring(startBrace, i)
  }
  return null
}

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
