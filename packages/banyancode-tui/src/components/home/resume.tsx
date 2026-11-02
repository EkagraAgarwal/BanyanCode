import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { HERO_COMPACT_MIN, HERO_FULL_MIN, HERO_PLAIN_MIN_HEIGHT } from "./hero"
import { fadeIn, type Growth } from "./growth"
import { WORDMARK_HEIGHT } from "./wordmark"
import { palette } from "../../theme"

/** Header plus the three most recent sessions. */
export const RESUME_ROWS = 4
export const RESUME_LIMIT = 3
/** hero.tsx draws 29 rows at the full tier. */
const HERO_FULL_ROWS = 29
/** Home renders the prompt without its own footer row: border, padding, input, padding, metadata, border. */
const HOME_PROMPT_ROWS = 6
/** Home adds a row above the prompt and above this block, but only when the terminal is tall enough. */
const HOME_GAP_ROWS = 2
const HOME_ROOMY_MIN_HEIGHT = 43
const HOME_FOOTER_ROWS = 1
/** The fade-in window, in seconds since the home growth started. */
const RESUME_FADE_START = 5.5
const RESUME_FADE_DURATION = 0.6
const ROW_ORDINAL = 2
const ROW_AGE = 4
const SLOTS = [0, 1, 2] as const

/** Compact age: `48m`, `1h`, `3d`, then weeks. */
export function relativeAge(updated: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - updated) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

/** One row of the list: no wrapping, and the title carries its own ellipsis. */
export function fitTitle(title: string, budget: number): string {
  if (title.length <= budget) return title
  return `${title.slice(0, Math.max(0, budget - 1))}…`
}

function tint(base: RGBA, overlay: RGBA, alpha: number) {
  const mix = (from: number, to: number) => Math.round((from + (to - from) * alpha) * 255)
  return RGBA.fromInts(mix(base.r, overlay.r), mix(base.g, overlay.g), mix(base.b, overlay.b))
}

/**
 * The three most recently updated root sessions for the working directory,
 * faded in once the home growth finishes.
 *
 * Its rows are reserved from the first frame whenever the terminal has room, so
 * the prompt never moves when the list resolves or a session appears. The whole
 * block is skipped when the hero, prompt and footer would not fit around it.
 *
 * The ordinals are labels, not hotkeys: digits belong to the prompt.
 */
export function Resume(props: { readonly context: Context; readonly growth: Growth }) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const [fetched, setFetched] = createSignal<readonly SessionInfo[]>([])
  let request = 0

  const location = () => props.context.location ?? props.context.data.location.default()

  const load = () => {
    const current = ++request
    return props.context.client.session
      .list({ directory: location().directory, limit: RESUME_LIMIT, order: "desc", parentID: null })
      .then(
        (response) => {
          if (request === current) setFetched(response.data)
        },
        () => {
          if (request === current) setFetched([])
        },
      )
  }
  createEffect(on(() => location().directory, () => void load()))

  // Live session info wins over the fetched snapshot so a rename lands without a refetch.
  const rows = createMemo(() =>
    fetched()
      .filter((item) => !item.parentID && item.location.directory === location().directory)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, RESUME_LIMIT)
      .map((item) => props.context.data.session.get(item.id) ?? item),
  )

  // Departure rows the hero takes at this size, mirroring hero.tsx.
  const heroRows = () => {
    const { width, height } = dimensions()
    if (width >= HERO_FULL_MIN.width && height >= HERO_FULL_MIN.height) return HERO_FULL_ROWS
    if (width >= HERO_COMPACT_MIN.width && height >= HERO_COMPACT_MIN.height) return WORDMARK_HEIGHT
    if (height >= HERO_PLAIN_MIN_HEIGHT) return 1
    return 0
  }
  // Size-only so the block never appears or moves during growth or after a fetch.
  const eligible = createMemo(() => {
    const { width, height } = dimensions()
    if (width < 60) return false
    const gaps = height >= HOME_ROOMY_MIN_HEIGHT ? HOME_GAP_ROWS : 0
    return height >= heroRows() + HOME_PROMPT_ROWS + RESUME_ROWS + gaps + HOME_FOOTER_ROWS
  })

  // Same width as the prompt, so the two blocks line up.
  const rowWidth = createMemo(() =>
    Math.min(Math.max(1, dimensions().width - (dimensions().width < 44 ? 2 : 4)), 75),
  )
  const titleBudget = createMemo(() => Math.max(8, rowWidth() - ROW_ORDINAL - ROW_AGE))
  const fade = (color: RGBA) =>
    tint(
      props.context.theme.background.base,
      color,
      fadeIn(props.growth.elapsed(), RESUME_FADE_START, RESUME_FADE_DURATION),
    )
  const now = () => Date.now()

  return (
    <Show when={eligible()}>
      <box width="100%" maxWidth={75} height={RESUME_ROWS} flexDirection="column" flexShrink={0}>
        <box height={1} flexShrink={0}>
          <Show when={rows().length > 0}>
            <text fg={fade(props.context.theme.growth.wood)} attributes={TextAttributes.BOLD}>
              RESUME
            </text>
          </Show>
        </box>
        <For each={SLOTS}>
          {(slot) => {
            const session = createMemo(() => rows()[slot])
            const [hovered, setHovered] = createSignal(false)
            return (
              <Show when={session()} fallback={<box height={1} flexShrink={0} />}>
                {(item) => (
                  <box
                    height={1}
                    flexShrink={0}
                    flexDirection="row"
                    alignItems="center"
                    backgroundColor={hovered() ? theme().surfaceHigh : undefined}
                    onMouseOver={() => setHovered(true)}
                    onMouseOut={() => setHovered(false)}
                    onMouseUp={() =>
                      props.context.ui.router.navigate({ type: "session", sessionID: item().id })
                    }
                  >
                    <text width={ROW_ORDINAL} fg={fade(props.context.theme.growth.leaf)} wrapMode="none">
                      {slot + 1}
                    </text>
                    <text fg={fade(theme().muted)} wrapMode="none" flexShrink={1} minWidth={0}>
                      {fitTitle(item().title ?? "", titleBudget())}
                    </text>
                    <box flexGrow={1} />
                    <text width={ROW_AGE} fg={fade(theme().faint)} textAlign="right" wrapMode="none">
                      {relativeAge(item().time.updated, now())}
                    </text>
                  </box>
                )}
              </Show>
            )
          }}
        </For>
      </box>
    </Show>
  )
}
