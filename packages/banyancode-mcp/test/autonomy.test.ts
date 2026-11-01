import { describe, expect, test } from "bun:test"
import { BUILTIN_PROFILES, autoDecision, decide, resolveProfile, wildcardMatch } from "../src/autonomy"
import type { AutonomyConfig } from "../src/config"
import { DEFAULT_AUTO_ANSWER_AFTER_SECONDS } from "../src/config"

const config = (overrides: Partial<AutonomyConfig> = {}): AutonomyConfig => ({
  default: "supervised",
  auto_answer_after_seconds: DEFAULT_AUTO_ANSWER_AFTER_SECONDS,
  profiles: {},
  ...overrides,
})

const ask = (action: string, resource = "*") => ({ action, resources: [resource] })

describe("wildcardMatch", () => {
  test("matches the host's glob semantics", () => {
    expect(wildcardMatch("edit", "*")).toBe(true)
    expect(wildcardMatch("src/app.ts", "src/**")).toBe(true)
    expect(wildcardMatch("src/nested/app.ts", "src/**")).toBe(true)
    expect(wildcardMatch("other/app.ts", "src/**")).toBe(false)
    expect(wildcardMatch("a.ts", "?.ts")).toBe(true)
    expect(wildcardMatch("ab.ts", "?.ts")).toBe(false)
    // Windows-style separators normalize to "/".
    expect(wildcardMatch("src\\app.ts", "src/*.ts")).toBe(true)
  })
})

describe("decide", () => {
  test("observe denies writes and shell, allows reads", () => {
    expect(decide(BUILTIN_PROFILES["observe"]!, "/root", ask("read", "/root/a.ts"))).toBe("allow")
    expect(decide(BUILTIN_PROFILES["observe"]!, "/root", ask("edit", "src/a.ts"))).toBe("deny")
    expect(decide(BUILTIN_PROFILES["observe"]!, "/root", ask("shell", "*"))).toBe("deny")
  })

  test("supervised allows reads but asks for edits", () => {
    expect(decide(BUILTIN_PROFILES["supervised"]!, "/root", ask("read", "a.ts"))).toBe("allow")
    expect(decide(BUILTIN_PROFILES["supervised"]!, "/root", ask("edit", "a.ts"))).toBe("ask")
  })

  test("trusted allows edits and shell, denies outside-directory access", () => {
    expect(decide(BUILTIN_PROFILES["trusted"]!, "/root", ask("edit", "a.ts"))).toBe("allow")
    expect(decide(BUILTIN_PROFILES["trusted"]!, "/root", ask("shell", "*"))).toBe("allow")
    expect(decide(BUILTIN_PROFILES["trusted"]!, "/root", ask("external_directory", "/elsewhere"))).toBe("deny")
  })

  test("later rules win, mirroring Permission.evaluate's findLast", () => {
    const profile = {
      rules: [
        { action: "*", resource: "*", effect: "allow" as const },
        { action: "edit", resource: "**/secret/**", effect: "deny" as const },
      ],
    }
    expect(decide(profile, "/root", ask("edit", "src/a.ts"))).toBe("allow")
    expect(decide(profile, "/root", ask("edit", "src/secret/key.ts"))).toBe("deny")
  })

  test("{root} substitutes the project root", () => {
    const profile = {
      rules: [{ action: "edit", resource: "{root}/src/**", effect: "allow" as const }],
    }
    expect(decide(profile, "C:\\work", ask("edit", "C:/work/src/a.ts"))).toBe("allow")
    expect(decide(profile, "C:\\work", ask("edit", "D:/other/a.ts"))).toBe("ask")
  })
})

describe("resolveProfile", () => {
  test("user profiles override builtins with the same name", () => {
    const custom = { rules: [{ action: "*", resource: "*", effect: "deny" as const }] }
    const resolved = resolveProfile(config({ profiles: { supervised: custom } }), "supervised")
    expect(resolved.builtin).toBe(false)
    expect(resolved.profile).toBe(custom)
  })

  test("unknown profile names fall back to supervised", () => {
    const resolved = resolveProfile(config(), "nope")
    expect(resolved.name).toBe("supervised")
  })

  test("config default selects the profile", () => {
    expect(resolveProfile(config({ default: "trusted" })).name).toBe("trusted")
  })
})

describe("autoDecision", () => {
  test("ask never auto-resolves", () => {
    expect(autoDecision({ decision: "ask", askedAt: 0, now: 1_000_000, afterSeconds: 0 })).toBeUndefined()
  })

  test("zero delay applies immediately", () => {
    expect(autoDecision({ decision: "allow", askedAt: 0, now: 0, afterSeconds: 0 })).toBe("allow")
  })

  test("waits for the configured delay before answering", () => {
    expect(autoDecision({ decision: "deny", askedAt: 0, now: 100_000, afterSeconds: 120 })).toBeUndefined()
    expect(autoDecision({ decision: "deny", askedAt: 0, now: 120_000, afterSeconds: 120 })).toBe("deny")
  })
})
