import type { ParseResult, ParsedNode } from "./types"

const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm

export function parseMarkdown(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []

  for (const match of content.matchAll(HEADING_REGEX)) {
    const hashes = match[1]
    const heading = match[2].trim()
    if (!heading) continue
    const startIndex = match.index ?? 0
    const startLine = content.substring(0, startIndex).split("\n").length
    nodes.push({
      id: `${fileID}:doc:${startLine}:${heading}`,
      kind: "doc",
      name: heading,
      signature: `${hashes} ${heading}`,
      startLine,
      endLine: startLine,
      code: match[0],
    })
  }

  return { nodes, edges: [], imports: [] }
}