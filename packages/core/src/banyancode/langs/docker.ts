import type { ParseResult, ParsedNode } from "./types"

const DOCKER_INSTRUCTION_REGEX = /^(FROM|RUN|CMD|COPY|ENV|WORKDIR|ENTRYPOINT|EXPOSE|VOLUME|USER|ARG|ADD|LABEL|MAINTAINER|STOPSIGNAL|HEALTHCHECK|SHELL|ONBUILD|CMD)\b([^\n]*)$/gim

export function parseDocker(content: string, fileID: string): ParseResult {
  const nodes: ParsedNode[] = []

  for (const match of content.matchAll(DOCKER_INSTRUCTION_REGEX)) {
    const instruction = match[1].toUpperCase()
    const rest = match[2].trim()
    const startIndex = match.index ?? 0
    const startLine = content.substring(0, startIndex).split("\n").length
    const fullLine = match[0].replace(/\s+$/, "")
    nodes.push({
      id: `${fileID}:docker:${instruction}:${startLine}`,
      kind: "docker",
      name: `${instruction} ${rest}`.trim(),
      signature: fullLine,
      startLine,
      endLine: startLine,
      code: fullLine,
    })
  }

  return { nodes, edges: [], imports: [] }
}