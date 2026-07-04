import { Context, Effect, Layer, Schema } from "effect"
import { readFile } from "node:fs/promises"
import type { CodegraphFile, CodegraphNode } from "../types"
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

export interface FindInterfacesInput {
  readonly file?: string
  readonly language?: string
}

export interface FindExportsInput {
  readonly file?: string
  readonly language?: string
}

export interface FindImportsInput {
  readonly file?: string
  readonly language?: string
}

export interface Interface {
  readonly findImplementations: (input: FindImplementationsInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findOverrides: (input: FindOverridesInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findRecursiveFunctions: (input: FindRecursiveFunctionsInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findAsyncFunctions: (input: FindAsyncFunctionsInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findHTTPRoutes: (input: FindHTTPRoutesInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findInterfaces: (input: FindInterfacesInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findExports: (input: FindExportsInput) => Effect.Effect<CodegraphNode[], never, never>
  readonly findImports: (input: FindImportsInput) => Effect.Effect<CodegraphNode[], never, never>
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

const INTERFACE_DECL_REGEX = /^[ \t]*interface\s+(\w+)(?:\s+extends\s+\w+(?:\s*,\s*\w+)*)?\s*\{/gm
const EXPORT_DECL_REGEX =
  /^[ \t]*export\s+(?:(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=|class\s+(\w+)|interface\s+(\w+)|type\s+(\w+)\s*=|default\s+(\w+)|\{([^}]+)\})/gm
const IMPORT_DECL_REGEX =
  /^[ \t]*import\s+(?:type\s+)?(?:(\w+)|\{([^}]+)\}|\*\s+as\s+(\w+))(?:\s*,\s*\{([^}]+)\})?\s+from\s+["']([^"']+)["']/gm

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    const resolveFiles = (fileID: string | undefined): Effect.Effect<CodegraphFile[], never, never> =>
      Effect.gen(function* () {
        if (!fileID) return yield* repo.listAllFiles()
        const file = yield* repo.getFile(fileID)
        return file ? [file] : []
      })

    const readFileContent = (path: string): Effect.Effect<string | undefined, never, never> =>
      Effect.tryPromise(() => readFile(path, "utf-8")).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

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

    const findInterfaces: Interface["findInterfaces"] = (input) =>
      Effect.gen(function* () {
        const lang = input.language ?? "typescript"

        if (lang !== "typescript" && lang !== "js" && lang !== "javascript") {
          yield* Effect.logDebug(`findInterfaces: ${lang} not implemented, returning []`)
          return []
        }

        const files = yield* resolveFiles(input.file)
        if (files.length === 0) return []

        const results: CodegraphNode[] = []
        for (const file of files) {
          const content = yield* readFileContent(file.path)
          if (!content) continue

          INTERFACE_DECL_REGEX.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = INTERFACE_DECL_REGEX.exec(content)) !== null) {
            const name = match[1]!
            const startIndex = match.index
            const startLine = lineFromIndex(content, startIndex)
            const bodyEnd = findBodyEnd(content, match.index + match[0].length - 1)
            if (bodyEnd === undefined) continue
            const code = content.substring(startIndex, bodyEnd)
            const endLine = startLine + code.split("\n").length - 1

            results.push({
              id: `${file.id}:interface:${name}:${startLine}`,
              fileID: file.id,
              kind: "type",
              name,
              signature: `interface ${name}`,
              startLine,
              endLine,
              code,
            })
          }
        }

        return results
      })

    const findExports: Interface["findExports"] = (input) =>
      Effect.gen(function* () {
        const lang = input.language ?? "typescript"

        if (lang !== "typescript" && lang !== "js" && lang !== "javascript") {
          yield* Effect.logDebug(`findExports: ${lang} not implemented, returning []`)
          return []
        }

        const files = yield* resolveFiles(input.file)
        if (files.length === 0) return []

        const results: CodegraphNode[] = []
        for (const file of files) {
          const content = yield* readFileContent(file.path)
          if (!content) continue

          EXPORT_DECL_REGEX.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = EXPORT_DECL_REGEX.exec(content)) !== null) {
            const startIndex = match.index
            const startLine = lineFromIndex(content, startIndex)
            const lineEnd = content.indexOf("\n", startIndex)
            const endOffset = lineEnd === -1 ? content.length : lineEnd
            const code = content.substring(startIndex, endOffset).trimEnd()
            const endLine = startLine + code.split("\n").length - 1

            const fnName = match[1]
            const constName = match[2]
            const className = match[3]
            const interfaceName = match[4]
            const typeName = match[5]
            const defaultName = match[6]
            const namedList = match[7]

            if (namedList) {
              const names = namedList.split(",").map((s) => s.trim()).filter(Boolean)
              for (const name of names) {
                results.push({
                  id: `${file.id}:export:${name}:${startLine}:${results.length}`,
                  fileID: file.id,
                  kind: "function",
                  name,
                  signature: `export { ${name} }`,
                  startLine,
                  endLine,
                  code,
                })
              }
              continue
            }

            const name = fnName ?? constName ?? className ?? interfaceName ?? typeName ?? defaultName
            if (!name) continue

            const kind: CodegraphNode["kind"] = className
              ? "class"
              : interfaceName || typeName
                ? "type"
                : "function"

            results.push({
              id: `${file.id}:export:${name}:${startLine}:${results.length}`,
              fileID: file.id,
              kind,
              name,
              signature: `export ${name}`,
              startLine,
              endLine,
              code,
            })
          }
        }

        return results
      })

    const findImports: Interface["findImports"] = (input) =>
      Effect.gen(function* () {
        const lang = input.language ?? "typescript"

        if (lang !== "typescript" && lang !== "js" && lang !== "javascript") {
          yield* Effect.logDebug(`findImports: ${lang} not implemented, returning []`)
          return []
        }

        const files = yield* resolveFiles(input.file)
        if (files.length === 0) return []

        const results: CodegraphNode[] = []
        for (const file of files) {
          const content = yield* readFileContent(file.path)
          if (!content) continue

          IMPORT_DECL_REGEX.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = IMPORT_DECL_REGEX.exec(content)) !== null) {
            const startIndex = match.index
            const startLine = lineFromIndex(content, startIndex)
            const lineEnd = content.indexOf("\n", startIndex)
            const endOffset = lineEnd === -1 ? content.length : lineEnd
            const code = content.substring(startIndex, endOffset).trimEnd()
            const endLine = startLine + code.split("\n").length - 1

            const source = match[5]!
            results.push({
              id: `${file.id}:import:${source}:${startLine}:${results.length}`,
              fileID: file.id,
              kind: "type",
              name: source,
              signature: code,
              startLine,
              endLine,
              code,
            })
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
      findInterfaces,
      findExports,
      findImports,
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

function lineFromIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++
  }
  return line
}

function findBodyEnd(content: string, openBraceIndex: number): number | undefined {
  let count = 1
  let i = openBraceIndex + 1
  while (i < content.length && count > 0) {
    if (content[i] === "{") count++
    else if (content[i] === "}") count--
    i++
  }
  return count === 0 ? i : undefined
}

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
