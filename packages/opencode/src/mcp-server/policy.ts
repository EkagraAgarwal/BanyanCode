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

export function buildRuleset(policy: PermissionPolicy, root: string): PermissionV1.Ruleset {
  if (policy === "yolo") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "ask" },
    ]
  }
  const base = rejectRows()
  if (policy === "reject") return base
  const pattern = scopePattern(root)
  return [
    ...base,
    { permission: "edit", pattern, action: "allow" },
    { permission: "write", pattern, action: "allow" },
    { permission: "patch", pattern, action: "allow" },
  ]
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
