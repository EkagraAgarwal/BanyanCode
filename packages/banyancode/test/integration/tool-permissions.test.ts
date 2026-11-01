import { describe, expect, test } from "bun:test"
import type { Permission } from "@opencode/schema/permission"
import { definitions } from "../../src/agents/definitions.js"
import { TOOL_IDS as CODEGRAPH_TOOL_IDS } from "../../src/codegraph/index.js"
import { INTEL_TOOL_NAMES } from "../../src/intel/index.js"
import { SHARED_MEMORY_TOOL } from "../../src/mesh/shared-memory.js"
import { MESH_TOOL_NAMES } from "../../src/mesh/tools.js"
import { NAME_COMPILE, NAME_LINT, NAME_TEST, NAME_TYPECHECK } from "../../src/verify/index.js"

/**
 * Guards the v1 lesson that a `"*": deny` base silently locks out tools added
 * later: every BanyanCode tool id a workstream registers must be explicitly
 * reachable (last matching rule = allow) by the agents that are expected to
 * use it. Adding a tool without a permission row fails here.
 */

/** Same matcher as `packages/core/src/util/wildcard.ts` (package cannot import core). */
const wildcard = (input: string, pattern: string) => {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(normalized)
}

/** v2 resolves a rule with `findLast` (`packages/core/src/permission.ts`). */
const reachable = (rules: Permission.Ruleset, action: string, resource = "*") =>
  rules.findLast((rule) => wildcard(action, rule.action) && wildcard(resource, rule.resource))?.effect === "allow"

const registeredToolIds = [
  ...new Set<string>([
    ...CODEGRAPH_TOOL_IDS,
    ...Object.values(INTEL_TOOL_NAMES),
    NAME_COMPILE,
    NAME_LINT,
    NAME_TEST,
    NAME_TYPECHECK,
    ...MESH_TOOL_NAMES,
    SHARED_MEMORY_TOOL,
    "banyan_status",
  ]),
].sort()

const agent = (id: string) => {
  const spec = definitions(5).find((candidate) => candidate.id === id)
  expect(spec, `agent ${id} is not defined`).toBeDefined()
  return spec!
}

describe("registered Banyan tools are reachable", () => {
  test("the registered id set matches the workstreams", () => {
    expect(registeredToolIds).toContain("codegraph_build")
    expect(registeredToolIds).toContain("codegraph_search")
    expect(registeredToolIds).toContain("repository_query")
    expect(registeredToolIds).toContain("banyan_typecheck")
    expect(registeredToolIds).toContain("subagent_message")
    expect(registeredToolIds).toContain("shared_memory")
  })

  for (const id of ["build", "orchestrator", "coder"] as const) {
    test(`${id} can call every registered Banyan tool`, () => {
      const spec = agent(id)
      const unreachable = registeredToolIds.filter((tool) => !reachable(spec.permissions, tool))
      expect(unreachable).toEqual([])
    })
  }

  for (const id of ["explore", "scout", "reviewer", "researcher"] as const) {
    test(`${id} explicitly allows every registered Banyan tool`, () => {
      const spec = agent(id)
      const unreachable = registeredToolIds.filter((tool) => !reachable(spec.permissions, tool))
      expect(unreachable).toEqual([])
    })
  }
})
