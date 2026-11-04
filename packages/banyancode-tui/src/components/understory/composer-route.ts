import type {
  ComposerInterceptResult,
  ComposerRoute,
  ComposerSuggestion,
  Context,
} from "@opencode/plugin/tui/context"
import type { MeshLive } from "../../data/live"
import { stateGlyph, type RosterRow } from "../../data/understory"

/**
 * Composer routing for the Agents tab.
 *
 * The tab owns a roster of session branches, so the composer on that tab gains
 * one rule: `@coder-1 fix this` steers only that branch, and everything else is
 * ordinary text for the root agent. Chat keeps the plain composer; these hooks
 * are registered only while the tab is mounted and removed with it.
 */

/** The `@label` a message names, and the text after it. */
export interface ComposerMention {
  readonly label: string
  readonly instruction: string
}

/**
 * Splits a leading `@label` off the message. The label is the roster's display
 * name (`coder-1`), never a file path: `@src/foo.ts` is a mention, not a route.
 */
export function parseComposerMention(text: string): ComposerMention | undefined {
  const match = /^@([\w-]+)(?=\s|$)/.exec(text.trim())
  if (match === null) return undefined
  const label = match[1]!
  return { label, instruction: text.trim().slice(match[0].length).trim() }
}

/** A finished, failed or killed branch refuses the message and says why. */
export function refusalOf(row: RosterRow): { readonly reason: string; readonly tone: "warning" | "error" } | undefined {
  if (row.state === "done") return { reason: "finished", tone: "warning" }
  if (row.state === "failed") return { reason: "failed", tone: "error" }
  if (row.state === "killed") return { reason: "killed", tone: "error" }
  return undefined
}

/** Where a message goes: the root agent, one branch, or a branch that refuses it. */
export type ComposerDestination =
  | { readonly kind: "root"; readonly text: string }
  | { readonly kind: "steer"; readonly row: RosterRow; readonly instruction: string }
  | { readonly kind: "refused"; readonly row: RosterRow; readonly reason: string; readonly tone: "warning" | "error" }
  | { readonly kind: "empty"; readonly row: RosterRow }

/**
 * Resolves one message against the roster. An unknown label is ordinary text:
 * file mentions (`@src/foo.ts`) and words that happen to start with `@` reach
 * the root agent with the text intact.
 */
export function composerDestination(text: string, rows: readonly RosterRow[]): ComposerDestination {
  const mention = parseComposerMention(text)
  if (mention === undefined) return { kind: "root", text }
  const row = rows.find((item) => item.depth > 0 && item.label === mention.label)
  // A label that names the root (or nothing) is not a branch: send as written.
  if (row === undefined) return { kind: "root", text }
  const refusal = refusalOf(row)
  if (refusal !== undefined) return { kind: "refused", row, ...refusal }
  if (mention.instruction === "") return { kind: "empty", row }
  return { kind: "steer", row, instruction: mention.instruction }
}

/**
 * The composer's route label: where the current text will go. Replaying wins,
 * because nothing can be sent until the tab returns to live.
 */
export function composerRouteLabel(
  text: string,
  rows: readonly RosterRow[],
  live: boolean,
): ComposerRoute | undefined {
  if (!live) return { text: "replaying: back to live first", tone: "warning" }
  const root = rows.find((row) => row.depth === 0)
  const home = root === undefined ? "the root agent" : root.label
  const destination = composerDestination(text, rows)
  if (destination.kind === "steer") return { text: `→ ${destination.row.label}`, tone: "info" }
  if (destination.kind === "refused") {
    return { text: `→ ${destination.row.label} · ${destination.reason}`, tone: destination.tone }
  }
  if (destination.kind === "empty") return { text: `→ ${destination.row.label} · needs an instruction`, tone: "warning" }
  return { text: `→ ${home}`, tone: "info" }
}

/** The composer placeholder, named for the real root agent. */
export function composerPlaceholder(rows: readonly RosterRow[]): string {
  const root = rows.find((row) => row.depth === 0)
  return `Message ${root?.label ?? "the root agent"}, or @ to steer one branch`
}

/**
 * Rows for the `@` picker: branches only, in roster order, with the same state
 * glyph the roster draws. `glyph` lets the caller animate a running agent; the
 * default is the roster's own static glyph set.
 */
export function composerSuggestions(
  rows: readonly RosterRow[],
  query: string,
  options: { readonly glyph?: (row: RosterRow, index: number) => string; readonly limit?: number } = {},
): ComposerSuggestion[] {
  const needle = query.toLowerCase()
  const limit = options.limit ?? 8
  const found: ComposerSuggestion[] = []
  rows.forEach((row, index) => {
    if (row.depth === 0 || found.length >= limit) return
    if (!row.label.toLowerCase().startsWith(needle) && !row.agent.toLowerCase().startsWith(needle)) return
    found.push({
      display: `${options.glyph?.(row, index) ?? stateGlyph(row.state, "◐")} ${row.label}`,
      insert: `@${row.label}`,
      kind: "agent",
      description: row.state,
    })
  })
  return found
}

export interface ComposerSendInput {
  readonly text: string
  readonly rows: readonly RosterRow[]
  readonly root: string
  readonly mesh: Pick<MeshLive, "steer">
  readonly live: boolean
  readonly tell: (message: string, variant?: "info" | "success" | "warning" | "error") => void
}

/**
 * Sends one composer message. Returns undefined when the host should send it
 * the way it always does (plain text for the root agent); a result claims the
 * submit, keeping the text when the send did not happen.
 */
export async function sendComposer(input: ComposerSendInput): Promise<ComposerInterceptResult | undefined> {
  if (!input.live) {
    input.tell("Replaying: go back to live before sending", "warning")
    return { handled: true, retain: true }
  }
  const destination = composerDestination(input.text, input.rows)
  if (destination.kind === "root") return undefined
  if (destination.kind === "empty") {
    input.tell(`Add an instruction after @${destination.row.label}`, "warning")
    return { handled: true, retain: true }
  }
  if (destination.kind === "refused") {
    input.tell(`${destination.row.label} ${destination.reason}. Your text is still here`, "warning")
    return { handled: true, retain: true }
  }
  // Address the branch by session ID: the agent name alone reaches every
  // same-named sibling, and this label picked one row.
  const result = await input.mesh.steer({
    parentSessionID: input.root,
    targetAgent: destination.row.agent,
    targetSessionID: destination.row.sessionID,
    instruction: destination.instruction,
  })
  if (result.ok) {
    input.tell(`Steered ${destination.row.label}`, "success")
    return { handled: true, retain: false }
  }
  input.tell(result.message ?? `Could not steer ${destination.row.label}`, "warning")
  return { handled: true, retain: true }
}

/**
 * Registers the tab's three composer seams and returns the cleanup. Call it
 * from the component body and pass the return value to onCleanup, so leaving
 * the tab restores Chat's composer exactly as it was.
 */
export function registerComposerRouting(input: {
  readonly context: Context
  readonly rows: () => readonly RosterRow[]
  readonly root: () => string
  readonly mesh: MeshLive
  readonly live: () => boolean
  readonly tell: (message: string, variant?: "info" | "success" | "warning" | "error") => void
  readonly glyph?: (row: RosterRow, index: number) => string
}): () => void {
  const hooks = input.context.ui.composer
  const releases = [
    hooks.intercept((text) =>
      sendComposer({
        text,
        rows: input.rows(),
        root: input.root(),
        mesh: input.mesh,
        live: input.live(),
        tell: input.tell,
      }),
    ),
    hooks.suggest((query) => composerSuggestions(input.rows(), query, { glyph: input.glyph })),
    hooks.route((text) => composerRouteLabel(text, input.rows(), input.live())),
  ]
  return () => {
    for (const release of releases) release()
  }
}
