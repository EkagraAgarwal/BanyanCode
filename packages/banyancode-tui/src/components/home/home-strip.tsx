import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { CodegraphLive } from "../../data/live"
import { CodegraphProgress } from "../status/codegraph-progress"
import { palette } from "../../theme"

export const HOME_STRIP_MIN_WIDTH = 60

/** The v1 tip, while it is still something the user can act on. */
export const CODEGRAPH_TIP = "Codegraph: Type /codegraph-build to index your code. Swarm: /swarm toggles fan-out waves."

export const HOME_TIPS: readonly string[] = [
  "Swarm: /swarm toggles fan-out waves. Subagents: /max-subagents sets the 1-20 concurrent limit.",
  "YOLO: /yolo auto-approves tool calls. Toggle it off before risky edits.",
  "Agents: /agent-model sets a model per agent; /thinking sets its reasoning variant.",
]

/** v1 home: a tip under the prompt, and the floating progress box while a build runs. */
export function HomeStrip(props: { readonly context: Context; readonly codegraph: CodegraphLive }) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const visible = createMemo(() => dimensions().width >= HOME_STRIP_MIN_WIDTH && dimensions().height >= 16)
  // Chosen once per mount, so the tip doesn't change under the user.
  const other = HOME_TIPS[Math.floor(Math.random() * HOME_TIPS.length)] ?? HOME_TIPS[0]!
  const tip = createMemo(() => {
    const unbuilt = props.codegraph.readiness()?.reason === "missing"
    return unbuilt && props.codegraph.build()?.status !== "running" ? CODEGRAPH_TIP : other
  })

  return (
    <>
      <Show when={visible()}>
        <box width="100%" maxWidth={75} paddingTop={1} flexShrink={0}>
          <text fg={theme().muted}>{tip()}</text>
        </box>
      </Show>
      <CodegraphProgress context={props.context} codegraph={props.codegraph} overlay />
    </>
  )
}
