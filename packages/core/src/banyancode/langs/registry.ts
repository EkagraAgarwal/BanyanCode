import path from "path"
import type { LanguageParser } from "./types"
import { parseTypeScript } from "./typescript"
import { parsePython } from "./python"
import { parseMarkdown } from "./markdown"
import { parseDocker } from "./docker"
import { parseC } from "./c"
import { parseGeneric } from "./regex-fallback"

const typescriptParser: LanguageParser = {
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  parse: parseTypeScript,
}

const pythonParser: LanguageParser = {
  extensions: [".py", ".pyw"],
  parse: parsePython,
}

// One shared regex parser for C and C++ (class/template/namespace tolerant);
// the split exists so extension routing is explicit.
const cParser: LanguageParser = {
  extensions: [".c", ".h"],
  parse: parseC,
}

const cppParser: LanguageParser = {
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  parse: parseC,
}

const markdownParser: LanguageParser = {
  extensions: [".md"],
  parse: parseMarkdown,
}

const dockerParser: LanguageParser = {
  extensions: [],
  parse: parseDocker,
}

const genericParser: LanguageParser = {
  extensions: [],
  parse: parseGeneric,
}

const parsers: LanguageParser[] = [
  typescriptParser,
  pythonParser,
  cParser,
  cppParser,
  markdownParser,
  dockerParser,
  genericParser,
]

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

export function getParserForPath(filePath: string): LanguageParser {
  if (/dockerfile/i.test(path.basename(filePath))) return dockerParser
  return getParser(path.extname(filePath).toLowerCase())
}

export { parseTypeScript, parsePython, parseMarkdown, parseDocker, parseC, parseGeneric }
export type { LanguageParser, ParseResult, ParsedNode, ParsedEdge } from "./types"