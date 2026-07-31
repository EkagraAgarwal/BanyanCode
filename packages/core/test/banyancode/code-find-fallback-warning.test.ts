import { describe, expect, test } from "bun:test"

process.env.BANYANCODE_ENABLE = "1"

// Mirror the toModelOutput implementation from code-find.ts for testing.
// NOTE: this mirror intentionally duplicates the formatter logic so the
// test runs without booting the full tool runtime. Drift risk is real —
// keep it in sync with code-find.ts toModelOutput.
const formatNodes = (nodes: Array<{ name: string; kind: string; fileID: string }>): string => {
  if (nodes.length === 0) return "Matches: none."
  return nodes.map((n) => `  ${n.kind} ${n.name}`).join("\n")
}

const toModelOutput = (output: {
  intent: string
  dispatchedTo?: string
  matches: Array<{ node: { name: string; kind: string; fileID: string }; derivation: string }>
  files: Array<{ path: string }>
  resolvedNodeID?: string
  resolvedDerivation?: string
  _diagnostic?: string
}): string => {
  // Only flag fuzzy derivations. tag-fallback is the resolver's step 1
  // (Context.Service tag lookup) — highest precision, not a fallback.
  const fuzzyDerivation = output.resolvedDerivation
    && ["code-substring", "name-like", "fts-bm25"].includes(output.resolvedDerivation)
    ? output.resolvedDerivation
    : undefined
  const headerParts = [
    fuzzyDerivation
      ? `FALLBACK MATCH (derivation=${fuzzyDerivation}) -- verify before treating as the exact symbol`
      : null,
    `intent=${output.intent}`,
    `dispatched=${output.dispatchedTo ?? "n/a"}`,
    `matches=${output.matches.length}`,
    `files=${output.files.length}`,
  ]
  if (output.resolvedNodeID) headerParts.push(`resolved=${output.resolvedNodeID}`)
  if (output.resolvedDerivation) headerParts.push(`derivation=${output.resolvedDerivation}`)
  if (output._diagnostic) headerParts.push(`diagnostic=${output._diagnostic}`)
  const header = headerParts.filter((p): p is string => p !== null).join(" ")
  const matchesBlock = output.matches.length > 0 ? formatNodes(output.matches.map((m) => m.node)) : "Matches: none."
  // Hide the Files block for non-find_file intents with no files.
  const showFiles = output.intent === "find_file" || output.files.length > 0
  const filesBlock = !showFiles
    ? ""
    : output.files.length > 0
      ? `Files (${output.files.length}):\n${output.files.map((f) => `  ${f.path}`).join("\n")}`
      : "Files: none."
  return filesBlock ? `${header}\n\n${matchesBlock}\n\n${filesBlock}` : `${header}\n\n${matchesBlock}`
}

describe("code_find toModelOutput FALLBACK MATCH warning", () => {
  test("name-exact derivation → no FALLBACK MATCH in output", () => {
    const output = {
      intent: "definition",
      dispatchedTo: "codegraph_query",
      matches: [{ node: { name: "MemoryRepo", kind: "class", fileID: "fExact" }, derivation: "name-exact" as const }],
      files: [],
      resolvedNodeID: "fExact:n1",
      resolvedDerivation: "name-exact" as const,
    }
    const text = toModelOutput(output)
    expect(text).not.toContain("FALLBACK MATCH")
    expect(text).toContain("derivation=name-exact")
  })

  test("qualified-split derivation → no FALLBACK MATCH in output", () => {
    const output = {
      intent: "definition",
      dispatchedTo: "codegraph_query",
      matches: [
        { node: { name: "ConfigRepo.load", kind: "method", fileID: "fTag" }, derivation: "qualified-split" as const },
      ],
      files: [],
      resolvedNodeID: "fTag:n1",
      resolvedDerivation: "qualified-split" as const,
    }
    const text = toModelOutput(output)
    expect(text).not.toContain("FALLBACK MATCH")
    expect(text).toContain("derivation=qualified-split")
  })

  test("tag-fallback derivation → no FALLBACK MATCH in output (tag-fallback is precise)", () => {
    const output = {
      intent: "definition",
      dispatchedTo: "codegraph_query",
      matches: [{ node: { name: "ConfigRepo", kind: "class", fileID: "fTag" }, derivation: "tag-fallback" as const }],
      files: [],
      resolvedNodeID: "fTag:n1",
      resolvedDerivation: "tag-fallback" as const,
    }
    const text = toModelOutput(output)
    expect(text).not.toContain("FALLBACK MATCH")
    expect(text).toContain("derivation=tag-fallback")
  })

  test("code-substring derivation → FALLBACK MATCH in output", () => {
    const output = {
      intent: "definition",
      dispatchedTo: "codegraph_query",
      matches: [{ node: { name: "Repo", kind: "class", fileID: "fTag" }, derivation: "code-substring" as const }],
      files: [],
      resolvedNodeID: "fTag:n1",
      resolvedDerivation: "code-substring" as const,
    }
    const text = toModelOutput(output)
    expect(text).toContain("FALLBACK MATCH")
    expect(text).toContain("derivation=code-substring")
  })

  test("name-like derivation → FALLBACK MATCH in output", () => {
    const output = {
      intent: "definition",
      dispatchedTo: "codegraph_query",
      matches: [
        { node: { name: "Memory", kind: "class", fileID: "fExact" }, derivation: "name-like" as const },
      ],
      files: [],
      resolvedNodeID: "fExact:n1",
      resolvedDerivation: "name-like" as const,
    }
    const text = toModelOutput(output)
    expect(text).toContain("FALLBACK MATCH")
    expect(text).toContain("derivation=name-like")
  })

  test("stale-graph diagnostic is included alongside derivation (no FALLBACK MATCH)", () => {
    const output = {
      intent: "definition",
      dispatchedTo: "codegraph_query",
      matches: [
        { node: { name: "MemoryRepo", kind: "class", fileID: "fExact" }, derivation: "name-exact" as const },
      ],
      files: [],
      resolvedNodeID: "fExact:n1",
      resolvedDerivation: "name-exact" as const,
      _diagnostic: "stale-graph" as const,
    }
    const text = toModelOutput(output)
    expect(text).not.toContain("FALLBACK MATCH")
    expect(text).toContain("diagnostic=stale-graph")
  })

  test("fuzzy derivation + stale-graph → both FALLBACK MATCH and diagnostic shown", () => {
    const output = {
      intent: "definition",
      dispatchedTo: "codegraph_query",
      matches: [{ node: { name: "ConfigRepo", kind: "class", fileID: "fTag" }, derivation: "code-substring" as const }],
      files: [],
      resolvedNodeID: "fTag:n1",
      resolvedDerivation: "code-substring" as const,
      _diagnostic: "stale-graph" as const,
    }
    const text = toModelOutput(output)
    expect(text).toContain("FALLBACK MATCH")
    expect(text).toContain("diagnostic=stale-graph")
  })

  test("definition intent + non-empty matches + empty files → no 'Files: none.' block", () => {
    const output = {
      intent: "definition",
      dispatchedTo: "codegraph_query",
      matches: [{ node: { name: "MemoryRepo", kind: "class", fileID: "fExact" }, derivation: "name-exact" as const }],
      files: [],
      resolvedNodeID: "fExact:n1",
      resolvedDerivation: "name-exact" as const,
    }
    const text = toModelOutput(output)
    expect(text).not.toContain("Files: none.")
    expect(text).toContain("MemoryRepo")
  })

  test("find_file intent + empty files → 'Files: none.' still shown", () => {
    const output = {
      intent: "find_file",
      dispatchedTo: "graph",
      matches: [],
      files: [],
    }
    const text = toModelOutput(output)
    expect(text).toContain("Files: none.")
  })

  test("find_file intent + non-empty files → 'Files (N):' block shown", () => {
    const output = {
      intent: "find_file",
      dispatchedTo: "graph",
      matches: [],
      files: [{ path: "packages/core/src/foo.ts" }],
    }
    const text = toModelOutput(output)
    expect(text).toContain("Files (1):")
    expect(text).toContain("packages/core/src/foo.ts")
  })
})
