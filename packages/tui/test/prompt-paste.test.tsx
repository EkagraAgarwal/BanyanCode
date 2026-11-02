import { TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"

test("the prompt keeps pasted control characters and drops escape sequences", async () => {
  // Other app tests can leave a home draft in the process-wide stash.
  takeDraft(undefined)
  await using setup = await createAppFixture()
  await setup.ready
  // Home moved its prompt hints to the footer row above 120 columns; focus is the durable readiness signal.
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  await setup.mockInput.typeText("x")
  await setup.waitForFrame((frame) => frame.includes("x"))
  await setup.mockInput.pasteBracketedText("a\fb\u001b[31mc\u0000d")
  await setup.waitForFrame((frame) => frame.includes("xa^Lbc^@d"))
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("xa\fbc\0d")
})
