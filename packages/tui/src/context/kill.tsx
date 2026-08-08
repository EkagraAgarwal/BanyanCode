/** @jsxImportSource @opentui/solid */
import { createSimpleContext } from "./helper"

export type Kill = () => void

export const { use: useKill, provider: KillProvider } = createSimpleContext({
  name: "Kill",
  init: (input: { kill?: Kill }) => input.kill ?? (() => {}),
})
