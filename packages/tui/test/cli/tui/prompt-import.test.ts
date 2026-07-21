import { expect, test } from "bun:test"

test("handles import before session creation and navigates on success", async () => {
  const source = await Bun.file(new URL("../../../src/component/prompt/index.tsx", import.meta.url)).text()
  const importIndex = source.indexOf('if (firstWord === "/import")')
  const createIndex = source.indexOf("const res = await sdk.client.session.create")

  expect(importIndex).toBeGreaterThanOrEqual(0)
  expect(createIndex).toBeGreaterThan(importIndex)
  expect(source).toContain('route.navigate({ type: "session", sessionID: data.sessionID })')
  expect(source).toContain('DialogPrompt.show(dialog, "Path to transcript"')
  expect(source).not.toContain('else if (command === "/import")')
})
