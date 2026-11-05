/**
 * Native sidecar parity + fallback.
 *
 * Two backends must produce the same graph: `BANYANCODE_NATIVE_INDEXER=off`
 * runs the TypeScript parsers, the default runs `banyan-indexer`. The fixture
 * below carries one file per supported language, a file with a syntax error,
 * and at least one file in every skip bucket that a static tree can reach.
 *
 * Node ids embed the file id, which is a fresh UUID per build, so ids are
 * normalised by substituting each file id with its relative path before the
 * comparison. Everything else — kind, name, line numbers, signature, code and
 * every edge endpoint — is compared literally.
 *
 * The suite skips (visibly) when the sidecar binary has not been built.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"
import { resolveNativeIndexerPath } from "../../src/codegraph/langs/native.js"

const write = async (root: string, path: string, content: string) => {
  const absolute = join(root, path)
  await mkdir(join(absolute, ".."), { recursive: true })
  await writeFile(absolute, content, "utf8")
}

/** One representative file per supported language, plus the odd cases. */
const buildFixture = async (root: string) => {
  await write(
    root,
    "src/app.ts",
    [
      'import { helper } from "./util"',
      "",
      "export interface Options {",
      "  readonly retries: number",
      "  run(input: string): Promise<void>",
      "}",
      "",
      "export class Client {",
      "  constructor(private readonly options: Options) {}",
      "",
      "  async send(payload: string) {",
      "    return helper(payload)",
      "  }",
      "}",
      "",
      "export function makeClient(options: Options) {",
      "  return new Client(options)",
      "}",
      "",
      "export const withRetries = (options: Options) => {",
      "  return makeClient(options)",
      "}",
      "",
      "export type Mode = \"fast\" | \"slow\"",
      "",
      "export interface Interface {",
      "  readonly start: (root: string) => Promise<void>",
      "}",
      "",
      "export * as Wildcard from \"./util\"",
      "",
      "export const handler = Effect.fn(\"handler\")(function* (root: string) {",
      "  return makeClient({ retries: 1, run: async () => {} })",
      "})",
    ].join("\n"),
  )
  await write(
    root,
    "src/util.js",
    [
      "import { readFile } from \"node:fs/promises\"",
      "",
      "export function helper(value) {",
      "  return String(value)",
      "}",
      "",
      "export const load = async (path) => {",
      "  return readFile(path)",
      "}",
      "",
      "export class Store {",
      "  get(key) {",
      "    return helper(key)",
      "  }",
      "}",
    ].join("\n"),
  )
  await write(root, "src/broken.ts", "export function broken( {\n  return 1\n")
  await write(
    root,
    "py/app.py",
    ["import os", "", "def greet(name):", "    return 'hi ' + name", "", "class Greeter:", "    def run(self):", "        return greet('x')"].join(
      "\n",
    ),
  )
  await write(
    root,
    "rust/lib.rs",
    [
      "pub struct Point { pub x: i32 }",
      "",
      "pub fn add(a: i32, b: i32) -> i32 {",
      "    a + b",
      "}",
      "",
      "impl Point {",
      "    pub fn draw(&self) -> i32 {",
      "        add(self.x, 1)",
      "    }",
      "}",
    ].join("\n"),
  )
  await write(
    root,
    "go/main.go",
    [
      "package main",
      "",
      "type Point struct {",
      "  X int",
      "}",
      "",
      "type Shape interface {",
      "  Area() int",
      "}",
      "",
      "func Add(a int, b int) int {",
      "  return a + b",
      "}",
      "",
      "func (p Point) Area() int {",
      "  return p.X",
      "}",
    ].join("\n"),
  )
  await write(
    root,
    "java/Main.java",
    [
      "package demo;",
      "",
      "public class Main {",
      "  public int add(int a, int b) {",
      "    return a + b;",
      "  }",
      "}",
      "",
      "interface Shape {",
      "  int area();",
      "}",
    ].join("\n"),
  )
  await write(
    root,
    "c/lib.c",
    [
      "#include <stdio.h>",
      "#define MAX 10",
      "",
      "struct Point {",
      "  int x;",
      "};",
      "",
      "int add(int a, int b) {",
      "  return a + b;",
      "}",
    ].join("\n"),
  )
  await write(
    root,
    "cpp/widget.cpp",
    [
      "class Widget {",
      "public:",
      "  int draw(int scale) {",
      "    return scale;",
      "  }",
      "};",
      "",
      "int Widget::measure(int scale) {",
      "  return scale * 2;",
      "}",
    ].join("\n"),
  )
  await write(
    root,
    "cs/Program.cs",
    [
      "namespace Demo {",
      "  public class Widget {",
      "    public int Draw(int scale) {",
      "      return scale;",
      "    }",
      "  }",
      "}",
    ].join("\n"),
  )
  await write(
    root,
    "ruby/app.rb",
    ["class Greeter", "  def run(name)", "    greet(name)", "  end", "end", "", "def greet(name)", "  name", "end"].join("\n"),
  )
  await write(
    root,
    "php/app.php",
    ["<?php", "class Greeter {", "  public function run($name) {", "    return greet($name);", "  }", "}", "function greet($name) {", "  return $name;", "}"].join(
      "\n",
    ),
  )
  await write(root, "sh/run.sh", ["#!/bin/bash", "greet() {", "  echo hi", "}", "", "greet"].join("\n"))
  await write(root, "zig/main.zig", ["const std = @import(\"std\");", "", "pub fn add(a: i32, b: i32) i32 {", "    return a + b;", "}"].join("\n"))
  await write(root, "data/settings.json", ["{", '  "name": "demo",', '  "nested": { "inner": 1 }', "}"].join("\n"))
  await write(root, "conf/settings.toml", ["[server]", 'host = "localhost"', "port = 8080", ""].join("\n"))
  await write(root, "conf/ci.yml", ["name: ci", "steps:", "  - run: echo hi", ""].join("\n"))
  await write(root, "docs/README.md", ["# Title", "", "text", "", "## Sub", ""].join("\n"))
  await write(root, "Dockerfile", ["FROM alpine:3", "RUN echo hi", ""].join("\n"))

  // Skip buckets.
  await write(root, "node_modules/pkg/index.ts", "export function vendored() { return 1 }\n")
  await write(root, ".gitignore", "*.log\n")
  await write(root, "build.log", "x\n")
  await write(root, ".banyancode/ignore", "src/vendor.ts\n")
  await write(root, "src/vendor.ts", "export function invisible() { return 1 }\n")
  await write(root, "src/minified.ts", `export const blob = "${"x".repeat(6000)}"\n`)
  await write(root, "src/huge.ts", `export const huge = "${"y".repeat(1_100_000)}"\n`)
  // `isArtifact` is true (the path contains `dockerfile.`) while
  // `classifyFileKind` finds nothing, which is the only reachable shape for the
  // `artifact` bucket.
  await write(root, "src/weird.dockerfile.ts", "export function odd() { return 1 }\n")
}

interface Snapshot {
  backend: string
  indexed: number
  skippedByReason: Record<string, number>
  parseErrors: string[]
  files: string[]
  nodes: string[]
  edges: string[]
}

const normalise = (files: Array<{ id: string; path: string }>, values: string[]): string[] => {
  const sorted = [...files].sort((a, b) => b.id.length - a.id.length)
  return values
    .map((value) => sorted.reduce((acc, file) => acc.replaceAll(file.id, `<${file.path}>`), value))
    .sort()
}

const indexTree = async (root: string, native: boolean): Promise<Snapshot> => {
  const dbDir = await mkdtemp(join(tmpdir(), "banyan-parity-db-"))
  const previous = process.env.BANYANCODE_NATIVE_INDEXER
  if (native) delete process.env.BANYANCODE_NATIVE_INDEXER
  else process.env.BANYANCODE_NATIVE_INDEXER = "off"
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({ projectRoot: root, env: { ...process.env, BANYANCODE_PROJECT_DB_DIR: dbDir } })
          const repo = makeRepo(storage)
          const indexer = yield* makeIndexer(repo, storage)
          const result = yield* indexer.index({ root, force: true })
          const files = yield* repo.listAllFiles()
          const nodes = yield* repo.listAllNodes()
          const edges = yield* repo.listAllEdges()
          const errors = yield* repo.listParseErrors()
          return {
            backend: result.backend,
            indexed: result.indexed,
            skippedByReason: { ...result.skippedByReason },
            parseErrors: errors.map((error) => error.path).sort(),
            files: files.map((file) => file.path.replace(root, "").replaceAll("\\", "/")).sort(),
            nodes: normalise(
              files,
              nodes.map(
                (node) =>
                  [
                    node.id,
                    node.kind,
                    node.name,
                    node.startLine,
                    node.endLine,
                    node.signature ?? "",
                    node.code ?? "",
                    node.isEntrypoint ?? 0,
                  ].join("|"),
              ),
            ),
            edges: normalise(
              files,
              edges.map((edge) => [edge.id, edge.fromNodeID, edge.toNodeID, edge.kind].join("|")),
            ),
          }
        }),
      ),
    )
  } finally {
    if (previous === undefined) delete process.env.BANYANCODE_NATIVE_INDEXER
    else process.env.BANYANCODE_NATIVE_INDEXER = previous
    await rm(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const sidecar = await resolveNativeIndexerPath()
const missing = sidecar === undefined

describe.skipIf(missing)("native indexer parity", () => {
  let root = ""
  let ts: Snapshot
  let native: Snapshot

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "banyan-parity-fixture-"))
    await buildFixture(root)
    ts = await indexTree(root, false)
    native = await indexTree(root, true)
  }, 120_000)

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  test("the native backend actually ran", () => {
    expect(native.backend).toBe("native")
    expect(ts.backend).toBe("typescript")
  })

  test("every indexer-reachable language is represented", () => {
    const indexed = native.files.filter((path) => !path.endsWith("/ignore") && !path.endsWith(".gitignore"))
    for (const expected of [
      "/src/app.ts",
      "/src/util.js",
      "/src/broken.ts",
      "/py/app.py",
      "/rust/lib.rs",
      "/go/main.go",
      "/java/Main.java",
      "/c/lib.c",
      "/cpp/widget.cpp",
      "/cs/Program.cs",
      "/ruby/app.rb",
      "/php/app.php",
      "/sh/run.sh",
      "/zig/main.zig",
      "/docs/README.md",
      "/Dockerfile",
    ]) {
      expect(indexed).toContain(expected)
    }
  })

  test("json, toml and yaml never reach the indexer", () => {
    // `.json`/`.toml`/`.yml`/`.yaml` are not in CODE_EXTENSIONS, so a file is
    // only a candidate when `isArtifactPath` matches — and every one of those
    // shapes takes the artifact branch, which parses nothing. The json/toml/
    // yaml AST-walk adapters are therefore unreachable through the indexer on
    // BOTH backends. Guarded here so a future change to the extension list is a
    // deliberate one, and covered at the parser level by the crate's own tests.
    for (const path of ["/data/settings.json", "/conf/settings.toml", "/conf/ci.yml"]) {
      expect(native.files).not.toContain(path)
      expect(ts.files).not.toContain(path)
    }
  })

  test("nodes match the TypeScript backend exactly", () => {
    expect(native.nodes.length).toBeGreaterThan(20)
    expect(native.nodes).toEqual(ts.nodes)
  })

  test("edges match the TypeScript backend exactly", () => {
    expect(native.edges).toEqual(ts.edges)
  })

  test("the same files are indexed and skipped", () => {
    expect(native.files).toEqual(ts.files)
    expect(native.indexed).toBe(ts.indexed)
    expect(native.skippedByReason).toEqual(ts.skippedByReason)
  })

  test("the syntax error is reported by both backends", () => {
    expect(native.parseErrors).toEqual(ts.parseErrors)
    expect(native.parseErrors).toContain("src/broken.ts")
  })

  test("each statically reachable skip bucket is hit", () => {
    expect(native.skippedByReason.gitignored).toBeGreaterThanOrEqual(2)
    expect(native.skippedByReason.banyanignored).toBeGreaterThanOrEqual(1)
    expect(native.skippedByReason.tooLarge).toBeGreaterThanOrEqual(1)
    expect(native.skippedByReason.minified).toBeGreaterThanOrEqual(1)
    expect(native.skippedByReason.artifact).toBeGreaterThanOrEqual(1)
    expect(native.skippedByReason.parseFailure).toBeGreaterThanOrEqual(1)
    // `tooLargeParse` (a file that grows between the stat and the read) and
    // `readError` (a file that vanishes or loses read permission after the
    // walk) are races, not static-tree conditions. Both backends must agree
    // they did not fire rather than silently drifting apart.
    expect(native.skippedByReason.tooLargeParse).toBe(0)
    expect(native.skippedByReason.readError).toBe(0)
  })

  test("a second pass reports the cached bucket identically", async () => {
    const runTwice = async (useNative: boolean) => {
      const dbDir = await mkdtemp(join(tmpdir(), "banyan-parity-db-"))
      const previous = process.env.BANYANCODE_NATIVE_INDEXER
      if (useNative) delete process.env.BANYANCODE_NATIVE_INDEXER
      else process.env.BANYANCODE_NATIVE_INDEXER = "off"
      try {
        return await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const storage = yield* Storage.open({
                projectRoot: root,
                env: { ...process.env, BANYANCODE_PROJECT_DB_DIR: dbDir },
              })
              const repo = makeRepo(storage)
              const indexer = yield* makeIndexer(repo, storage)
              yield* indexer.index({ root, force: true })
              const second = yield* indexer.index({ root })
              return second.skippedByReason.cached
            }),
          ),
        )
      } finally {
        if (previous === undefined) delete process.env.BANYANCODE_NATIVE_INDEXER
        else process.env.BANYANCODE_NATIVE_INDEXER = previous
        await rm(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
    const tsCached = await runTwice(false)
    const nativeCached = await runTwice(true)
    expect(nativeCached).toBeGreaterThan(5)
    expect(nativeCached).toBe(tsCached)
  }, 120_000)
})

if (missing) {
  // `describe.skipIf` hides the reason; say it out loud so a missing binary is
  // never mistaken for a passing parity check.
  console.warn(
    "SKIPPED native indexer parity: banyan-indexer not found. Build it with `cargo build --release` in packages/banyancode/native, or set BANYANCODE_NATIVE_INDEXER_PATH.",
  )
}
