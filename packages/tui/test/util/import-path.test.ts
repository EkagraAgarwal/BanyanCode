import { expect, test } from "bun:test"
import { normalizeImportPath } from "../../src/util/import-path"

test("normalizes absolute Windows import paths", () => {
  expect(normalizeImportPath('  "C:\\Users\\me\\session.md"  ', "win32")).toBe("C:\\Users\\me\\session.md")
})

test("normalizes quoted paths and file URLs", () => {
  expect(normalizeImportPath("'relative/session.md'", "win32")).toBe("relative/session.md")
  expect(normalizeImportPath("file:///D:/OpenCode/session.md", "win32")).toBe("D:\\OpenCode\\session.md")
})

test("accepts filename-only paths", () => {
  expect(normalizeImportPath("session.md", "win32")).toBe("session.md")
})
