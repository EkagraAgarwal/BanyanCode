import type { Context } from "@opencode/plugin/tui/context"
import type { CodegraphLive } from "../../data/live"
import { CodegraphProgress } from "../status/codegraph-progress"

/**
 * The home screen's codegraph progress. Tips were removed with the redesign:
 * the home surface is the hero, the prompt and the resume list, and nothing
 * else competes with them for a row.
 */
export function HomeStrip(props: { readonly context: Context; readonly codegraph: CodegraphLive }) {
  return <CodegraphProgress context={props.context} codegraph={props.codegraph} overlay />
}
