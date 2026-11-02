/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import type { FileDiffInfo } from "@opencode/client"
import { ModifiedFilesPanel, changeCountWidth, truncateLeft } from "../src/components/sidebar/files"
import { context, mount, session } from "./harness"

const FILES: readonly FileDiffInfo[] = [
  { file: "src/math.ts", patch: "", additions: 12, deletions: 3, status: "modified" },
  {
    file: "packages/core/src/banyancode/codegraph/codegraph-indexer.ts",
    patch: "",
    additions: 4,
    deletions: 0,
    status: "modified",
  },
  { file: "docs/guide.md", patch: "", additions: 0, deletions: 7, status: "modified" },
]

function withDiff(files: readonly FileDiffInfo[], routes: string[] = []) {
  const base = context({ sessions: [session({ id: "ses_files", title: "files" })] })
  const stub = {
    ...base,
    client: {
      session: {
        diff: async (input: { readonly sessionID: string }) => {
          routes.push(input.sessionID)
          return files
        },
      },
    },
  } as unknown as Context
  return stub
}

async function render(input: Context) {
  const app = await mount(() => <ModifiedFilesPanel context={input} sessionID="ses_files" />, {
    width: 40,
    height: 12,
  })
  await Bun.sleep(0)
  await app.renderOnce()
  return app
}

test("modified files panel lists the session diff with add/delete counts", async () => {
  const routes: string[] = []
  const app = await render(withDiff(FILES, routes))
  try {
    const frame = app.captureCharFrame()
    expect(routes).toEqual(["ses_files"])
    expect(frame).toContain("Modified Files")
    expect(frame).toContain("src/math.ts")
    expect(frame).toContain("+12")
    expect(frame).toContain("-3")
    expect(frame).toContain("-7")
    expect(frame).toContain("▼")
  } finally {
    app.renderer.destroy()
  }
})

test("modified files panel collapses from its header and keeps mouse use", async () => {
  const app = await render(withDiff(FILES))
  try {
    expect(app.captureCharFrame()).toContain("docs/guide.md")
    const header = app.renderer.root.findDescendantById("banyancode.files.header")!
    await app.mockMouse.click(header.x, header.y)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Modified Files")
    expect(frame).not.toContain("docs/guide.md")
  } finally {
    app.renderer.destroy()
  }
})

test("modified files panel hides itself without changes", async () => {
  const app = await render(withDiff([]))
  try {
    expect(app.captureCharFrame().trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("long paths truncate from the left so the filename stays readable", () => {
  expect(truncateLeft("src/a.ts", 20)).toBe("src/a.ts")
  expect(truncateLeft("packages/core/src/index.ts", 12)).toBe("…rc/index.ts")
  expect(changeCountWidth({ additions: 10, deletions: 2 })).toBe(6)
  expect(changeCountWidth({ additions: 0, deletions: 0 })).toBe(0)
})
