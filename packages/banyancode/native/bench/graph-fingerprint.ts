#!/usr/bin/env bun
/**
 * Build a graph over <root> and write it as sorted, comparable text, so two
 * builds (or two versions of the indexer) can be diffed row by row.
 *
 *   bun native/bench/graph-fingerprint.ts <root> <out-file>
 *
 * parity-real.ts compares the TypeScript and native backends inside one
 * version; this compares one backend across versions. File ids are minted per
 * build, so every id is rewritten with the file's path before comparing.
 */
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"

const root = process.argv[2]
const out = process.argv[3]
if (!root || !out) throw new Error("usage: bun native/bench/graph-fingerprint.ts <root> <out-file>")

const dbDir = await mkdtemp(join(tmpdir(), "banyan-fingerprint-db-"))
process.env.BANYANCODE_PROJECT_DB_DIR = dbDir

const lines = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const storage = yield* Storage.open({ projectRoot: root, env: process.env })
      const indexer = yield* makeIndexer(makeRepo(storage), storage)
      yield* indexer.index({ root, force: true })
      const files = yield* storage.query<{ id: string; path: string; content_hash: string; language: string }>(
        "SELECT id, path, content_hash, language FROM codegraph_files",
      )
      const pathByID = new Map(files.map((file) => [file.id, file.path.split(root).join("<root>")]))
      const stable = (id: string) => id.replace(/^[^:]+/, (fileID) => pathByID.get(fileID) ?? fileID)
      const nodes = yield* storage.query<Record<string, string | number | null>>("SELECT * FROM codegraph_nodes")
      const edges = yield* storage.query<{ from_node_id: string; to_node_id: string; kind: string }>(
        "SELECT from_node_id, to_node_id, kind FROM codegraph_edges",
      )
      const tags = yield* storage.query<{ tag: string; service_name: string; node_id: string; class_name: string }>(
        "SELECT tag, service_name, node_id, class_name FROM codegraph_service_tags",
      )
      const ftsDocs = yield* storage.query<{ c: number }>("SELECT COUNT(*) AS c FROM codegraph_nodes_fts")
      const ftsMatch = yield* storage.query<{ c: number }>(
        "SELECT COUNT(*) AS c FROM codegraph_nodes_fts WHERE codegraph_nodes_fts MATCH 'import'",
      )
      const hash = (value: unknown) => (value === null ? "null" : createHash("sha1").update(String(value)).digest("hex"))
      return [
        ...files.map((file) => `F ${pathByID.get(file.id)} ${file.content_hash} ${file.language}`),
        ...nodes.map(
          (node) =>
            `N ${stable(String(node.id))} ${node.kind} ${node.name} ${node.start_line}-${node.end_line} ` +
            `ep=${node.is_entrypoint} deg=${node.in_degree} sig=${hash(node.signature)} code=${hash(node.code)}`,
        ),
        ...edges.map((edge) => `E ${stable(edge.from_node_id)} -> ${stable(edge.to_node_id)} ${edge.kind}`),
        ...tags.map((tag) => `T ${tag.tag} ${tag.service_name} ${stable(tag.node_id)} ${tag.class_name}`),
        `S fts_docs=${ftsDocs[0]?.c} fts_match_import=${ftsMatch[0]?.c}`,
      ].sort()
    }),
  ),
)
await rm(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
await Bun.write(out, lines.join("\n") + "\n")
const count = (prefix: string) => lines.filter((line) => line.startsWith(prefix)).length
console.log(
  `files=${count("F ")} nodes=${count("N ")} edges=${count("E ")} tags=${count("T ")} ` +
    `sha1=${createHash("sha1").update(lines.join("\n")).digest("hex")}`,
)
