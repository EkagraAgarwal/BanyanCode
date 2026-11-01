import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { bar } from "../../data/format"
import type { CodegraphLive } from "../../data/live"
import { palette } from "../../theme"

export const STUCK_THRESHOLD_MS = 30_000
export const COMPLETED_HIDE_MS = 5_000
export const FAILED_HIDE_MS = 12_000

type BuildStatus = "idle" | "running" | "completed" | "failed" | "cancelled" | "stuck"

/** Ported from v1 `deriveBuildStatus`: a running build with no progress for 30s is stuck. */
export function deriveBuildStatus(
  state: { readonly status: "idle" | "running" | "completed" | "failed" | "cancelled"; readonly lastProgressAt?: number | undefined },
  now: number,
): BuildStatus {
  if (state.status === "running" && state.lastProgressAt !== undefined && now - state.lastProgressAt > STUCK_THRESHOLD_MS) {
    return "stuck"
  }
  return state.status
}

function labelFor(status: BuildStatus): string {
  if (status === "running") return "Running"
  if (status === "completed") return "Completed"
  if (status === "failed") return "Failed"
  if (status === "cancelled") return "Cancelled"
  if (status === "stuck") return "Stuck"
  return "Idle"
}

/**
 * Codegraph build progress. v1 mounted this as a floating overlay
 * (`component/codegraph-progress.tsx`); v2 mounts it at `session.composer.top`
 * so it never covers the prompt.
 */
export function CodegraphProgress(props: {
  readonly context: Context
  readonly codegraph: CodegraphLive
  readonly idleHint?: boolean
}) {
  const theme = () => palette(props.context.theme)
  const [now, setNow] = createSignal(Date.now())
  const [hidden, setHidden] = createSignal(false)

  // Tick only while a build can actually change (running/stuck detection).
  // An idle or hidden progress widget must cost nothing.
  let timer: ReturnType<typeof setInterval> | undefined
  const stopTimer = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
  createEffect(
    on(
      () => props.codegraph.build()?.status,
      (status) => {
        stopTimer()
        if (status !== "running") return
        setNow(Date.now())
        timer = setInterval(() => setNow(Date.now()), 1000)
      },
      { defer: false },
    ),
  )
  onCleanup(stopTimer)

  const build = createMemo(() => props.codegraph.build())
  const status = createMemo(() => {
    const state = build()
    return state ? deriveBuildStatus(state, now()) : "idle"
  })

  createEffect(
    on(status, (value) => {
      if (value === "running" || value === "stuck") {
        setHidden(false)
        return
      }
      if (value === "completed" || value === "cancelled") {
        setHidden(false)
        const handle = setTimeout(() => setHidden(true), COMPLETED_HIDE_MS)
        onCleanup(() => clearTimeout(handle))
        return
      }
      if (value === "failed") {
        setHidden(false)
        const handle = setTimeout(() => setHidden(true), FAILED_HIDE_MS)
        onCleanup(() => clearTimeout(handle))
        return
      }
      setHidden(false)
    }),
  )

  const visible = createMemo(() => {
    if (status() !== "idle") return !hidden()
    if (props.idleHint !== true) return false
    return props.codegraph.readiness()?.reason === "missing" || props.codegraph.readiness() === undefined
  })

  const idle = createMemo(() => status() === "idle")
  const lastUpdateSeconds = createMemo(() => {
    const state = build()
    if (!state?.lastProgressAt) return 0
    return Math.max(0, Math.floor((now() - state.lastProgressAt) / 1000))
  })

  return (
    <Show when={visible()}>
      <box
        width="100%"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={0}
        paddingBottom={0}
        flexDirection="column"
        flexShrink={0}
      >
        <Show
          when={!idle()}
          fallback={
            <box flexDirection="row" gap={1} alignItems="center">
              <text fg={theme().muted}>∅</text>
              <text fg={theme().text}>Codegraph not built</text>
              <text fg={theme().muted}>· run /codegraph-build</text>
            </box>
          }
        >
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={status() === "failed" ? theme().error : status() === "stuck" ? theme().warning : theme().text}>
              <b>Codegraph Indexing — {labelFor(status())}</b>
            </text>
            <Show when={!props.codegraph.availability || props.codegraph.availability() === "available"}>
              <text fg={theme().muted}>{`${bar(build()?.done ?? 0, build()?.total ?? 0)} ${build()?.done ?? 0}/${build()?.total ?? 0}`}</text>
            </Show>
            <Show when={status() === "running"}>
              <text fg={theme().muted}>· /codegraph-cancel to stop</text>
            </Show>
            <Show when={status() === "stuck"}>
              <text fg={theme().warning}>· build appears stuck ({lastUpdateSeconds()}s since progress)</text>
            </Show>
          </box>
          <Show when={status() === "running" && build()?.currentFile}>
            {(file) => <text fg={theme().muted}>Indexing: {file()}</text>}
          </Show>
          <Show when={status() === "stuck" && build()?.lastCompletedFile}>
            {(file) => <text fg={theme().muted}>Last completed: {file()}</text>}
          </Show>
          <Show when={status() === "completed" && build()?.result}>
            {(result) => (
              <text fg={theme().success}>
                {`✓ ${result().indexed} indexed, ${result().skipped} skipped (${result().duration_ms}ms)`}
              </text>
            )}
          </Show>
          <Show when={build()?.error}>
            {(error) => <text fg={theme().error}>{error()}</text>}
          </Show>
          <Show when={build()?.dbPath}>
            {(path) => <text fg={theme().muted}>Index → {path()}</text>}
          </Show>
        </Show>
      </box>
    </Show>
  )
}
