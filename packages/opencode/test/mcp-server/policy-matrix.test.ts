// §4.2 policy matrix: {reject, edits, yolo} × agents (incl. "*": "deny")
// × actions, resolved through the real Permission.merge + Permission.evaluate.
import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"
import {
  appendRuleset,
  assertYoloAllowed,
  buildRuleset,
  yoloGate,
  YoloNotAllowedError,
  type PermissionPolicy,
  type PermissionRuleset,
} from "../../src/mcp-server/policy"

const ROOT = "/repo"
const INSIDE = "/repo/src/a.ts"
const OUTSIDE = "/other/b.ts"

const exploreLike = (): PermissionRuleset =>
  Permission.merge(
    Permission.fromConfig({ "*": "allow" }),
    Permission.fromConfig({
      "*": "deny",
      bash: "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
    }),
  )

const buildLike = (): PermissionRuleset =>
  Permission.merge(
    Permission.fromConfig({
      "*": "allow",
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
    }),
  )

const resolve = (merged: PermissionRuleset, permission: string, pattern: string): PermissionV1.Action =>
  Permission.evaluate(permission, pattern, merged).action

const resolved = (policy: PermissionPolicy, base: PermissionRuleset, permission: string, pattern: string) =>
  resolve(appendRuleset(base, buildRuleset(policy, ROOT)), permission, pattern)

describe("policy matrix", () => {
  test("reject leaves config defaults but denies plan transitions and asks questions", () => {
    expect(resolved("reject", buildLike(), "plan_enter", "*")).toBe("deny")
    expect(resolved("reject", buildLike(), "plan_exit", "*")).toBe("deny")
    expect(resolved("reject", buildLike(), "question", "*")).toBe("ask")
    expect(resolved("reject", buildLike(), "edit", INSIDE)).toBe("allow")
    expect(resolved("reject", buildLike(), "bash", "*")).toBe("allow")
  })

  test("reject over a deny-by-default agent denies edits and bash", () => {
    expect(resolved("reject", exploreLike(), "edit", INSIDE)).toBe("deny")
    expect(resolved("reject", exploreLike(), "write", INSIDE)).toBe("deny")
    expect(resolved("reject", exploreLike(), "patch", INSIDE)).toBe("deny")
    expect(resolved("reject", exploreLike(), "bash", "*")).toBe("deny")
    expect(resolved("reject", exploreLike(), "question", "*")).toBe("ask")
    expect(resolved("reject", exploreLike(), "plan_enter", "*")).toBe("deny")
  })

  test("edits allows edit/write/patch only under root", () => {
    for (const action of ["edit", "write", "patch"]) {
      expect(resolved("edits", exploreLike(), action, INSIDE)).toBe("allow")
      expect(resolved("edits", exploreLike(), action, OUTSIDE)).toBe("deny")
    }
    expect(resolved("edits", exploreLike(), "question", "*")).toBe("ask")
    expect(resolved("edits", exploreLike(), "plan_enter", "*")).toBe("deny")
    expect(resolved("edits", exploreLike(), "plan_exit", "*")).toBe("deny")
    expect(resolved("edits", exploreLike(), "bash", "*")).toBe("deny")
  })

  test("edits over a permissive agent keeps bash allowed from config, but edits stay scoped to root", () => {
    expect(resolved("edits", buildLike(), "bash", "*")).toBe("allow")
    // Safe-writes containment (C1): an edits session can never write
    // outside its root, even when the agent config would allow it.
    // Production edit asks are worktree-relative (see edit.ts), so the
    // absolute-outside case is synthetic — the live shape is "../..." and
    // is pinned in policy-matrix-e2e.test.ts.
    expect(resolved("edits", buildLike(), "edit", OUTSIDE)).toBe("deny")
  })

  test("yolo allows everything except question, even over deny-by-default", () => {
    for (const [action, pattern] of [
      ["edit", INSIDE],
      ["write", OUTSIDE],
      ["patch", OUTSIDE],
      ["bash", "*"],
      ["plan_enter", "*"],
      ["plan_exit", "*"],
    ] as Array<[string, string]>) {
      expect(resolved("yolo", exploreLike(), action, pattern)).toBe("allow")
    }
    expect(resolved("yolo", exploreLike(), "question", "*")).toBe("ask")
  })

  test("policy rows appended last win via findLast", () => {
    const merged = appendRuleset(buildLike(), buildRuleset("yolo", ROOT))
    expect(merged.slice(-2)).toEqual([...buildRuleset("yolo", ROOT)])
    expect(resolve(merged, "bash", "*")).toBe("allow")
    expect(resolve(merged, "question", "*")).toBe("ask")
  })

  test("yolo gate requires --allow-yolo", () => {
    expect(yoloGate.requiresAllowYolo).toBe(true)
    expect(() => assertYoloAllowed(false, "yolo")).toThrow(YoloNotAllowedError)
    expect(() => assertYoloAllowed(true, "yolo")).not.toThrow()
    expect(() => assertYoloAllowed(false, "reject")).not.toThrow()
    expect(() => assertYoloAllowed(false, "edits")).not.toThrow()
  })
})
