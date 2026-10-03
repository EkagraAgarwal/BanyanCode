/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export const SPINNER_INTERVAL_MS = 100

export type SpinnerSessionStatus = { type?: string }

// One shared frame clock for every mounted spinner: the first mounted
// spinner starts the interval, the last unmount clears it. Per-spinner
// intervals redrew the whole screen ~10x/s each, so N parallel tools meant
// N timers and a crashed turn left them redrawing forever.
const [spinnerTick, setSpinnerTick] = createSignal(0)
let spinnersMounted = 0
let spinnerClock: ReturnType<typeof setInterval> | undefined

function subscribeSpinnerClock() {
  spinnersMounted += 1
  if (spinnerClock === undefined) {
    spinnerClock = setInterval(() => {
      setSpinnerTick((tick) => tick + 1)
    }, SPINNER_INTERVAL_MS)
  }
  onCleanup(() => {
    spinnersMounted -= 1
    if (spinnersMounted <= 0) {
      spinnersMounted = 0
      if (spinnerClock !== undefined) clearInterval(spinnerClock)
      spinnerClock = undefined
    }
  })
}

// Test introspection (mirrors the exported-threshold precedent in
// tab-agent-tree): how many spinners hold the shared clock and whether the
// interval is running.
export function spinnerClockState(): { mounted: number; running: boolean } {
  return { mounted: spinnersMounted, running: spinnerClock !== undefined }
}
// Anything but an explicit idle counts as busy. Unknown (undefined) counts
// as busy so a spinner never hides during the bootstrap window before the
// first session.status event lands.
export function sessionAllowsSpinner(status?: SpinnerSessionStatus): boolean {
  return status?.type !== "idle"
}

// Central gate: a part-level `running` alone must not animate. Dangling
// parts from crashed/aborted turns stay `running` forever, so the session
// being busy and the owning message being open are both required.
export function shouldSpinSpinner(input: {
  partRunning: boolean
  messageCompleted?: boolean
  sessionStatus?: SpinnerSessionStatus
}): boolean {
  if (!input.partRunning) return false
  if (input.messageCompleted) return false
  return sessionAllowsSpinner(input.sessionStatus)
}

export function useSpinnerTick(): () => number {
  subscribeSpinnerClock()
  return spinnerTick
}

export function SpinnerFrame(props: { color?: RGBA }) {
  const { theme } = useTheme()
  const tick = useSpinnerTick()
  const glyph = () => SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]
  return <text fg={props.color ?? theme.textMuted}>{glyph()}</text>
}

export function Spinner(props: { children?: JSX.Element; color?: RGBA; active?: boolean }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  const active = () => props.active ?? true
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <Show when={active()} fallback={<text fg={color()}>◇ {props.children}</text>}>
        <box flexDirection="row" gap={1}>
          <SpinnerFrame color={color()} />
          <Show when={props.children}>
            <text fg={color()}>{props.children}</text>
          </Show>
        </box>
      </Show>
    </Show>
  )
}
