import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { ensureWebTreeSitterReady, treeSitterStateRef } from "../../src/banyancode/langs/tree-sitter"
import { parseLanguageWithTreeSitter } from "../../src/banyancode/langs/query-executor"
import { TREE_SITTER_WALK_EXTENSIONS, parseGeneric } from "../../src/banyancode/langs/registry"

process.env.BANYANCODE_ENABLE = "1"

// Phase 5 (Batch 3): the 13 tree-sitter grammars bundled by the loader are
// wired into the indexer as real node-extraction adapters (langs/adapters/).
// Each language parses through parseLanguageWithTreeSitter with a regex
// fallback; nodes carry the Phase-0 derivation contract (tree-sitter-v1 when
// the AST pass ran, regex-v1 when wasm is unavailable) and syntax errors are
// recorded + the file still indexes. TS/JS/Python routing is untouched.
const setEdgesMode = (mode: "derived" | "parser" | undefined): void => {
  if (mode === undefined) delete process.env.BANYANCODE_TS_EDGES
  else process.env.BANYANCODE_TS_EDGES = mode
}

afterEach(() => {
  setEdgesMode(undefined)
})

const serviceLayer = CodegraphIndexer.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoDefaultLayer),
)

type ExpectedNode = { kind: string; name: string; line: number }

type WalkerSample = {
  ext: string
  fileName: string
  content: string
  // Indexable by the walker (CODE_EXTENSIONS) vs parse-level only
  // (json/toml/yaml are non-code by product policy — see
  // codegraph-gitignore-semantics.test.ts "non-code files" parity test).
  indexable: boolean
  expected: ExpectedNode[]
}

// Line numbers are the contract: startLine must be startPosition.row + 1
// (1-based, matching the tree-sitter backend). Every sample has a comment or
// header on line 1 so the first symbol is NOT on line 1 — the historical
// off-by-one direction.
const WALKER_SAMPLES: WalkerSample[] = [
  {
    ext: ".rs",
    fileName: "main.rs",
    indexable: true,
    content: `// header keeps helper off line 1

fn helper() -> i32 {
    1
}

impl Point {
    fn dist(&self) -> f64 { 1.0 }
}

pub struct Point {}

fn caller() {
    helper();
}
`,
    expected: [
      { kind: "function", name: "helper", line: 3 },
      { kind: "method", name: "dist", line: 8 },
      { kind: "class", name: "Point", line: 11 },
      { kind: "function", name: "caller", line: 13 },
    ],
  },
  {
    ext: ".go",
    fileName: "main.go",
    indexable: true,
    content: `package main

type Server struct {
    Port int
}

func (s *Server) Start() {
}

func helper() {
}

func main() {
    helper()
}
`,
    expected: [
      { kind: "class", name: "Server", line: 3 },
      { kind: "method", name: "Start", line: 7 },
      { kind: "function", name: "helper", line: 10 },
      { kind: "function", name: "main", line: 13 },
    ],
  },
  {
    ext: ".java",
    fileName: "Main.java",
    indexable: true,
    content: `public class Main {
    public static void main(String[] args) {
        helper();
    }

    public static void helper() {
    }
}
`,
    expected: [
      { kind: "class", name: "Main", line: 1 },
      { kind: "method", name: "main", line: 2 },
      { kind: "method", name: "helper", line: 6 },
    ],
  },
  {
    ext: ".c",
    fileName: "server.c",
    indexable: true,
    content: `#include <stdio.h>

typedef struct Point {
    int x;
} Point;

static int helper(int a) {
    return a + 1;
}

Point* make_point(void) {
    return 0;
}

int main(void) {
    int v = helper(1);
    return v;
}
`,
    expected: [
      { kind: "class", name: "Point", line: 3 },
      { kind: "type", name: "Point", line: 3 },
      { kind: "function", name: "helper", line: 7 },
      // Pointer-returning function: the declarator chain wraps one level
      // deeper (pointer_declarator -> function_declarator -> identifier).
      { kind: "function", name: "make_point", line: 11 },
      { kind: "function", name: "main", line: 15 },
    ],
  },
  {
    ext: ".cpp",
    fileName: "server.cpp",
    indexable: true,
    content: `#include <vector>

class Widget {
public:
    void draw();
};

struct Config {
    int port;
};

void Widget::draw() {
    int x = 1;
}

int main() {
    Widget w;
    w.draw();
    return 0;
}
`,
    expected: [
      { kind: "class", name: "Widget", line: 3 },
      { kind: "class", name: "Config", line: 8 },
      { kind: "method", name: "draw", line: 12 },
      { kind: "function", name: "main", line: 16 },
    ],
  },
  {
    ext: ".cs",
    fileName: "Program.cs",
    indexable: true,
    content: `using System;

public class Program
{
    public static void Main(string[] args)
    {
        Helper.Run();
    }
}

static class Helper
{
    public static void Run() { }
}
`,
    expected: [
      { kind: "class", name: "Program", line: 3 },
      { kind: "method", name: "Main", line: 5 },
      { kind: "class", name: "Helper", line: 11 },
      { kind: "method", name: "Run", line: 13 },
    ],
  },
  {
    ext: ".rb",
    fileName: "main.rb",
    indexable: true,
    content: `# header
class Greeter
  def hello
    puts "hi"
  end
end

def top_level
  Greeter.new("x").hello
end
`,
    expected: [
      { kind: "class", name: "Greeter", line: 2 },
      { kind: "method", name: "hello", line: 3 },
      { kind: "function", name: "top_level", line: 8 },
    ],
  },
  {
    ext: ".php",
    fileName: "server.php",
    indexable: true,
    content: `<?php

class Server
{
    public function start()
    {
        return helper();
    }
}

function helper() {
    return 1;
}
`,
    expected: [
      { kind: "class", name: "Server", line: 3 },
      { kind: "method", name: "start", line: 5 },
      { kind: "function", name: "helper", line: 11 },
    ],
  },
  {
    ext: ".sh",
    fileName: "deploy.sh",
    indexable: true,
    content: `#!/usr/bin/env bash

helper() {
    echo "helper"
}

function main {
    helper
}
`,
    expected: [
      { kind: "function", name: "helper", line: 3 },
      { kind: "function", name: "main", line: 7 },
    ],
  },
  {
    ext: ".zig",
    fileName: "main.zig",
    indexable: true,
    content: `const std = @import("std");

pub const Point = struct {
    x: f64,
};

pub fn add(a: i32, b: i32) i32 {
    return a + b;
}

pub fn main() void {
    add(1, 2);
}
`,
    expected: [
      { kind: "variable", name: "std", line: 1 },
      { kind: "class", name: "Point", line: 3 },
      { kind: "function", name: "add", line: 7 },
      { kind: "function", name: "main", line: 11 },
    ],
  },
  {
    ext: ".json",
    fileName: "probe.json",
    indexable: false,
    content: `{
  "name": "probe",
  "nested": {
    "items": [1, 2, 3]
  }
}
`,
    expected: [
      { kind: "variable", name: "name", line: 2 },
      { kind: "variable", name: "nested", line: 3 },
      { kind: "variable", name: "items", line: 4 },
    ],
  },
  {
    ext: ".toml",
    fileName: "probe.toml",
    indexable: false,
    content: `[package]
name = "probe"

[dependencies]
serde = "1.0"
`,
    expected: [
      { kind: "type", name: "package", line: 1 },
      { kind: "variable", name: "name", line: 2 },
      { kind: "type", name: "dependencies", line: 4 },
      { kind: "variable", name: "serde", line: 5 },
    ],
  },
  {
    ext: ".yml",
    fileName: "probe.yml",
    indexable: false,
    content: `name: probe
services:
  web:
    image: nginx
`,
    expected: [
      { kind: "variable", name: "name", line: 1 },
      { kind: "variable", name: "services", line: 2 },
      { kind: "variable", name: "web", line: 3 },
      { kind: "variable", name: "image", line: 4 },
    ],
  },
]

const writeFixture = async (root: string, name: string, content: string): Promise<void> => {
  await fs.writeFile(path.join(root, name), content)
}

const indexRoot = (root: string): Promise<{
  indexed: number
  skippedByReason: Record<string, number>
  parseErrors: Array<{ path: string; cause: string; indexedAt: number }>
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const indexer = yield* CodegraphIndexer.Service
      return yield* indexer.index({ root, force: true })
    }).pipe(Effect.provide(serviceLayer), Effect.provide(Database.layerFromPath(path.join(root, "graph.sqlite"))), Effect.scoped),
  )

const tsReady = async (): Promise<boolean> => {
  await Effect.runPromise(ensureWebTreeSitterReady())
  const state = await Effect.runPromise(Ref.get(treeSitterStateRef))
  return state._tag === "ready"
}

describe("codegraph multi-language tree-sitter adapters (Phase 5 Batch 3)", () => {
  test("walker dispatch covers the 13 languages and excludes TS/JS/Python", () => {
    const exts = TREE_SITTER_WALK_EXTENSIONS
    for (const sample of WALKER_SAMPLES) expect(exts).toContain(sample.ext)
    // TS/PY routing must stay on the .scm-query path — identical behavior.
    for (const tsPy of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".pyw"]) {
      expect(exts).not.toContain(tsPy)
    }
  })

  test("parseLanguageWithTreeSitter extracts the mapped nodes for all 13 languages", async () => {
    await Effect.runPromise(ensureWebTreeSitterReady())
    for (const sample of WALKER_SAMPLES) {
      const parsed = await Effect.runPromise(
        parseLanguageWithTreeSitter(sample.ext, sample.content, "probe-id", () => parseGeneric(sample.content, "probe-id")),
      )
      // Either backend is valid depending on wasm availability in the test
      // env (same contract as the TS/PY tests).
      expect(parsed.backend ?? "regex").toBeOneOf(["tree-sitter", "regex"])
      if (parsed.backend === "tree-sitter") {
        for (const expected of sample.expected) {
          const found = parsed.nodes.some(
            (n) => n.kind === expected.kind && n.name === expected.name && n.startLine === expected.line,
          )
          expect(found, `${sample.ext}: ${expected.kind} ${expected.name} @ ${expected.line}`).toBe(true)
        }
      }
    }
  })

  test("indexer-level: each indexable language produces nodes via the real index", async () => {
    await using tmp = await tmpdir()
    const wasm = await tsReady()
    for (const sample of WALKER_SAMPLES) {
      if (!sample.indexable) continue
      const langTmp = path.join(tmp.path, sample.ext.slice(1))
      await fs.mkdir(langTmp, { recursive: true })
      await writeFixture(langTmp, sample.fileName, sample.content)
    }

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(WALKER_SAMPLES.filter((s) => s.indexable).length)
    // When the AST pass engaged the samples are clean (no ERROR/MISSING);
    // when wasm is unavailable every file records a "tree-sitter
    // unavailable" parse error instead — the file still indexes.
    if (wasm) {
      expect(result.parseErrors).toEqual([])
      expect(result.skippedByReason.parseFailure).toBe(0)
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        for (const sample of WALKER_SAMPLES) {
          if (!sample.indexable) continue
          for (const expected of sample.expected) {
            // queryNodes only accepts { function?, kind? }; searchNodes
            // takes name + kind for every node kind.
            const nodes = yield* repo.searchNodes({ name: expected.name, kind: expected.kind, limit: 100 })
            expect(
              nodes.length,
              `${sample.ext}: ${expected.kind} ${expected.name} should exist in the graph`,
            ).toBeGreaterThanOrEqual(1)
          }
        }
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })

  test("malformed rust/go/java: index completes, parse error recorded, regex fallback nodes present", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "broken.rs", "fn broken() {\n  return 1\n")
    await writeFixture(tmp.path, "broken.go", "package main\n\nfunc broken() {\n  return 1\n")
    await writeFixture(tmp.path, "Broken.java", "public class Broken {\n  public static void main(String[] args) {\n")

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(1)
    expect(result.skippedByReason.parseFailure).toBeGreaterThanOrEqual(1)

    for (const rel of ["broken.rs", "broken.go", "Broken.java"]) {
      const recorded = result.parseErrors.find((e) => e.path === rel)
      expect(recorded, `${rel} parse error recorded`).toBeDefined()
      // "tree-sitter syntax error at line N: …" when the grammar flagged the
      // missing brace, "tree-sitter unavailable: …" when wasm is missing —
      // the real-message requirement holds either way.
      expect(recorded!.cause).toMatch(/tree-sitter/)
    }

    // Regex fallback nodes are present for the malformed files (record +
    // continue): parseGeneric finds fn broken / func broken / class Broken.
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const rust = yield* repo.searchNodes({ name: "broken", kind: "function", limit: 100 })
        expect(rust.length).toBeGreaterThanOrEqual(1)
        const go = yield* repo.searchNodes({ name: "broken", kind: "function", limit: 100 })
        expect(go.length).toBeGreaterThanOrEqual(1)
        const java = yield* repo.searchNodes({ name: "Broken", kind: "class", limit: 100 })
        expect(java.length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })

  test("derived mode: same-file calls edges exist for go/rust/java (methods extract)", async () => {
    await using tmp = await tmpdir()
    const wasm = await tsReady()
    await writeFixture(tmp.path, "main.go", `package main

func helper() {
}

func caller() {
    helper()
}
`)
    await writeFixture(tmp.path, "main.rs", `fn helper() -> i32 {
    1
}

fn caller() -> i32 {
    helper()
}
`)
    await writeFixture(tmp.path, "Main.java", `public class Main {
    public static void main(String[] args) {
        helper();
    }

    public static void helper() {
    }
}
`)

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(3)
    if (wasm) expect(result.parseErrors).toEqual([])

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const { db } = yield* Database.Service
        const files = yield* repo.listAllFiles()
        const goFile = files.find((f) => f.path.endsWith("main.go"))
        const rsFile = files.find((f) => f.path.endsWith("main.rs"))
        const javaFile = files.find((f) => f.path.endsWith("Main.java"))
        expect(goFile).toBeDefined()
        expect(rsFile).toBeDefined()
        expect(javaFile).toBeDefined()
        if (!goFile || !rsFile || !javaFile) return

        // Go: caller (line 6) -> helper (line 3). The derived identifier
        // scan needs node.code — the walker slices the AST node text.
        const goEdge = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls'
            AND from_node_id = ${`${goFile!.id}:function:caller:6`}
            AND to_node_id = ${`${goFile!.id}:function:helper:3`}
        `)
        expect(goEdge?.c ?? 0).toBe(1)

        // Rust: caller (line 5) -> helper (line 1).
        const rsEdge = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls'
            AND from_node_id = ${`${rsFile!.id}:function:caller:5`}
            AND to_node_id = ${`${rsFile!.id}:function:helper:1`}
        `)
        expect(rsEdge?.c ?? 0).toBe(1)

        // Java: the walker extracts METHODS (regex parseGeneric could not);
        // main (line 2) -> helper (line 6) with both endpoints as method
        // nodes — the new capability this batch adds.
        const javaEdge = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls'
            AND from_node_id = ${`${javaFile!.id}:method:main:2`}
            AND to_node_id = ${`${javaFile!.id}:method:helper:6`}
        `)
        expect(javaEdge?.c ?? 0).toBe(1)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })

  test("parser mode: walker languages have no parser-owned edges; derived calls still regenerate", async () => {
    await using tmp = await tmpdir()
    await writeFixture(tmp.path, "main.go", `package main

func helper() {
}

func caller() {
    helper()
}
`)
    setEdgesMode("parser")
    await Effect.runPromise(ensureWebTreeSitterReady())

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(1)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const { db } = yield* Database.Service
        const file = (yield* repo.listAllFiles()).find((f) => f.path.endsWith("main.go"))
        expect(file).toBeDefined()
        if (!file) return
        // No parser-style edge ids (walker languages emit no tree-sitter
        // edges): the parser-owned lifecycle must not engage for them.
        const parserCalls = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls' AND id LIKE '%:calls:%' AND id NOT LIKE '%->%'
        `)
        expect(parserCalls?.c ?? 0).toBe(0)
        // Derived regeneration still produced the go call edge.
        const derived = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls'
            AND from_node_id = ${`${file!.id}:function:caller:6`}
            AND to_node_id = ${`${file!.id}:function:helper:3`}
        `)
        expect(derived?.c ?? 0).toBe(1)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })

  test("parser mode: c files with regex call edges are NOT parser-owned; cross-file peer calls regenerate", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    // Same-dir peer files, exactly the edge-eval fixture shape: server.c
    // calls helper() living in util.h. parseC emits same-file `calls` edges
    // with derived-style `->` ids; without the ownership guard those would
    // claim parser ownership in parser mode and rebuildDerivedGraph would
    // skip regenerating the CROSS-FILE edge (peer scope).
    await writeFixture(path.join(tmp.path, "src"), "server.c", `#include "util.h"

static void log_request(void) {
}

void handle_request(void) {
  log_request();
  helper();
}
`)
    await writeFixture(path.join(tmp.path, "src"), "util.h", `static inline void helper(void) {
}
`)
    setEdgesMode("parser")
    await Effect.runPromise(ensureWebTreeSitterReady())

    const result = await indexRoot(tmp.path)
    expect(result.indexed).toBeGreaterThanOrEqual(2)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const { db } = yield* Database.Service
        const serverFile = (yield* repo.listAllFiles()).find((f) => f.path.endsWith("server.c"))
        const utilFile = (yield* repo.listAllFiles()).find((f) => f.path.endsWith("util.h"))
        expect(serverFile).toBeDefined()
        expect(utilFile).toBeDefined()
        if (!serverFile || !utilFile) return
        // Cross-file same-dir peer edge: handle_request (line 6) -> helper
        // (line 1 of util.h).
        const crossFile = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls'
            AND from_node_id = ${`${serverFile!.id}:function:handle_request:6`}
            AND to_node_id = ${`${utilFile!.id}:function:helper:1`}
        `)
        expect(crossFile?.c ?? 0).toBe(1)
        // Same-file edge also regenerated.
        const sameFile = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls'
            AND from_node_id = ${`${serverFile!.id}:function:handle_request:6`}
            AND to_node_id = ${`${serverFile!.id}:function:log_request:3`}
        `)
        expect(sameFile?.c ?? 0).toBe(1)
        // No parser-style edge ids at all: the c file never claimed parser
        // ownership.
        const parserCalls = yield* db.get<{ c: number }>(sql`
          SELECT COUNT(*) AS c FROM codegraph_edges
          WHERE kind = 'calls' AND id LIKE '%:calls:%' AND id NOT LIKE '%->%'
        `)
        expect(parserCalls?.c ?? 0).toBe(0)
      }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(Database.layerFromPath(path.join(tmp.path, "graph.sqlite"))), Effect.scoped),
    )
  })
})
