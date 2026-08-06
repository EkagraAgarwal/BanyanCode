/**
 * Unit tests for the graph-first routing policy module
 * (`packages/core/src/banyancode/graph-first-policy.ts`). These cover the
 * pure helpers consumed by the session tool wrapper and the policy renderer:
 * env-var mode parsing, redirect targeting (with the non-code artifact
 * exemption), tool classification sets, and result-outcome classification.
 */

import { describe, expect, test } from "bun:test"
import {
  BASH_TOOL_IDS,
  graphFirstMode,
  graphOutcome,
  isGraphAttempt,
  isSourceRead,
  redirectFor,
} from "@opencode-ai/core/banyancode/graph-first-policy"

describe("graphFirstMode", () => {
  test("defaults to 'off' when the env var is unset", () => {
    const prev = process.env.BANYANCODE_GRAPH_FIRST_MODE
    delete process.env.BANYANCODE_GRAPH_FIRST_MODE
    try {
      expect(graphFirstMode()).toBe("off")
    } finally {
      if (prev === undefined) delete process.env.BANYANCODE_GRAPH_FIRST_MODE
      else process.env.BANYANCODE_GRAPH_FIRST_MODE = prev
    }
  })

  test("parses 'advisory' and 'enforce'", () => {
    const prev = process.env.BANYANCODE_GRAPH_FIRST_MODE
    process.env.BANYANCODE_GRAPH_FIRST_MODE = "advisory"
    expect(graphFirstMode()).toBe("advisory")
    process.env.BANYANCODE_GRAPH_FIRST_MODE = "enforce"
    expect(graphFirstMode()).toBe("enforce")
    if (prev === undefined) delete process.env.BANYANCODE_GRAPH_FIRST_MODE
    else process.env.BANYANCODE_GRAPH_FIRST_MODE = prev
  })

  test("unknown values fall back to 'off'", () => {
    const prev = process.env.BANYANCODE_GRAPH_FIRST_MODE
    process.env.BANYANCODE_GRAPH_FIRST_MODE = "loud"
    try {
      expect(graphFirstMode()).toBe("off")
    } finally {
      if (prev === undefined) delete process.env.BANYANCODE_GRAPH_FIRST_MODE
      else process.env.BANYANCODE_GRAPH_FIRST_MODE = prev
    }
  })
})

describe("redirectFor", () => {
  test("read of a source-code file redirects to code_find", () => {
    const redirect = redirectFor("read", { filePath: "packages/core/src/a.ts" })
    expect(redirect?.tool).toBe("code_find")
    expect(redirect?.hint).toContain("code_find")
  })

  test("read of a source-code file with no extension still redirects", () => {
    const redirect = redirectFor("read", { filePath: "packages/core/Makefile" })
    expect(redirect?.tool).toBe("code_find")
  })

  test("read of a non-code artifact is exempt (configs, docs, lockfiles, binaries)", () => {
    for (const filePath of [
      "packages/core/package.json",
      "README.md",
      "bun.lock",
      "tsconfig.json",
      "src/icons/logo.svg",
      "assets/photo.png",
      "dist/map.wasm",
    ]) {
      expect(redirectFor("read", { filePath })).toBeUndefined()
    }
  })

  test("grep redirects to repository_query", () => {
    expect(redirectFor("grep", { pattern: "Foo" })?.tool).toBe("repository_query")
  })

  test("glob redirects to banyan_repo_map", () => {
    expect(redirectFor("glob", { pattern: "**/*.ts" })?.tool).toBe("banyan_repo_map")
  })

  test("non-source tools and unknown ids never redirect", () => {
    expect(redirectFor("bash", { command: "ls" })).toBeUndefined()
    expect(redirectFor("write", { filePath: "a.ts" })).toBeUndefined()
    expect(redirectFor("edit", {})).toBeUndefined()
  })
})

describe("classification sets", () => {
  test("source reads are read/grep/glob; bash is observed but never a redirect target", () => {
    for (const id of ["read", "grep", "glob"]) expect(isSourceRead(id)).toBe(true)
    expect(isSourceRead("bash")).toBe(false)
    expect(isSourceRead("code_find")).toBe(false)
    expect(BASH_TOOL_IDS.has("bash")).toBe(true)
  })

  test("graph-attempt tools cover the public graph/repository/edit/repo-map families", () => {
    for (const id of [
      "codegraph_build",
      "codegraph_remove",
      "code_find",
      "repository_query",
      "repository_explain",
      "repository_impact",
      "repository_trace",
      "repository_tests",
      "blast_radius",
      "preflight",
      "safe_rename",
      "edit_plan",
      "banyan_repo_map",
      "banyan_tool_search",
      "banyan_test",
    ]) {
      expect(isGraphAttempt(id)).toBe(true)
    }
    expect(isGraphAttempt("read")).toBe(false)
    expect(isGraphAttempt("bash")).toBe(false)
  })
})

describe("graphOutcome", () => {
  test("classifies not-found / empty / stale / failed / fallback / degraded / ok", () => {
    expect(graphOutcome("no symbol found for X")).toBe("not-found")
    expect(graphOutcome("Symbol 'X' not found. Did you mean Y?")).toBe("not-found")
    expect(graphOutcome("Could not find the file")).toBe("not-found")
    expect(graphOutcome("No results for query")).toBe("empty")
    expect(graphOutcome("0 results")).toBe("empty")
    expect(graphOutcome("empty result set")).toBe("empty")
    expect(graphOutcome("graph is stale, rebuilding")).toBe("stale")
    expect(graphOutcome("fallback used: codegraph empty")).toBe("fallback")
    expect(graphOutcome("degraded: partial index")).toBe("degraded")
    expect(graphOutcome("failed to read graph")).toBe("failed")
    expect(graphOutcome("Error: no meta row")).toBe("failed")
    expect(graphOutcome("2 callers in packages/core/src/a.ts")).toBe("ok")
  })
})
