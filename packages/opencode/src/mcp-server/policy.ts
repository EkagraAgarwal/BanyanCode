// §4.2 permission policy enforced with session rulesets at creation time.
//
// The ruleset returned by buildRuleset is passed as `permission` to
// `session.create` (see Session.create in src/session/session.ts) or merged
// after the agent's own rules via appendRuleset. Later rules win: V1
// Permission.evaluate uses findLast over the flattened rulesets (see
// src/permission/index.ts), so MCP rows must always be LAST.
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../permission"

export const PermissionPolicies = ["reject", "edits", "yolo"] as const
export type PermissionPolicy = (typeof PermissionPolicies)[number]

export type PermissionRuleset = PermissionV1.Ruleset

const rejectRows = (): PermissionV1.Rule[] => [
  { permission: "plan_enter", pattern: "*", action: "deny" },
  { permission: "plan_exit", pattern: "*", action: "deny" },
  { permission: "question", pattern: "*", action: "ask" },
]

const scopePattern = (root: string): string => `${root.replace(/[/\\]+$/, "")}/**`

// Edit-capable permission names. The edit/write/patch tools all ask as
// "edit" (see tool/edit.ts, tool/write.ts, tool/apply_patch.ts); the
// write/patch rows are spec §4.2 ballast for agent configs that key rules
// on tool IDs.
const EDIT_PERMISSIONS = ["edit", "write", "patch"] as const

// Production tool asks carry worktree-relative paths
// (path.relative(worktree, file) in edit.ts/write.ts): inside asks look
// like "sub/file.txt", outside escapes like "../other/file.txt". The
// absolute <root>/** rows cover absolute ask patterns (spec §4.2 shape);
// the relative rows cover the production shape. Order matters: later rows
// win (findLast), so the broad "*" allow sits before the escape denies,
// the absolute denies scope absolute patterns to the root, and the scoped
// re-allow closes the set. Net under `edits`: inside allowed, outside
// denied — even when the agent config is permissive.
const editsRows = (root: string): PermissionV1.Rule[] => {
  const scoped = scopePattern(root)
  return [
    ...EDIT_PERMISSIONS.map((permission): PermissionV1.Rule => ({ permission, pattern: scoped, action: "allow" })),
    ...EDIT_PERMISSIONS.map((permission): PermissionV1.Rule => ({ permission, pattern: "*", action: "allow" })),
    ...EDIT_PERMISSIONS.map((permission): PermissionV1.Rule => ({ permission, pattern: "../*", action: "deny" })),
    // Absolute paths outside the root (posix and drive-letter). Production
    // edit asks are never absolute, so these only fire for absolute ask
    // patterns or permissive agent configs: containment holds either way.
    ...EDIT_PERMISSIONS.map((permission): PermissionV1.Rule => ({ permission, pattern: "/*", action: "deny" })),
    ...EDIT_PERMISSIONS.map((permission): PermissionV1.Rule => ({ permission, pattern: "?:/*", action: "deny" })),
    ...EDIT_PERMISSIONS.map((permission): PermissionV1.Rule => ({ permission, pattern: scoped, action: "allow" })),
  ]
}

export function buildRuleset(policy: PermissionPolicy, root: string): PermissionV1.Ruleset {
  if (policy === "yolo") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "ask" },
    ]
  }
  const base = rejectRows()
  if (policy === "reject") return base
  return [...base, ...editsRows(root)]
}

export function appendRuleset(
  baseRuleset: PermissionV1.Ruleset,
  mcpRuleset: readonly PermissionV1.Rule[],
): PermissionV1.Ruleset {
  return Permission.merge(baseRuleset, mcpRuleset)
}

export const yoloGate = { requiresAllowYolo: true, flag: "--allow-yolo" } as const
export type YoloGate = typeof yoloGate

export class YoloNotAllowedError extends Error {
  readonly code = "MCP_YOLO_NOT_ALLOWED" as const
}

export function assertYoloAllowed(allowYolo: boolean, policy: PermissionPolicy): void {
  if (policy === "yolo" && !allowYolo) {
    throw new YoloNotAllowedError(
      'permission "yolo" requires the server flag --allow-yolo; retry with "edits" or "reject"',
    )
  }
}

export * as McpPolicy from "./policy"
