// Autonomy profiles decide what a delegated task may do when nobody is
// watching. They serve two purposes:
//
// 1. Session permissions at create time (`profileRules`), so allows/denies that
//    the profile settles never surface as an ask at all.
// 2. A fallback decision for asks that still arrive (most often from a child
//    session that did not inherit the parent's ruleset). The engine applies the
//    profile's explicit allow/deny after `auto_answer_after_seconds`.
//
// Matching mirrors the host: `*` matches any run of characters and the last
// matching rule wins (`Permission.evaluate` uses `findLast`).

import type { AutonomyConfig, AutonomyProfile, AutonomyRule } from "./config"

export type AutonomyEffect = "allow" | "deny" | "ask"

export type ProfileRule = { action: string; resource: string; effect: AutonomyEffect }

// `{root}` in a profile resource is replaced with the project root, so a
// config can scope writes without hardcoding absolute paths.
export const ROOT_PLACEHOLDER = "{root}"

export const BUILTIN_PROFILES: Record<string, AutonomyProfile> = {
  observe: {
    description: "Read-only: analysis and review work that must not touch the checkout.",
    rules: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
      { action: "lsp", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ],
  },
  supervised: {
    description: "Default: reads allowed, edits and shell commands wait for a human or the caller.",
    rules: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
      { action: "lsp", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ],
  },
  trusted: {
    description: "Unattended edits inside the project; outside-directory access still denied.",
    rules: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
      { action: "lsp", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ],
  },
  yolo: {
    description: "Allow everything. Only reachable with the --allow-yolo process gate.",
    rules: [{ action: "*", resource: "*", effect: "allow" }],
  },
}

export const BUILTIN_PROFILE_NAMES = Object.keys(BUILTIN_PROFILES)

// Same algorithm as packages/core/src/util/wildcard.ts: `*` matches anything,
// `?` matches one character, case-insensitive on Windows.
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  const flags = process.platform === "win32" ? "si" : "s"
  return new RegExp("^" + escaped + "$", flags).test(normalized)
}

export type ResolvedProfile = {
  name: string
  profile: AutonomyProfile
  builtin: boolean
}

// User profiles win over builtins with the same name, which is how a project
// tightens (or loosens) `supervised` without renaming it.
export function resolveProfile(config: AutonomyConfig, name?: string): ResolvedProfile {
  const requested = name ?? config.default ?? "supervised"
  const user = config.profiles[requested]
  if (user !== undefined) return { name: requested, profile: user, builtin: false }
  const builtin = BUILTIN_PROFILES[requested]
  if (builtin !== undefined) return { name: requested, profile: builtin, builtin: true }
  const fallback = BUILTIN_PROFILES["supervised"]!
  return { name: "supervised", profile: fallback, builtin: true }
}

export function listProfiles(config: AutonomyConfig): ResolvedProfile[] {
  const names = new Set([...BUILTIN_PROFILE_NAMES, ...Object.keys(config.profiles)])
  return [...names].map((name) => resolveProfile(config, name))
}

const substituteRoot = (resource: string, root: string): string =>
  resource.includes(ROOT_PLACEHOLDER) ? resource.replaceAll(ROOT_PLACEHOLDER, root.replace(/[/\\]+$/, "")) : resource

// Last matching rule wins, exactly like the host's `Permission.evaluate`.
export function decide(
  profile: AutonomyProfile,
  root: string,
  ask: { action: string; resources: readonly string[] },
): AutonomyEffect {
  const rules = profile.rules
  let effect: AutonomyEffect = "ask"
  for (const resource of ask.resources) {
    for (const rule of rules) {
      if (!wildcardMatch(ask.action, rule.action)) continue
      if (!wildcardMatch(resource, substituteRoot(rule.resource, root))) continue
      effect = rule.effect
    }
  }
  return effect
}

export function profileRules(profile: AutonomyProfile, root: string): ProfileRule[] {
  return profile.rules.map((rule: AutonomyRule) => ({
    action: rule.action,
    resource: substituteRoot(rule.resource, root),
    effect: rule.effect,
  }))
}

// When a profile reaches a decision without a human, the engine answers the
// ask itself. `ask` stays pending.
export function autoDecision(input: {
  decision: AutonomyEffect
  askedAt: number
  now: number
  afterSeconds: number
}): "allow" | "deny" | undefined {
  if (input.decision === "ask") return undefined
  if (input.afterSeconds <= 0) return input.decision
  if (input.now - input.askedAt < input.afterSeconds * 1000) return undefined
  return input.decision
}

export class YoloNotAllowedError extends Error {
  readonly code = "MCP_YOLO_NOT_ALLOWED" as const
}

export function assertYoloAllowed(allowYolo: boolean, permission: "reject" | "edits" | "yolo"): void {
  if (permission === "yolo" && !allowYolo) {
    throw new YoloNotAllowedError(
      'permission "yolo" requires the --allow-yolo server flag; retry with "edits" or omit the override',
    )
  }
}

// Map the server-wide permission policy onto a baseline profile when the task
// start does not name one. Stored config can express "reject" (no autonomy
// beyond reads) and "edits" (trusted inside the project); only an explicit
// --allow-yolo reaches yolo.
export function defaultProfileForPermission(permission: "reject" | "edits" | "yolo"): string {
  if (permission === "yolo") return "yolo"
  if (permission === "edits") return "trusted"
  return "supervised"
}

export * as Autonomy from "./autonomy"
