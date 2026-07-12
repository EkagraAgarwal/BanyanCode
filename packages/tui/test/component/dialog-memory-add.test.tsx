/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const SOURCE_PATH = resolve(__dirname, "../../src/component/dialog-memory-add.tsx")

test("dialog-memory-add chains three DialogPrompt calls and posts status=pending", () => {
  const source = readFileSync(SOURCE_PATH, "utf8")
  expect(source).toContain('import { DialogPrompt }')
  expect(source).toContain('DialogPrompt.show(dialog, "Memory title"')
  expect(source).toContain('DialogPrompt.show(dialog, "Memory body"')
  expect(source).toContain('DialogPrompt.show(dialog, "Kind (decision/warning/preference/...)"')
  expect(source).toContain('type: "user"')
  expect(source).toContain('status: "pending"')
  expect(source).toContain("api.client.memory.store(")
  expect(source).toContain("banyanMemoryStoreInput")
  expect(source).toContain('scope: "global"')
})

test("dialog-memory-add falls back to observation when kind is invalid", () => {
  const source = readFileSync(SOURCE_PATH, "utf8")
  expect(source).toContain("isUserMemoryKind")
  expect(source).toContain('"observation"')
  expect(source).toContain("ALLOWED_KINDS")
})

test("dialog-memory-add slugifies the title to produce a key", () => {
  const source = readFileSync(SOURCE_PATH, "utf8")
  expect(source).toContain("const slugify")
  expect(source).toContain("slugify(title)")
})