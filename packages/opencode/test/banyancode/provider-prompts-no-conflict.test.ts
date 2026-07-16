/**
 * Regression guard against the grep/glob-preference conflict that was
 * introduced in some provider prompts (commit 469b55b18).
 *
 * Locks in three invariants:
 *
 *   (a) NONE of the 8 provider prompt files contains the literal string
 *       "prefer using Glob and Grep tools" — this was the active conflict
 *       that the previous commit removed.
 *   (b) `gpt.txt`, `codex.txt`, `gemini.txt` each contain the pointer phrase
 *       "BanyanCode tool guide" so the model is steered at the source module's
 *       policy + per-session tool catalog.
 *   (c) `anthropic.txt`, `beast.txt`, `default.txt`, `kimi.txt`, `trinity.txt`
 *       MUST NOT mention `codegraph` or `code_find` — those prompts carry
 *       model personality / provider-specific guidance, NOT tool preferences.
 *       Tool preference lives in the V2 `CodegraphSystemSource` module so it
 *       is uniform across providers.
 */

import { describe, expect, test } from "bun:test"
import PROMPT_ANTHROPIC from "../../src/session/prompt/anthropic.txt"
import PROMPT_BEAST from "../../src/session/prompt/beast.txt"
import PROMPT_CODEX from "../../src/session/prompt/codex.txt"
import PROMPT_DEFAULT from "../../src/session/prompt/default.txt"
import PROMPT_GEMINI from "../../src/session/prompt/gemini.txt"
import PROMPT_GPT from "../../src/session/prompt/gpt.txt"
import PROMPT_KIMI from "../../src/session/prompt/kimi.txt"
import PROMPT_TRINITY from "../../src/session/prompt/trinity.txt"

const PROMPTS: ReadonlyArray<readonly [string, string]> = [
  ["anthropic", PROMPT_ANTHROPIC],
  ["beast", PROMPT_BEAST],
  ["codex", PROMPT_CODEX],
  ["default", PROMPT_DEFAULT],
  ["gemini", PROMPT_GEMINI],
  ["gpt", PROMPT_GPT],
  ["kimi", PROMPT_KIMI],
  ["trinity", PROMPT_TRINITY],
]

const POINTER_BEARERS = new Set(["gpt", "codex", "gemini"])

const NON_TOOL_PROMPTS = new Set(["anthropic", "beast", "default", "kimi", "trinity"])

const FORBIDDEN_PHRASE = "prefer using Glob and Grep tools"

describe("provider prompt — no grep/glob preference conflict", () => {
  for (const [name, text] of PROMPTS) {
    test(`${name}.txt does not contain "${FORBIDDEN_PHRASE}"`, () => {
      expect(text).not.toContain(FORBIDDEN_PHRASE)
    })
  }
})

describe("provider prompt — pointer phrase on pointer-bearing providers", () => {
  for (const [name, text] of PROMPTS) {
    if (!POINTER_BEARERS.has(name)) continue
    test(`${name}.txt contains the "BanyanCode tool guide" pointer`, () => {
      expect(text).toContain("BanyanCode tool guide")
    })
  }
})

describe("provider prompt — non-tool prompts do not mention BanyanCode tools", () => {
  for (const [name, text] of PROMPTS) {
    if (!NON_TOOL_PROMPTS.has(name)) continue
    test(`${name}.txt does not mention codegraph or code_find`, () => {
      expect(text).not.toContain("codegraph")
      expect(text).not.toContain("code_find")
    })
  }
})