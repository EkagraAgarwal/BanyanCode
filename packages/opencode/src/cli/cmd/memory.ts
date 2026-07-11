import type { Argv } from "yargs"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(Database.defaultLayer))
const memoryServiceLayer = Banyan.memoryServiceLayer.pipe(
  Layer.provide(Banyan.memoryRepoDefaultLayer),
  Layer.provide(Database.defaultLayer),
)

const ListCommand = effectCmd({
  command: "list",
  describe: "list memory entries (active by default)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("scope", {
        type: "string",
        default: "global",
        describe: "which scope to read from",
      })
      .option("status", { type: "string", describe: "filter by status" })
      .option("kind", { type: "string", describe: "filter by MemoryKind" })
      .option("limit", { type: "number", default: 50 }),
  handler: Effect.fn("Cli.memory.list")(function* (args: any) {
    return yield* Effect.gen(function* () {
      const repo = yield* Banyan.MemoryRepo
      const scope = (args.scope ?? "global") as "global" | "session"
      const entries = yield* repo.list(scope, undefined)
      const filtered = entries.filter((e: any) => {
        if (args.status && e.status !== args.status) return false
        if (args.kind && e.kind !== args.kind) return false
        return true
      })
      const limit = args.limit
      const slice = filtered.slice(0, limit)
      UI.println(UI.Style.TEXT_HIGHLIGHT + `Memory (${slice.length} of ${filtered.length})` + UI.Style.TEXT_NORMAL)
      if (slice.length === 0) {
        UI.println(dim("  (none)"))
        return
      }
      for (const e of slice) {
        const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""
        UI.println(
          `  ${e.id}  ${UI.Style.TEXT_HIGHLIGHT}${e.key}${UI.Style.TEXT_NORMAL}` +
            `  ${dim(`v${e.version} status=${e.status ?? "active"} kind=${e.kind ?? "?"}`)}${tags}`,
        )
      }
    }).pipe(Effect.provide(memoryLayer))
  }),
})

const GetCommand = effectCmd({
  command: "get <id>",
  describe: "get a memory entry by id",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("id", { type: "string", demandOption: true, describe: "memory entry id" }),
  handler: Effect.fn("Cli.memory.get")(function* (args: any) {
    const id = args.id
    if (!id) return yield* fail("missing id")
    return yield* Effect.gen(function* () {
      const repo = yield* Banyan.MemoryRepo
      const entry = yield* repo.get(id)
      if (!entry) {
        UI.println(UI.Style.TEXT_DANGER_BOLD + `no entry with id=${id}` + UI.Style.TEXT_NORMAL)
        return
      }
      UI.println(UI.Style.TEXT_HIGHLIGHT + `${entry.key} (${entry.id})` + UI.Style.TEXT_NORMAL)
      UI.println(dim(`version=v${entry.version} status=${entry.status ?? "active"} kind=${entry.kind ?? "?"}`))
      UI.println(JSON.stringify(entry.value, null, 2))
    }).pipe(Effect.provide(memoryLayer))
  }),
})

const SearchCommand = effectCmd({
  command: "search <query>",
  describe: "FTS5 / BM25-ranked search across key, title, body, kind",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "search query" })
      .option("limit", { type: "number", default: 10 })
      .option("scope", { type: "string" })
      .option("kind", { type: "string" })
      .option("status", { type: "string" }),
  handler: Effect.fn("Cli.memory.search")(function* (args: any) {
    const query = args.query
    if (!query) return yield* fail("missing query")
    return yield* Effect.gen(function* () {
      const repo = yield* Banyan.MemoryRepo
      const result = yield* repo.searchRanked({
        query,
        limit: args.limit,
        scope: args.scope,
        kind: args.kind,
        status: args.status,
      })
      UI.println(UI.Style.TEXT_HIGHLIGHT + `Search: ${query}` + UI.Style.TEXT_NORMAL)
      UI.println(dim(`hits=${result.totalHits}`))
      if (result.entries.length === 0) {
        UI.println(dim("  (none)"))
        return
      }
      for (const e of result.entries) {
        UI.println(
          `  ${UI.Style.TEXT_HIGHLIGHT}${e.key}${UI.Style.TEXT_NORMAL}  ${dim(`v${e.version} status=${e.status ?? "active"} kind=${e.kind ?? "?"}`)}`,
        )
        UI.println(`    ${dim((e.body ?? "").slice(0, 120))}`)
      }
    }).pipe(Effect.provide(memoryLayer))
  }),
})

const RecallCommand = effectCmd({
  command: "recall <key>",
  describe: "recall entries by exact key match",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("key", { type: "string", demandOption: true, describe: "key to recall" })
      .option("scope", { type: "string", default: "global" }),
  handler: Effect.fn("Cli.memory.recall")(function* (args: any) {
    const key = args.key
    if (!key) return yield* fail("missing key")
    return yield* Effect.gen(function* () {
      const repo = yield* Banyan.MemoryRepo
      const scope = (args.scope ?? "global") as "global" | "session"
      const matches = yield* repo.search(scope, undefined, key)
      if (matches.length === 0) {
        UI.println(dim(`no entry with key=${key}`))
        return
      }
      for (const e of matches.sort((a, b) => b.createdAt - a.createdAt)) {
        UI.println(
          `${UI.Style.TEXT_HIGHLIGHT}${e.key}${UI.Style.TEXT_NORMAL} ${dim(`v${e.version} id=${e.id}`)}`,
        )
        UI.println(JSON.stringify(e.value, null, 2))
      }
    }).pipe(Effect.provide(memoryLayer))
  }),
})

const StoreCommand = effectCmd({
  command: "store <key> <value>",
  describe: "store a new memory entry (or bump version of existing id with --id)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("key", { type: "string", demandOption: true })
      .positional("value", { type: "string", demandOption: true, describe: "value as JSON or string" })
      .option("scope", { type: "string", default: "global" })
      .option("id", { type: "string", describe: "explicit id (for idempotent re-stores)" })
      .option("agent", { type: "string", describe: "agent id" })
      .option("tags", { type: "string", describe: "comma-separated tag list" })
      .option("context", { type: "string" }),
  handler: Effect.fn("Cli.memory.store")(function* (args: any) {
    const key = args.key
    const valueRaw = args.value
    if (!key || valueRaw === undefined) return yield* fail("missing key or value")
    let parsed: unknown = valueRaw
    try {
      parsed = JSON.parse(valueRaw)
    } catch {
      parsed = valueRaw
    }
    const id = args.id ?? crypto.randomUUID()
    const scope = (args.scope ?? "global") as "global" | "session"
    return yield* Effect.gen(function* () {
      const repo = yield* Banyan.MemoryRepo
      yield* repo.put({
        id,
        key,
        value: parsed,
        context: args.context,
        tags: args.tags
          ? args.tags
              .split(",")
              .map((t: string) => t.trim())
              .filter((t: string) => t.length > 0)
          : [],
        scope,
        agentID: args.agent,
      })
      UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}stored${UI.Style.TEXT_NORMAL} id=${id} key=${key}`)
    }).pipe(Effect.provide(memoryLayer))
  }),
})

const ForgetCommand = effectCmd({
  command: "forget",
  describe: "forget memory entries by id or key",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("id", { type: "string", describe: "memory entry id" })
      .option("key", { type: "string", describe: "memory key" })
      .option("scope", { type: "string" })
      .check((argv) => {
        if (!argv.id && !argv.key) throw new Error("--id or --key is required")
        if (argv.key && !argv.scope) throw new Error("--scope is required when using --key")
        return true
      }),
  handler: Effect.fn("Cli.memory.forget")(function* (args: any) {
    return yield* Effect.gen(function* () {
      const repo = yield* Banyan.MemoryRepo
      if (args.id) {
        yield* repo.forget(args.id)
        UI.println(dim(`forgot id=${args.id}`))
        return
      }
      if (args.key && args.scope) {
        const removed = yield* repo.forgetByKey({ key: args.key, scope: args.scope })
        UI.println(dim(`forgot key=${args.key} count=${removed}`))
        return
      }
    }).pipe(Effect.provide(memoryLayer))
  }),
})

const CandidatesListCommand = effectCmd({
  command: "list",
  describe: "list candidate memory entries (default status=pending)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("status", {
        type: "string",
        default: "pending",
      })
      .option("scope", { type: "string" })
      .option("limit", { type: "number", default: 50 }),
  handler: Effect.fn("Cli.memory.candidates.list")(function* (args: any) {
    const status = (args.status ?? "pending") as "pending" | "active" | "superseded" | "rejected" | "expired"
    return yield* Effect.gen(function* () {
      const service = yield* Banyan.MemoryService
      const entries = yield* service.listCandidates({
        status,
        scope: args.scope,
        limit: args.limit,
      })
      UI.println(UI.Style.TEXT_HIGHLIGHT + `Candidates (${entries.length})` + UI.Style.TEXT_NORMAL)
      for (const e of entries) {
        UI.println(
          `  ${e.id}  ${UI.Style.TEXT_HIGHLIGHT}${e.key}${UI.Style.TEXT_NORMAL}  ${dim(`v${e.version}`)}`,
        )
        UI.println(`    ${dim((e.body ?? "").slice(0, 120))}`)
      }
    }).pipe(Effect.provide(memoryServiceLayer))
  }),
})

const CandidatesApproveCommand = effectCmd({
  command: "approve <id>",
  describe: "promote a pending candidate to active (supersedes matching actives)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("expected-version", { type: "number", demandOption: true }),
  handler: Effect.fn("Cli.memory.candidates.approve")(function* (args: any) {
    const id = args.id
    if (!id || args.expectedVersion === undefined) return yield* fail("missing id or --expected-version")
    return yield* Effect.gen(function* () {
      const service = yield* Banyan.MemoryService
      const result = yield* service.promote({ id, expectedVersion: args.expectedVersion }).pipe(
        Effect.catchTag("NotFoundError", (e: any) => Effect.fail(new CliError({ message: `not found: ${e.id}` }))),
        Effect.catchTag(
          "StaleWriteError",
          (e: any) =>
            Effect.fail(
              new CliError({
                message: `stale write: expected v${e.expectedVersion}, current v${e.currentVersion} for id=${e.id}`,
              }),
            ),
        ),
      )
      UI.println(
        `${UI.Style.TEXT_SUCCESS_BOLD}promoted${UI.Style.TEXT_NORMAL} id=${result.entry.id} superseded=${result.supersededIds.length}`,
      )
    }).pipe(Effect.provide(memoryServiceLayer))
  }),
})

const CandidatesRejectCommand = effectCmd({
  command: "reject <id>",
  describe: "reject a pending candidate",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("id", { type: "string", demandOption: true }).option("expected-version", {
      type: "number",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.memory.candidates.reject")(function* (args: any) {
    const id = args.id
    if (!id || args.expectedVersion === undefined) return yield* fail("missing id or --expected-version")
    return yield* Effect.gen(function* () {
      const service = yield* Banyan.MemoryService
      const updated = yield* service.reject({ id, expectedVersion: args.expectedVersion }).pipe(
        Effect.catchTag("NotFoundError", (e: any) => Effect.fail(new CliError({ message: `not found: ${e.id}` }))),
        Effect.catchTag(
          "StaleWriteError",
          (e: any) =>
            Effect.fail(
              new CliError({
                message: `stale write: expected v${e.expectedVersion}, current v${e.currentVersion} for id=${e.id}`,
              }),
            ),
        ),
      )
      UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}rejected${UI.Style.TEXT_NORMAL} id=${updated.id} v${updated.version}`)
    }).pipe(Effect.provide(memoryServiceLayer))
  }),
})

const CandidatesCommand = effectCmd({
  command: "candidates",
  describe: "manage memory candidates (pending → active/rejected)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(CandidatesListCommand)
      .command(CandidatesApproveCommand)
      .command(CandidatesRejectCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.memory.candidates")(function* () {}),
})

const VacuumCommand = effectCmd({
  command: "vacuum",
  describe: "delete expired memory entries",
  instance: false,
  builder: (yargs: Argv) => yargs,
  handler: Effect.fn("Cli.memory.vacuum")(function* () {
    return yield* Effect.gen(function* () {
      const repo = yield* Banyan.MemoryRepo
      const removed = yield* repo.vacuum()
      UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}vacuum complete${UI.Style.TEXT_NORMAL} removed=${removed}`)
    }).pipe(Effect.provide(memoryLayer))
  }),
})

export const MemoryCommand = effectCmd({
  command: "memory",
  describe: "banyancode memory subcommands (list/get/search/recall/store/forget/candidates/vacuum)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(SearchCommand)
      .command(RecallCommand)
      .command(StoreCommand)
      .command(ForgetCommand)
      .command(CandidatesCommand)
      .command(VacuumCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.memory")(function* () {}),
})
