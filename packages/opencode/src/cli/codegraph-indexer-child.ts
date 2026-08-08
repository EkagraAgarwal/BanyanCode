import { runChildIndexer } from "@opencode-ai/core/banyancode/codegraph-indexer-child"

/**
 * Compiled-binary entry for the child-process indexer. In a compiled
 * distribution the child module does not exist on disk, so the build service
 * re-execs the binary with `--codegraph-indexer-child`; this module is the
 * dispatch target (see `packages/opencode/src/index.ts`). It is intentionally
 * a thin re-export of the core implementation so dev/source runs (which spawn
 * `bun <core>/codegraph-indexer-child.ts` directly) and compiled runs share
 * one code path.
 */
export { runChildIndexer }
