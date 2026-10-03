// C1 permission matrix e2e (gap-plan §C1, design §permissions + gap-plan §4.2):
// reject/edits/yolo × edit-inside/edit-outside/bash/network.
//
// Part 1 is pure (Permission.evaluate over buildRuleset) using PRODUCTION
// ask shapes: edit/write asks carry worktree-relative paths
// (path.relative(worktree, file) in tool/edit.ts + tool/write.ts), so
// inside asks look like "sub/file.txt" and outside escapes like
// "../other/file.txt". Absolute shapes (the §4.2 table spelling) are
// pinned too.
//
// Part 2 boots the REAL in-process server per policy (createMcpServer,
// real SSE event stream, real sessions, scripted TestLLMServer provider)
// and drives one real tool call per task, asserting the same matrix end
// to end. Network under yolo is pinned pure-only: an allowed webfetch
// would touch the live network.
//
// Base config for the live boots denies everything via a "**" pattern
// (not "*"), so tools stay advertised to the model (see
// Permission.disabled: only pattern === "*" hides) while every ask
// without an MCP allow row denies.

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect, Layer } from "effect"
import { Permission } from "../../src/permission"
import {
  appendRuleset,
  assertYoloAllowed,
  buildRuleset,
  YoloNotAllowedError,
  type PermissionPolicy,
  type PermissionRuleset,
} from "../../src/mcp-server/policy"
import {
  createMcpServer,
  readAllowYoloEnv,
  resolveMcpPermission,
} from "../../src/mcp-server/server"
import type { TaskEngine } from "../../src/mcp-server/task-engine"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const savedCwd = process.cwd()
const savedPassword = process.env.OPENCODE_SERVER_PASSWORD
const savedAllowYoloEnv = process.env.BANYANCODE_MCP_ALLOW_YOLO

afterEach(async () => {
  process.chdir(savedCwd)
  if (savedPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = savedPassword
  if (savedAllowYoloEnv === undefined) delete process.env.BANYANCODE_MCP_ALLOW_YOLO
  else process.env.BANYANCODE_MCP_ALLOW_YOLO = savedAllowYoloEnv
  await disposeAllInstances()
  await resetDatabase()
})

const ROOT = "/repo"
const REL_INSIDE = "src/a.ts"
const REL_TOP = "top.ts"
const REL_NESTED = "a/b/c.ts"
const REL_OUTSIDE = "../outside/b.ts"
const ABS_INSIDE = "/repo/src/a.ts"
const ABS_OUTSIDE = "/other/b.ts"
const WIN_OUTSIDE = "D:/outside/b.ts"

// Deny-by-default base that keeps tools advertised (pattern "**", never
// the literal "*", so Permission.disabled does not hide anything).
const denyBase = (): PermissionRuleset =>
  Permission.merge(Permission.fromConfig({ "*": { "**": "deny" } }))

const allowBase = (): PermissionRuleset => Permission.merge(Permission.fromConfig({ "*": "allow" }))

const decide = (policy: PermissionPolicy, base: PermissionRuleset, permission: string, pattern: string) =>
  Permission.evaluate(permission, pattern, appendRuleset(base, buildRuleset(policy, ROOT))).action

describe("C1 policy matrix, production ask shapes (pure)", () => {
  test("edits allows relative inside edits, denies relative escapes", () => {
    for (const action of ["edit", "write", "patch"]) {
      expect(decide("edits", denyBase(), action, REL_INSIDE)).toBe("allow")
      expect(decide("edits", denyBase(), action, REL_TOP)).toBe("allow")
      expect(decide("edits", denyBase(), action, REL_NESTED)).toBe("allow")
      expect(decide("edits", denyBase(), action, REL_OUTSIDE)).toBe("deny")
    }
  })

  test("edits denies absolute outside (containment, even over a permissive base)", () => {
    for (const action of ["edit", "write", "patch"]) {
      expect(decide("edits", denyBase(), action, ABS_INSIDE)).toBe("allow")
      expect(decide("edits", denyBase(), action, ABS_OUTSIDE)).toBe("deny")
      expect(decide("edits", allowBase(), action, ABS_OUTSIDE)).toBe("deny")
      expect(decide("edits", denyBase(), action, WIN_OUTSIDE)).toBe("deny")
    }
  })

  test("edits leaves bash and network to config (ask/rejected per design, never allowed by the rows)", () => {
    for (const permission of ["bash", "webfetch", "websearch", "external_directory"]) {
      expect(decide("edits", denyBase(), permission, "*")).toBe("deny")
      expect(decide("edits", allowBase(), permission, "*")).toBe("allow")
      expect(decide("edits", denyBase(), permission, "https://example.com/x")).toBe("deny")
    }
  })

  test("reject follows config for everything except plan transitions and questions", () => {
    expect(decide("reject", denyBase(), "edit", REL_INSIDE)).toBe("deny")
    expect(decide("reject", denyBase(), "edit", REL_OUTSIDE)).toBe("deny")
    expect(decide("reject", denyBase(), "bash", "*")).toBe("deny")
    expect(decide("reject", denyBase(), "webfetch", "https://example.com/x")).toBe("deny")
    expect(decide("reject", denyBase(), "question", "*")).toBe("ask")
    expect(decide("reject", denyBase(), "plan_enter", "*")).toBe("deny")
    expect(decide("reject", denyBase(), "plan_exit", "*")).toBe("deny")
  })

  test("yolo allows everything except question, even over deny-by-default", () => {
    for (const [permission, pattern] of [
      ["edit", REL_INSIDE],
      ["edit", REL_OUTSIDE],
      ["write", ABS_OUTSIDE],
      ["patch", WIN_OUTSIDE],
      ["bash", "echo hi"],
      ["webfetch", "https://example.com/x"],
      ["websearch", "query"],
      ["external_directory", "/other/*"],
      ["plan_enter", "*"],
    ] as Array<[string, string]>) {
      expect(decide("yolo", denyBase(), permission, pattern)).toBe("allow")
    }
    expect(decide("yolo", denyBase(), "question", "*")).toBe("ask")
  })

  test("MCP rows are appended last, so they win via findLast", () => {
    const merged = appendRuleset(denyBase(), buildRuleset("edits", ROOT))
    expect(merged.slice(-1)[0]).toEqual({
      permission: "patch",
      pattern: `${ROOT}/**`,
      action: "allow",
    })
    expect(Permission.evaluate("edit", REL_INSIDE, merged).action).toBe("allow")
    expect(Permission.evaluate("edit", REL_OUTSIDE, merged).action).toBe("deny")
  })
})

describe("C1 yolo gate selection (pure)", () => {
  test("stored config can never express yolo; the flag selects it", () => {
    expect(resolveMcpPermission({ allowYolo: false })).toBe("reject")
    expect(resolveMcpPermission({ stored: "edits", allowYolo: false })).toBe("edits")
    expect(resolveMcpPermission({ stored: "yolo", allowYolo: false })).toBe("reject")
    expect(resolveMcpPermission({ stored: undefined, allowYolo: true })).toBe("yolo")
    expect(resolveMcpPermission({ override: "edits", allowYolo: true })).toBe("edits")
    expect(resolveMcpPermission({ override: "yolo", allowYolo: true })).toBe("yolo")
  })

  test("explicit override wins over the flag-implied default", () => {
    expect(resolveMcpPermission({ override: "reject", allowYolo: true })).toBe("reject")
  })

  test("assertYoloAllowed is the hard gate", () => {
    expect(() => assertYoloAllowed(false, "yolo")).toThrow(YoloNotAllowedError)
    expect(() => assertYoloAllowed(true, "yolo")).not.toThrow()
    expect(() => assertYoloAllowed(false, "reject")).not.toThrow()
    expect(() => assertYoloAllowed(false, "edits")).not.toThrow()
  })

  test("readAllowYoloEnv honors BANYANCODE_MCP_ALLOW_YOLO", () => {
    expect(readAllowYoloEnv({})).toBe(false)
    expect(readAllowYoloEnv({ BANYANCODE_MCP_ALLOW_YOLO: "1" })).toBe(true)
    expect(readAllowYoloEnv({ BANYANCODE_MCP_ALLOW_YOLO: "true" })).toBe(true)
    expect(readAllowYoloEnv({ BANYANCODE_MCP_ALLOW_YOLO: "0" })).toBe(false)
  })
})

// Structural script surface used below (avoids coupling the helper to the
// service class generics).
type LlmScript = {
  readonly reset: Effect.Effect<void>
  readonly tool: (name: string, input: unknown) => Effect.Effect<void>
  readonly text: (value: string) => Effect.Effect<void>
}

type Sdk = ReturnType<typeof createOpencodeClient>

function findToolPart(rows: unknown, tool: string): { state?: { status?: unknown } } | undefined {
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    const parts = (row as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const candidate = part as { type?: unknown; tool?: unknown }
      if (candidate.type === "tool" && candidate.tool === tool) {
        return part as { state?: { status?: unknown } }
      }
    }
  }
  return undefined
}

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))

// One scripted tool call + one follow-up text per task. The queue is reset
// before every task (leftover scripted replies never leak into the next
// task); unscripted follow-up calls fall back to the server auto-"ok".
const runToolTask = (input: {
  engine: TaskEngine
  llm: LlmScript
  sdk: Sdk
  dir: string
  policy: PermissionPolicy
  prompt: string
  toolName: string
  toolArgs: Record<string, unknown>
}) =>
  Effect.gen(function* () {
    yield* input.llm.reset
    yield* input.llm.tool(input.toolName, input.toolArgs)
    yield* input.llm.text("done")
    const started = yield* Effect.promise(() =>
      input.engine.start({
        prompt: input.prompt,
        agent: "build",
        model: "test/test-model",
        permission: input.policy,
        permissionRuleset: buildRuleset(input.policy, input.dir).map((row) => ({
          permission: row.permission,
          pattern: row.pattern,
          action: row.action,
        })),
        mcpClient: "policy-matrix-e2e",
      }),
    )
    const done = yield* Effect.promise(() =>
      input.engine.waitForStateChange(started.handle, { fromStatus: "running", timeoutMs: 120_000 }),
    )
    expect(done.status).toBe("done")
    expect(done.permission).toBe(input.policy)
    const raw = yield* Effect.promise(() =>
      input.sdk.session.messages({ sessionID: started.sessionID, directory: input.dir }),
    )
    const rows = "data" in raw && Array.isArray(raw.data) ? raw.data : []
    const part = findToolPart(rows, input.toolName)
    expect(part !== undefined).toBe(true)
    return part!
  })

const DENY_ALL: NonNullable<ConfigV1.Info["permission"]> = { "*": { "**": "deny" } }

const denyConfig = (llmUrl: string) => ({
  ...testProviderConfig(llmUrl),
  permission: DENY_ALL,
})

describe("C1 matrix over the real in-process server", () => {
  it.live(
    "yolo without the flag refuses to boot; with the flag it resolves yolo",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const failure = yield* Effect.promise(() =>
          createMcpServer({ cwd: dir, permission: "yolo" }).then(
            () => "booted",
            (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
          ),
        )
        expect(failure).toContain("--allow-yolo")

        const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir, permission: "yolo", allowYolo: true }))
        try {
          expect(boot.config.permission).toBe("yolo")
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    120_000,
  )

  it.live(
    "reject: inside edit and bash are both denied",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({ git: true, config: denyConfig(llm.url) })
        const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir }))
        const engine = boot.engine
        expect(engine).toBeDefined()
        expect(boot.config.permission).toBe("reject")
        try {
          const target = path.join(dir, "sub", "rejected.txt")
          const edit = yield* runToolTask({
            engine: engine!,
            llm,
            sdk: boot.sdk,
            dir,
            policy: "reject",
            prompt: "write a file",
            toolName: "write",
            toolArgs: { filePath: target, content: "nope" },
          })
          expect(edit.state?.status).toBe("error")
          expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)

          const bash = yield* runToolTask({
            engine: engine!,
            llm,
            sdk: boot.sdk,
            dir,
            policy: "reject",
            prompt: "run a shell command",
            toolName: "bash",
            toolArgs: { command: "echo hello", description: "say hi" },
          })
          expect(bash.state?.status).toBe("error")
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    180_000,
  )

  it.live(
    "edits: inside edit allowed; outside edit, bash and network denied",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({ git: true, config: denyConfig(llm.url) })
        const outsideDir = yield* tmpdirScoped()
        // Explicit override wins over the flag-implied default: allowYolo
        // is set, yet the server still resolves edits.
        const boot = yield* Effect.promise(() =>
          createMcpServer({ cwd: dir, permission: "edits", allowYolo: true }),
        )
        const engine = boot.engine
        expect(engine).toBeDefined()
        expect(boot.config.permission).toBe("edits")
        try {
          const inside = path.join(dir, "sub", "allowed.txt")
          const good = yield* runToolTask({
            engine: engine!,
            llm,
            sdk: boot.sdk,
            dir,
            policy: "edits",
            prompt: "write a file inside the project",
            toolName: "write",
            toolArgs: { filePath: inside, content: "inside" },
          })
          expect(good.state?.status).not.toBe("error")
          expect(yield* Effect.promise(() => Bun.file(inside).text())).toContain("inside")

          const outside = path.join(outsideDir, "escaped.txt")
          const bad = yield* runToolTask({
            engine: engine!,
            llm,
            sdk: boot.sdk,
            dir,
            policy: "edits",
            prompt: "write a file outside the project",
            toolName: "write",
            toolArgs: { filePath: outside, content: "escaped" },
          })
          expect(bad.state?.status).toBe("error")
          expect(yield* Effect.promise(() => Bun.file(outside).exists())).toBe(false)

          const bash = yield* runToolTask({
            engine: engine!,
            llm,
            sdk: boot.sdk,
            dir,
            policy: "edits",
            prompt: "run a shell command",
            toolName: "bash",
            toolArgs: { command: "echo hello", description: "say hi" },
          })
          expect(bash.state?.status).toBe("error")

          const net = yield* runToolTask({
            engine: engine!,
            llm,
            sdk: boot.sdk,
            dir,
            policy: "edits",
            prompt: "fetch a URL",
            toolName: "webfetch",
            toolArgs: { url: "https://example.com/", format: "markdown" },
          })
          expect(net.state?.status).toBe("error")
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    180_000,
  )

  it.live(
    "yolo via the flag alone: outside edit and bash are allowed",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({ git: true, config: denyConfig(llm.url) })
        const outsideDir = yield* tmpdirScoped()
        // No explicit permission: --allow-yolo (the only path to yolo —
        // config cannot express it) both permits and selects it.
        const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir, allowYolo: true }))
        const engine = boot.engine
        expect(engine).toBeDefined()
        expect(boot.config.permission).toBe("yolo")
        try {
          const outside = path.join(outsideDir, "yolo.txt")
          const written = yield* runToolTask({
            engine: engine!,
            llm,
            sdk: boot.sdk,
            dir,
            policy: "yolo",
            prompt: "write a file outside the project",
            toolName: "write",
            toolArgs: { filePath: outside, content: "yolo" },
          })
          expect(written.state?.status).not.toBe("error")
          expect(yield* Effect.promise(() => Bun.file(outside).text())).toContain("yolo")

          const bash = yield* runToolTask({
            engine: engine!,
            llm,
            sdk: boot.sdk,
            dir,
            policy: "yolo",
            prompt: "run a shell command",
            toolName: "bash",
            toolArgs: { command: "echo hello", description: "say hi" },
          })
          expect(bash.state?.status).not.toBe("error")
          expect(JSON.stringify(bash)).toContain("hello")
        } finally {
          yield* Effect.promise(() => boot.cleanup())
        }
      }),
    180_000,
  )

  it.live(
    "BANYANCODE_MCP_ALLOW_YOLO=1 selects yolo for direct API use",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        process.env.BANYANCODE_MCP_ALLOW_YOLO = "1"
        try {
          const boot = yield* Effect.promise(() => createMcpServer({ cwd: dir }))
          try {
            expect(boot.config.permission).toBe("yolo")
          } finally {
            yield* Effect.promise(() => boot.cleanup())
          }
        } finally {
          delete process.env.BANYANCODE_MCP_ALLOW_YOLO
        }
      }),
    120_000,
  )
})
