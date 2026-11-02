import { expect, test } from "bun:test"
import { DialogStatus } from "../../src/component/dialog-status"
import { directory, json, worktree } from "../fixture/tui-client"
import { model, renderLocal, session } from "../fixture/local"

const location = { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } }

test("status dialog lists providers, the session summary and MCP servers", async () => {
  await using setup = await renderLocal({
    sessions: [session("ses_one")],
    models: [model("first")],
    fetch: (url) => {
      if (url.pathname !== "/api/provider") return undefined
      return json({
        location,
        data: [{ id: "provider", name: "Anthropic", activation: "enabled", package: "test" }],
      })
    },
  })
  await setup.data.session.sync("ses_one")
  setup.dialog.replace(() => <DialogStatus />)
  await setup.waitForFrame(
    (frame) => frame.includes("Status") && frame.includes("Anthropic") && frame.includes("session"),
  )
  const frame = setup.captureCharFrame()
  expect(frame).toContain("1 provider")
  expect(frame).toContain("Anthropic")
  expect(frame).toContain("1 model")
  expect(frame).toContain("1 session")
  expect(frame).toContain("No MCP servers")
})
