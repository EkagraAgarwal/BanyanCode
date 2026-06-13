import type { LanguageParser } from "./types"
import { parseTypeScript } from "./typescript"
import { parsePython } from "./python"
import { parseGeneric } from "./regex-fallback"

const typescriptParser: LanguageParser = {
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  parse: parseTypeScript,
}

const pythonParser: LanguageParser = {
  extensions: [".py", ".pyw"],
  parse: parsePython,
}

const genericParser: LanguageParser = {
  extensions: [],
  parse: parseGeneric,
}

const parsers: LanguageParser[] = [typescriptParser, pythonParser, genericParser]

const extensionMap = new Map<string, LanguageParser>()

for (const parser of parsers) {
  for (const ext of parser.extensions) {
    extensionMap.set(ext, parser)
  }
}

extensionMap.set(".js", typescriptParser)
extensionMap.set(".jsx", typescriptParser)
extensionMap.set(".mjs", typescriptParser)
extensionMap.set(".cjs", typescriptParser)

export function getParser(extension: string): LanguageParser {
  return extensionMap.get(extension) ?? genericParser
}

export { parseTypeScript, parsePython, parseGeneric }
export type { LanguageParser, ParseResult, ParsedNode, ParsedEdge } from "./types"