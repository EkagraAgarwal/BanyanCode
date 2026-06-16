import type { LanguageParser } from "./types"
import { parseTypeScript } from "./typescript"
import { parseJavaScript } from "./javascript"
import { parsePython } from "./python"
import { parseGo } from "./go"
import { parseRust } from "./rust"
import { parseGeneric } from "./regex-fallback"

const typescriptParser: LanguageParser = {
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  parse: parseTypeScript,
}

const javascriptParser: LanguageParser = {
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  parse: parseJavaScript,
}

const pythonParser: LanguageParser = {
  extensions: [".py", ".pyw"],
  parse: parsePython,
}

const goParser: LanguageParser = {
  extensions: [".go"],
  parse: parseGo,
}

const rustParser: LanguageParser = {
  extensions: [".rs"],
  parse: parseRust,
}

const genericParser: LanguageParser = {
  extensions: [],
  parse: parseGeneric,
}

const parsers: LanguageParser[] = [
  typescriptParser,
  javascriptParser,
  pythonParser,
  goParser,
  rustParser,
  genericParser,
]

const extensionMap = new Map<string, LanguageParser>()

for (const parser of parsers) {
  for (const ext of parser.extensions) {
    extensionMap.set(ext, parser)
  }
}

export function getParser(extension: string): LanguageParser {
  return extensionMap.get(extension) ?? genericParser
}

export {
  parseTypeScript,
  parseJavaScript,
  parsePython,
  parseGo,
  parseRust,
  parseGeneric,
}
export type { LanguageParser, ParseResult, ParsedNode, ParsedEdge } from "./types"