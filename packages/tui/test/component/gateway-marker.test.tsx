/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { For } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { GatewayMark } from "../../src/routes/session"
import { emptyThemeSource } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

/**
 * Every marker route, rendered the way a session row renders it. The text is
 * the observable state, so the assertions hold without colour.
 */

const cases: ReadonlyArray<{ readonly label: string; readonly metadata: Record<string, unknown> }> = [
  { label: 'Grep "AuthManager"', metadata: { gateway: { route: "swapped", from: "grep", to: "code_find" } } },
  {
    label: "Read app.ts",
    metadata: { gateway: { route: "swapped", from: "read", to: "repo", op: "outline", bytesSaved: 3_277 } },
  },
  { label: 'Glob "**/*.ts"', metadata: { gateway: { route: "swapped", from: "glob", to: "repo", op: "files" } } },
  { label: 'Grep "foo"', metadata: { gateway: { route: "fallback", from: "grep", reason: "graph-empty" } } },
  { label: "Read app.ts", metadata: { gateway: { route: "augmented", from: "read", reason: "symbol-header" } } },
  { label: 'Grep "raw"', metadata: { gateway: { route: "direct", from: "grep", reason: "repeat" } } },
]

async function render(width: number, height = cases.length) {
  return testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <box flexDirection="column" width={width}>
            <For each={cases}>
              {(item) => (
                <box flexDirection="row" gap={1}>
                  <text>{item.label}</text>
                  <GatewayMark metadata={item.metadata} />
                </box>
              )}
            </For>
          </box>
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width, height },
  )
}

test("each gateway route renders its marker", async () => {
  await using app = await render(60)
  await app.renderOnce()
  const frame = app.captureCharFrame()

  expect(frame).toContain("⇢ code_find")
  expect(frame).toContain("⇢ repo (3.2 KB saved)")
  expect(frame).toContain("↩ graph empty")
  expect(frame).toContain("+symbols")
  // The direct row carries no marker at all.
  const rawRow = frame.split("\n").find((line) => line.includes('Grep "raw"')) ?? ""
  expect(rawRow).not.toContain("⇢")
  expect(rawRow).not.toContain("↩")
  expect(rawRow).not.toContain("+symbols")
})

test("the marker fits a narrow width", async () => {
  await using app = await render(24, 30)
  await app.renderOnce()
  const frame = app.captureCharFrame()
  // Width comes from the terminal: the marker wraps rather than clipping the row.
  expect(frame).toContain("⇢")
  expect(frame).toContain("code_find")
  expect(frame).toContain("↩")
})
