import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Banyan } from "@opencode-ai/core/banyancode"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
  ),
)

describe("session.system", () => {
  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )
})

// WS3 golden tests (prompt-caching plan PR2): the assembly seam must emit
// the stable blocks first and the volatile tail (date, graph-state) after
// them when the flag is on, and must preserve the legacy interleaved order
// byte-for-byte when it is off.
describe("session.system assemble — stable/dynamic split", () => {
  const env = [
    [
      "You are powered by the model named test-model. The exact model ID is test/test-model",
      "Here is some useful information about the environment you are running in:",
      "<env>",
      "  Working directory: /repo",
      "  Today's date: Wed Sep 23 2026",
      "</env>",
    ].join("\n"),
    ["Project references provide additional directories...", "<available_references>", "</available_references>"].join(
      "\n",
    ),
  ]
  const instructions = ["Instructions from: /repo/AGENTS.md\n# project rules"]
  const codegraph = {
    stable: "## Repository intelligence is the canonical interface (ALWAYS)\n## BanyanCode tool guide",
    dynamic: "Graph state: ready (1,204 symbols) — use code_find/repository_* now.",
  }
  const banyan = "## BanyanCode orchestration (ALWAYS)"
  const skills = "Skills provide specialized instructions and workflows for specific tasks."

  test("flag on: stable blocks first; date and graph-state after the stable block", () => {
    const out = SystemPrompt.assemble({ stablePrefix: true, env, instructions, codegraph, banyan, skills })

    expect(out).toEqual([
      instructions[0],
      codegraph.stable,
      banyan,
      env[0],
      env[1],
      skills,
      codegraph.dynamic,
    ])

    const joined = out.join("\n")
    const lastStable = Math.max(
      joined.indexOf(instructions[0]),
      joined.indexOf(codegraph.stable),
      joined.indexOf(banyan),
    )
    expect(joined.indexOf("Today's date")).toBeGreaterThan(lastStable)
    expect(joined.indexOf("Graph state:")).toBeGreaterThan(lastStable)
  })

  test("flag on: two same-day requests differ only in the dynamic tail", () => {
    const first = SystemPrompt.assemble({ stablePrefix: true, env, instructions, codegraph, banyan, skills })
    const flipped = SystemPrompt.assemble({
      stablePrefix: true,
      env,
      instructions,
      codegraph: { stable: codegraph.stable, dynamic: "Graph state: building in background" },
      banyan,
      skills,
    })
    // Stable prefix (instructions + policy/guide + orchestration) is
    // byte-identical; only the dynamic tail differs.
    expect(first.slice(0, 3)).toEqual(flipped.slice(0, 3))
    expect(first).not.toEqual(flipped)
    expect(first.at(-1)).toContain("Graph state: ready")
    expect(flipped.at(-1)).toContain("Graph state: building")
  })

  test("flag off: legacy interleaved order with codegraph rejoined", () => {
    const out = SystemPrompt.assemble({ stablePrefix: false, env, instructions, codegraph, banyan, skills })

    expect(out).toEqual([
      env[0],
      env[1],
      instructions[0],
      [codegraph.stable, codegraph.dynamic].join("\n\n"),
      banyan,
      skills,
    ])
  })

  test("flag off: disabled codegraph (parts undefined) leaves no slot", () => {
    const out = SystemPrompt.assemble({ stablePrefix: false, env, instructions, banyan, skills })
    expect(out).toEqual([env[0], env[1], instructions[0], banyan, skills])
  })

  test("flag on: disabled codegraph and missing optional blocks", () => {
    const out = SystemPrompt.assemble({ stablePrefix: true, env, instructions })
    expect(out).toEqual([instructions[0], env[0], env[1]])
  })
})

describe("session.system codegraphParts", () => {
  it.effect("returns stable policy without a dynamic line when source/bootstrap are absent", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const original = process.env.BANYANCODE_ENABLE
      delete process.env.BANYANCODE_ENABLE
      try {
        const parts = yield* prompt.codegraphParts()
        expect(parts).toBeDefined()
        expect(parts?.stable).toContain("Repository intelligence is the canonical interface")
        expect(parts?.stable).toBe(Banyan.CodegraphSystemSourceNS.POLICY_TEXT)
        expect(parts?.dynamic).toBeUndefined()

        // Back-compat join: codegraph() equals the parts rejoined.
        const full = yield* prompt.codegraph()
        expect(full).toBe(parts?.stable)
      } finally {
        if (original === undefined) delete process.env.BANYANCODE_ENABLE
        else process.env.BANYANCODE_ENABLE = original
      }
    }),
  )

  it.effect("returns undefined when BanyanCode is disabled", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const original = process.env.BANYANCODE_ENABLE
      process.env.BANYANCODE_ENABLE = "0"
      try {
        expect(yield* prompt.codegraphParts()).toBeUndefined()
        expect(yield* prompt.codegraph()).toBeUndefined()
      } finally {
        if (original === undefined) delete process.env.BANYANCODE_ENABLE
        else process.env.BANYANCODE_ENABLE = original
      }
    }),
  )
})
