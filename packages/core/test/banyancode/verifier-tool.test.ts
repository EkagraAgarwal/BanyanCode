import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect, Schema } from "effect"
import type { ToolCall } from "@opencode-ai/llm"
import { Tool } from "../../src/tool/tool"
import { LintTool } from "../../src/tool/lint"
import { TestTool } from "../../src/tool/test"
import { TypecheckTool } from "../../src/tool/typecheck"
import type { Interface as PermissionV2Interface } from "../../src/permission"
import type { Interface as VerifierServiceInterface } from "../../src/banyancode/verifier-service"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

// Phase 6 boundary contract for the three verifier-backed tools. Execution is
// already covered end-to-end by `verifier-service.test.ts`, so nothing here
// shells out — this file pins the two layers of path-traversal defense:
//   1. the `FILE_PATH_PATTERN` + max-length checks on the input schema, and
//   2. the `ensureInsideProjectRoot` containment check inside `execute`.

const makeContext = (): Tool.Context => ({
  sessionID: randomUUID() as Tool.Context["sessionID"],
  agent: "build" as Tool.Context["agent"],
  assistantMessageID: randomUUID() as Tool.Context["assistantMessageID"],
  toolCallID: randomUUID(),
})

const makeCall = (name: string, input: unknown): ToolCall => ({
  type: "tool-call",
  id: randomUUID(),
  name,
  input,
})

// The containment check runs before `permission.assert` and before the verifier
// is invoked. Both collaborators die on contact so a regression that reorders
// the check surfaces as a hard defect instead of a silently passing test.
const unreachablePermission = {
  assert: () => Effect.die("permission.assert must not run for a path that escapes the project root"),
} as unknown as PermissionV2Interface

const unreachableVerifier: VerifierServiceInterface = {
  typecheck: () => Effect.die("verifier.typecheck must not run for a path that escapes the project root"),
  test: () => Effect.die("verifier.test must not run for a path that escapes the project root"),
  lint: () => Effect.die("verifier.lint must not run for a path that escapes the project root"),
  compile: () => Effect.die("verifier.compile must not run for a path that escapes the project root"),
}

const allowingPermission = { assert: () => Effect.void } as unknown as PermissionV2Interface

type Outcome = { readonly ok: boolean; readonly message: string }

// `traced` writes a start record under `<cwd>/.banyancode/trace` before the
// tool body runs, so every settle must happen with the cwd pointed at a
// throwaway directory or the suite litters the source tree.
const settle = async (
  build: (deps: {
    readonly permission: PermissionV2Interface
    readonly verifier: VerifierServiceInterface
  }) => Tool.AnyTool,
  deps: { readonly permission: PermissionV2Interface; readonly verifier: VerifierServiceInterface },
  name: string,
  input: (root: string) => unknown,
): Promise<Outcome> => {
  await using tmp = await tmpdir()
  const previousCwd = process.cwd()
  process.chdir(tmp.path)
  try {
    return await Effect.runPromise(
      Tool.settle(build(deps), makeCall(name, input(tmp.path)), makeContext()).pipe(
        Effect.match({
          onFailure: (failure) => ({ ok: false, message: failure.message }),
          onSuccess: () => ({ ok: true, message: "" }),
        }),
      ),
    )
  } finally {
    process.chdir(previousCwd)
  }
}

const settleTypecheck = (input: (root: string) => unknown, deps = { permission: unreachablePermission, verifier: unreachableVerifier }) =>
  settle(TypecheckTool.makeTypecheckTool, deps, TypecheckTool.name, input)

const settleTest = (input: (root: string) => unknown, deps = { permission: unreachablePermission, verifier: unreachableVerifier }) =>
  settle(TestTool.makeTestTool, deps, TestTool.name, input)

const settleLint = (input: (root: string) => unknown, deps = { permission: unreachablePermission, verifier: unreachableVerifier }) =>
  settle(LintTool.makeLintTool, deps, LintTool.name, input)

describe("verifier tool path schemas", () => {
  test("ordinary relative paths decode on all three tools", () => {
    const target = "packages/core/src/index.ts"
    expect(Schema.decodeUnknownSync(TypecheckTool.Input)({ path: target })).toEqual({ path: target })
    expect(Schema.decodeUnknownSync(TestTool.Input)({ path: target })).toEqual({ path: target })
    expect(Schema.decodeUnknownSync(LintTool.Input)({ path: target })).toEqual({ path: target })
  })

  test("backslash, whitespace, '$', '~' and drive-colon inputs are rejected", () => {
    const rejected = ["..\\..\\windows", "foo bar.ts", "a$b.ts", "~/secrets.ts", "C:\\Windows\\System32", "C:/Windows"]
    for (const value of rejected) {
      expect(() => Schema.decodeUnknownSync(TypecheckTool.Input)({ path: value })).toThrow()
      expect(() => Schema.decodeUnknownSync(TestTool.Input)({ path: value })).toThrow()
      expect(() => Schema.decodeUnknownSync(LintTool.Input)({ path: value })).toThrow()
    }
  })

  test("'..' segments pass the regex — containment at execute time is the only defense", () => {
    // `/^[a-zA-Z0-9._/-]+$/` (typecheck/lint) and
    // `/^[a-zA-Z0-9._*?-][a-zA-Z0-9._/*?-]*$/` (test) both admit '.' and '/',
    // so a dot-dot path is a *valid* decode. Asserting a schema-level rejection
    // here would be asserting something false; the escape is caught by
    // `ensureInsideProjectRoot` instead (see the execute tests below).
    const traversal = "../../etc/passwd"
    expect(Schema.decodeUnknownSync(TypecheckTool.Input)({ path: traversal })).toEqual({ path: traversal })
    expect(Schema.decodeUnknownSync(TestTool.Input)({ path: traversal })).toEqual({ path: traversal })
    expect(Schema.decodeUnknownSync(LintTool.Input)({ path: traversal })).toEqual({ path: traversal })
  })

  test("a leading '/' is rejected only by the test tool's stricter first-character class", () => {
    // The test pattern splits into a leading character class that omits '/'
    // and a tail class that includes it, so absolute POSIX paths never decode.
    // typecheck and lint share one flat class and do admit them.
    expect(() => Schema.decodeUnknownSync(TestTool.Input)({ path: "/etc/passwd" })).toThrow()
    expect(Schema.decodeUnknownSync(TypecheckTool.Input)({ path: "/etc/passwd" })).toEqual({ path: "/etc/passwd" })
    expect(Schema.decodeUnknownSync(LintTool.Input)({ path: "/etc/passwd" })).toEqual({ path: "/etc/passwd" })
  })

  test("the 512-character cap is enforced on path and projectRoot", () => {
    const atLimit = "a".repeat(512)
    const overLimit = "a".repeat(513)
    expect(Schema.decodeUnknownSync(TypecheckTool.Input)({ path: atLimit })).toEqual({ path: atLimit })
    expect(() => Schema.decodeUnknownSync(TypecheckTool.Input)({ path: overLimit })).toThrow()
    expect(() => Schema.decodeUnknownSync(TestTool.Input)({ path: overLimit })).toThrow()
    expect(() => Schema.decodeUnknownSync(LintTool.Input)({ path: overLimit })).toThrow()
    expect(() => Schema.decodeUnknownSync(TypecheckTool.Input)({ projectRoot: overLimit })).toThrow()
  })

  test("path is required and non-empty on the test tool, optional on typecheck and lint", () => {
    expect(() => Schema.decodeUnknownSync(TestTool.Input)({})).toThrow()
    expect(() => Schema.decodeUnknownSync(TestTool.Input)({ path: "" })).toThrow()
    expect(Schema.decodeUnknownSync(TypecheckTool.Input)({})).toEqual({})
    expect(Schema.decodeUnknownSync(LintTool.Input)({})).toEqual({})
  })
})

describe("verifier tool project-root containment", () => {
  test("banyan_typecheck rejects a dot-dot path that survived the regex", async () => {
    const outcome = await settleTypecheck((root) => ({ path: "../../etc/passwd", projectRoot: root }))
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("resolves outside projectRoot")
  })

  test("banyan_typecheck rejects an absolute path that the regex admits", async () => {
    const outcome = await settleTypecheck((root) => ({ path: "/etc/passwd", projectRoot: root }))
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("resolves outside projectRoot")
  })

  test("banyan_test rejects a dot-dot path", async () => {
    const outcome = await settleTest((root) => ({ path: "../escape.test.ts", projectRoot: root }))
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("resolves outside projectRoot")
  })

  test("banyan_lint rejects a path that only escapes after normalisation", async () => {
    // `src/a/../../../b.ts` looks contained until `path.resolve` collapses it.
    const outcome = await settleLint((root) => ({ path: "src/a/../../../b.ts", projectRoot: root }))
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("resolves outside projectRoot")
  })

  test("a contained path clears the gate and reaches the verifier", async () => {
    // Guards the other direction: the containment check must not over-block
    // legitimate relative paths. The verifier is a recorder rather than a real
    // run so the assertion stays on the boundary, not on `bun test` behaviour.
    const seen: string[] = []
    const recordingVerifier: VerifierServiceInterface = {
      ...unreachableVerifier,
      typecheck: (input) =>
        Effect.sync(() => {
          seen.push(input.path ?? "")
          return {
            kind: "typecheck" as const,
            target: input.path ?? input.projectRoot,
            status: "passed" as const,
            summary: { passed: 0, failed: 0, skipped: 0, errored: 0 },
            durationMs: 1,
            cacheHit: false,
            rawOutput: undefined,
            command: "bunx tsc --noEmit",
          }
        }),
    }
    const outcome = await settleTypecheck(() => ({ path: "src/index.ts" }), {
      permission: allowingPermission,
      verifier: recordingVerifier,
    })
    expect(outcome.ok).toBe(true)
    expect(seen).toEqual(["src/index.ts"])
  })

  test("an omitted path defaults to the whole project and is never rejected", async () => {
    const recordingVerifier: VerifierServiceInterface = {
      ...unreachableVerifier,
      lint: (input) =>
        Effect.succeed({
          kind: "lint" as const,
          target: input.projectRoot,
          status: "passed" as const,
          summary: { passed: 0, failed: 0, skipped: 0, errored: 0 },
          durationMs: 1,
          cacheHit: false,
          rawOutput: undefined,
          command: "bun run lint",
        }),
    }
    const outcome = await settleLint((root) => ({ projectRoot: root }), {
      permission: allowingPermission,
      verifier: recordingVerifier,
    })
    expect(outcome.ok).toBe(true)
  })

  test("projectRoot itself is resolved before containment is evaluated", async () => {
    // A relative projectRoot resolves against the process cwd, which `settle`
    // has pointed at the tmpdir — so a sibling escape is still caught.
    const outcome = await settleTypecheck(() => ({ path: "../outside.ts", projectRoot: path.join(".", "nested") }))
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("resolves outside projectRoot")
  })
})
