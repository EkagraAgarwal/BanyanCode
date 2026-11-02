/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { SPROUT_FRAMES, Sprout, sproutFrame } from "../src/components/status/sprout"
import { mount } from "./harness"

test("sprout advances one frame per 12th of a second and wraps", () => {
  expect(SPROUT_FRAMES).toHaveLength(14)
  expect(SPROUT_FRAMES.join("")).toBe("⢀⣀⣄⣤⣦⣶⣷⣿⣾⣶⣦⣤⣄⣀")
  expect(sproutFrame(0)).toBe("⢀")
  expect(sproutFrame(1 / 12)).toBe("⣀")
  expect(sproutFrame(13 / 12)).toBe("⣀")
  expect(sproutFrame(14 / 12)).toBe("⢀")
  // The offset keeps neighbouring spinners out of step.
  expect(sproutFrame(0, 3)).toBe(SPROUT_FRAMES[3]!)
})

test("sprout renders the shared frame, or the static fallback when animations are off", async () => {
  const color = RGBA.fromInts(120, 200, 140)
  const animated = await mount(() => <Sprout tick={1 / 12} color={color} />, { width: 4, height: 1 })
  const still = await mount(() => <Sprout tick={0} color={color} animations={false} />, { width: 4, height: 1 })
  try {
    expect(animated.captureCharFrame()).toContain("⣀")
    expect(still.captureCharFrame()).toContain("⋯")
    expect(still.captureCharFrame()).not.toContain("⢀")
  } finally {
    animated.renderer.destroy()
    still.renderer.destroy()
  }
})
